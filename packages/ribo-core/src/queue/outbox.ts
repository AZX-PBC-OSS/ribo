import type { Observable } from "rxjs";
import { map, switchMap } from "rxjs";

import { baseCaptureItemSchema } from "../capture-item.js";
import type { CaptureItem } from "../capture-item.js";
import type { Recording } from "../recording.js";
import { baseRecordingSchema } from "../recording.js";
import type { BlobDescriptor, Finders, StorageBackend, StoredDocument } from "../storage/port.js";
import type { Transcript } from "../transcript.js";
import { isChunkOf } from "./chunk-names.js";
import { commitRegion, handoffTranscript, writeTail } from "./preview.js";
import {
  createCaptureStorageScope,
  createPluginStorage,
  createPluginStorageScope,
  type CaptureStorageScope,
  type PluginStorage,
  type PluginStorageScope,
} from "./plugin-storage.js";
import { reviewOutcomeSchema, type PersistedReviewOutcome } from "../review.js";
import {
  ACTIVE_OUTBOX_STATUSES,
  AUDIO_ATTACHMENT_ID,
  outboxDocumentSchema,
  outboxItemSchema,
  type OutboxDocument,
  type OutboxItem,
  type OutboxPatch,
  type OutboxStatus,
} from "./schema.js";
import {
  ACTIVE_SESSION_STATUSES,
  sessionDocumentSchema,
  sessionItemSchema,
  type SessionDocument,
  type SessionItem,
  type SessionPatch,
  type SessionStatus,
} from "./session-schema.js";

/** What a caller hands the queue: capture metadata, the bytes, and the owning session. */
export interface EnqueueInput {
  /**
   * The capture record — audio (`Recording`) or document (`DocumentCapture`),
   * discriminated by `kind`. The union is parsed at the boundary; the key stays
   * `recording` (persisted on the v6 collection) and the input field stays
   * `audio` (the attachment id `AUDIO_ATTACHMENT_ID` is a persisted name) for
   * the same reason `Transcript.recordingId` stays: a slightly narrow name is a
   * far better trade than a migration. Both hold PDF bytes now when the kind is
   * document; the transcriber parameter is renamed to `bytes` for exactly the
   * reason these two cannot be renamed.
   */
  recording: CaptureItem;
  audio: Blob;
  /** The session this recording belongs to. */
  sessionId: string;
}

/**
 * Which items a read is interested in. Every field is optional, and the empty
 * query means "everything, seq-ascending" — the historical behaviour of
 * `list()` and `items$`.
 */
export interface OutboxQuery {
  status?: OutboxStatus | readonly OutboxStatus[];
  /** Keep only recordings belonging to this session. */
  sessionId?: string;
  /** At most this many items, still lowest-`seq` first. */
  limit?: number;
}

/** What a caller hands to open a session. */
export interface OpenSessionInput {
  /** Stable id for the session. Generated if omitted. */
  readonly id?: string;
  /** Idempotency key for the vendor write. Generated if omitted. */
  readonly idempotencyKey?: string;
  /**
   * The write destination — opaque to core in what it MEANS, but it must be an
   * object: it is stored as one, and the adapter parses it through
   * `ToolAdapter.ctxSchema` at write time. `unknown` rather than a type
   * parameter for the same reason `Recording.ctx` is: core has no business
   * knowing what a session is about.
   * Required: the session owns its destination, so the relay does not recover
   * it from a recording.
   */
  readonly ctx: unknown;
  /**
   * What the session is for — a bounded, indexed string. Required and
   * non-unique: two sessions may share one (a re-audit, a QA pass). Core never
   * parses it; the contract is that it is queryable.
   */
  readonly ref: string;
}

/**
 * Which sessions a read is interested in. Every field is optional, and the
 * empty query means "everything, `openedAt`-ascending".
 */
export interface SessionQuery {
  status?: SessionStatus | readonly SessionStatus[];
  /** Match sessions whose `ref` is exactly this string. */
  ref?: string;
  /** At most this many sessions, still lowest-`openedAt` first. */
  limit?: number;
}

export interface OpenOutboxOptions {
  /**
   * Where durable state lives — the storage backend this outbox reads and writes
   * through.
   *
   * Required, and deliberately so: there is no default, because every default
   * would be wrong somewhere. `createMemoryBackend` for tests and development;
   * `openRxdbBackend` from `@azx/ribo-storage-rxdb` for a browser host, which is
   * the production path. This package no longer depends on RxDB, so it could not
   * construct that one even if it wanted to.
   */
  backend: StorageBackend;
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable id source. Defaults to `crypto.randomUUID`. */
  createId?: () => string;
  /** Injectable idempotency-key source. Defaults to `crypto.randomUUID`. */
  createIdempotencyKey?: () => string;
}

/** Open the durable outbox over a storage backend. */
export async function openOutbox(options: OpenOutboxOptions): Promise<Outbox> {
  return Promise.resolve(new Outbox(options.backend, options));
}

/**
 * The durable outbox: a storage backend plus the small set of operations the
 * relay and the UI need.
 *
 * Deliberately *not* the state machine. This class knows how to store an item,
 * how to hand back the next one in order, and nothing about what
 * `transcribing` means — that lives in `relay.ts`. Keeping the split lets the
 * durability tests exercise storage with no steps configured at all.
 *
 * It is also deliberately not *storage*. Everything below is domain logic —
 * status transitions, chunk merging, the plugin-storage sweep, review — written
 * against the port in `../storage/port.ts`. Where the bytes actually land is a
 * backend's business, and swapping one does not move a line of this file.
 */
export class Outbox {
  readonly #backend: StorageBackend;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #createIdempotencyKey: () => string;
  #closed = false;

  constructor(backend: StorageBackend, options: Omit<OpenOutboxOptions, "backend"> = {}) {
    this.#backend = backend;
    this.#now = options.now ?? (() => Date.now());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#createIdempotencyKey = options.createIdempotencyKey ?? (() => crypto.randomUUID());
  }

  /**
   * The storage backend this outbox was opened over.
   *
   * The replacement for the old `database` getter, and narrower on purpose: that
   * one handed out an `RxDatabase` and so made RxDB part of this package's
   * public surface. A host that wants its own RxDB collections gets the database
   * from `@azx/ribo-storage-rxdb`, deliberately, rather than reaching through
   * here and inheriting a dependency it never asked for.
   */
  get backend(): StorageBackend {
    return this.#backend;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Every item, seq-ascending, as a live stream. This is what a queue UI renders;
   * RxDB pushes a new array on every write, including writes from another tab.
   *
   * Unfiltered, for the callers that want the whole queue. {@link watch} is the
   * same stream with a {@link OutboxQuery} applied.
   */
  get items$(): Observable<OutboxItem[]> {
    return this.watch();
  }

  /**
   * {@link items$}, narrowed. `watch()` with no argument is exactly `items$`.
   *
   * A method rather than a parameter on the `items$` getter because `items$` is
   * already a property in every consumer that has one, and a getter cannot take
   * arguments.
   */
  watch(query: OutboxQuery = {}): Observable<OutboxItem[]> {
    return this.#backend.watch("captures", captureFinder(query)).pipe(
      // One blob lookup for the whole emission, not one per row. `audioBytes` and
      // `audioReady` are derived for every item in the result, so the per-document
      // form would be a round trip per row on every repaint of the queue.
      //
      // `switchMap` rather than `concatMap`: if a second emission arrives while
      // the first is still resolving its blobs, the first is stale and dropping it
      // is correct — a subscriber wants the current queue, not every queue there
      // has ever been.
      switchMap(async (documents) => this.#toItems(documents)),
    );
  }

  /**
   * Add a recording to the queue with its audio attached.
   *
   * The idempotency key is minted here and **only** here.
   *
   * **The document and its audio land in one storage write.** The attachment is
   * passed inline to `insert` rather than written afterwards with
   * `putAttachment`, and RxDB folds the two into a single
   * `storageInstance.bulkWrite`; the Dexie storage in turn runs that write as
   * one IndexedDB `readwrite` transaction spanning the `docs` and `attachments`
   * stores, and only emits to its change stream once that transaction has
   * committed. So there is no state in which `items$` has published this item
   * and `getAudio` would answer `undefined` — which is what the two-step
   * version guaranteed on every single capture.
   */
  async enqueue({ recording, audio, sessionId }: EnqueueInput): Promise<OutboxItem> {
    const document = outboxDocumentSchema.parse({
      id: this.#createId(),
      // Placeholder. `insertNext` assigns the real one atomically — see below.
      seq: 0,
      status: "queued",
      sessionId,
      attempts: 0,
      // Immediately eligible: a fresh recording has no backoff to serve.
      nextAttemptAt: this.#nowIso(),
      enqueuedAt: this.#nowIso(),
      recording: baseCaptureItemSchema.parse(recording),
    } satisfies OutboxDocument);

    // `insertNext` rather than read-highest-then-insert: allocating the sequence
    // is the backend's job precisely because it is the one part it can make
    // atomic across tabs and this class cannot. The promise chain that used to
    // serialise this was per-instance, so two tabs recording at once could claim
    // the same seq and silently break the ordering the relay is built on.
    const inserted = await this.#backend.insertNext("captures", "seq", document, [
      { id: AUDIO_ATTACHMENT_ID, data: audio },
    ]);

    // Projected from the inserted document, so the returned item carries the
    // same `audioReady` / `audioBytes` a subscriber sees for it.
    return this.#toItem(inserted);
  }

  /**
   * Begin a durable recording: insert a `recording` row with `capture: { sourceId }`
   * and no committed audio. Chunk attachments are written by {@link appendChunk};
   * {@link commitRecording} finalises the row into `queued`.
   */
  async beginRecording({
    recording,
    sourceId,
    sessionId,
  }: {
    recording: Recording;
    sourceId: string;
    sessionId: string;
  }): Promise<OutboxItem> {
    const document = outboxDocumentSchema.parse({
      id: this.#createId(),
      seq: 0, // Replaced atomically by `insertNext`, as in `enqueue`.
      status: "recording",
      sessionId,
      attempts: 0,
      nextAttemptAt: this.#nowIso(),
      enqueuedAt: this.#nowIso(),
      recording: baseRecordingSchema.parse(recording),
      capture: { sourceId },
    } satisfies OutboxDocument);
    const inserted = await this.#backend.insertNext("captures", "seq", document);
    return this.#toItem(inserted);
  }

  /**
   * Write one chunk attachment. The `name` is a `chunkName(sourceId, …)` string;
   * the caller is responsible for naming and ordering.
   */
  async appendChunk(id: string, name: string, blob: Blob): Promise<void> {
    // `putBlob` refuses an unknown document, so the explicit existence check is
    // about the error message rather than the guard.
    if (!(await this.#backend.get("captures", id))) throw new Error(`outbox: no item ${id}`);
    await this.#backend.putBlob("captures", id, name, blob);
  }

  /**
   * Read all chunk attachments for `id`'s `capture.sourceId`, in name order, and
   * concatenate them into one `Blob`. Used at commit and at recovery.
   */
  async mergeChunks(id: string): Promise<Blob> {
    const { document, chunks } = await this.#chunksOf(id);
    const parts: Blob[] = [];
    for (const chunk of chunks) {
      const data = await this.#backend.getBlob("captures", id, chunk.id);
      if (data) parts.push(data);
    }
    return new Blob(parts, { type: document.recording.mimeType });
  }

  /**
   * Merge chunk attachments excluding the last one, for recovery's
   * drop-and-retry. Returns `null` if there is only one chunk (nothing to drop).
   *
   * A truncated tail is the one case where dropping bytes can turn an undecodable
   * merge into a decodable one — the final chunk may be a half-written container
   * that the decoder chokes on. Recovery tries the full merge first; only on
   * failure does it reach for this method.
   */
  async mergeChunksExcludingLast(id: string): Promise<Blob | null> {
    const { document, chunks } = await this.#chunksOf(id);
    if (chunks.length <= 1) return null;
    const parts: Blob[] = [];
    for (let i = 0; i < chunks.length - 1; i++) {
      const data = await this.#backend.getBlob("captures", id, chunks[i]!.id);
      if (data) parts.push(data);
    }
    return new Blob(parts, { type: document.recording.mimeType });
  }

  /**
   * Commit a durable recording: write the canonical `AUDIO_ATTACHMENT_ID`
   * attachment, transition `recording → queued` with the decoded `durationMs`,
   * and delete the chunk attachments. The caller has already merge-verified the
   * audio; this method writes what it is given.
   */
  async commitRecording(id: string, audio: Blob, durationMs: number): Promise<OutboxItem> {
    const existing = await this.#backend.get("captures", id);
    if (!existing) throw new Error(`outbox: no item ${id}`);
    // 1. Write the canonical audio.
    await this.#backend.putBlob("captures", id, AUDIO_ATTACHMENT_ID, audio);
    // 2. Transition recording → queued and set durationMs from the decoded audio.
    await this.#modifyCapture(id, (data) => {
      if (data.status !== "recording")
        throw new Error(`outbox: ${id} is ${data.status}, not recording — commit refused`);
      // Runtime guard: commitRecording is the durable microphone path and only
      // makes sense for audio. The `{ ...data.recording, durationMs }` spread
      // below produces no typecheck error (the contextual type inside
      // incrementalModify does not trigger excess-property checking) while
      // writing a document row carrying a bogus `durationMs` that the strict
      // schema then rejects on the next read. Silent persistence corruption on
      // a path the compiler blessed — so the guard is runtime, not type-level.
      if (data.recording.kind !== "audio") {
        throw new Error(
          `outbox: ${id} is a "${data.recording.kind}" capture, not audio — ` +
            "commitRecording is the microphone path; use enqueue for documents",
        );
      }
      return {
        ...data,
        status: "queued" as const,
        recording: { ...data.recording, durationMs },
      };
    });
    // 3. Sweep the chunk blobs — the canonical audio is the only audio now.
    const sourceId = (existing as unknown as OutboxDocument).capture?.sourceId;
    if (sourceId) {
      for (const blob of await this.#backend.listBlobs("captures", id)) {
        if (isChunkOf(blob.id, sourceId)) await this.#backend.removeBlob("captures", id, blob.id);
      }
    }
    // Re-read for the projection — the blob set changed.
    const settled = await this.#backend.get("captures", id);
    if (!settled) throw new Error(`outbox: item ${id} vanished during commit`);
    return this.#toItem(settled);
  }

  /** One item by id, or `undefined` if it is not there. */
  async get(id: string): Promise<OutboxItem | undefined> {
    const document = await this.#backend.get("captures", id);
    return document ? await this.#toItem(document) : undefined;
  }

  /** Every item, seq-ascending — or just the ones matching `query`. */
  async list(query: OutboxQuery = {}): Promise<OutboxItem[]> {
    return this.#toItems(await this.#backend.find("captures", captureFinder(query)));
  }

  /**
   * The lowest-`seq` item the relay has not finished with — regardless of whether
   * its backoff has elapsed. Readiness is the relay's decision, not storage's,
   * because "the head of the queue is not ready yet" and "there is nothing to do"
   * are different situations and only the relay can tell them apart.
   */
  async nextPending(): Promise<OutboxItem | undefined> {
    const [item] = await this.list({ status: ACTIVE_OUTBOX_STATUSES, limit: 1 });
    return item;
  }

  /**
   * Apply a partial update. The merged document is validated **before** the write,
   * so a bad status or a malformed timestamp fails here rather than at the next
   * reload, where the failure would look like data corruption.
   *
   * When the patch sets `status` to `"discarded"`, every plugin-storage entry
   * for this capture is swept — the capture's words should not return through a
   * later extraction, and the plugin state that was only meaningful alongside
   * those words should not linger either.
   */
  async patch(id: string, patch: OutboxPatch): Promise<OutboxItem> {
    const existing = await this.#backend.get("captures", id);
    if (!existing) throw new Error(`outbox: no item with id "${id}"`);
    outboxItemSchema.parse({ ...(await this.#toItem(existing)), ...patch });
    const updated = await this.#modifyCapture(id, (data) => ({ ...data, ...patch }));
    if (patch.status === "discarded") {
      await this.#sweepPluginStorage([id]);
    }
    return this.#toItem(updated);
  }

  /**
   * Write the current region's provisional tail — replacing whatever tail was
   * there, never appending.
   *
   * Refuses silently — returns `undefined`, does not throw — when `status !==
   * "recording"` or `transcript` already exists. A late live reply is expected
   * traffic, not an error anyone can act on: the recording may have been
   * committed and transcribed while the reply was in flight.
   *
   * **Silent to the caller, not in storage.** RxDB 17.4.0 has no no-op detection in the
   * incremental-write path: the modifier returns the document unchanged, but the write still goes
   * through, committing a content-identical revision and emitting a change event to every `watch()`
   * subscriber. At the real rate — a handful of in-flight replies as a recording closes — that costs
   * nothing, which is why it is left alone. It would matter if anything ever called this in a loop.
   *
   * The refusal checks live **inside** the `incrementalModify` modifier, not
   * against a copy read beforehand. RxDB re-runs the modifier against the
   * *current* revision on write conflict, so a check made against a stale read
   * can be wrong by the time the write lands — the recording may have been
   * committed between the read and the retry.
   *
   * See {@link commitPreview} for the other half of the preview: a commit moves
   * the region's text onto `committed` and clears the tail. See
   * {@link writeTranscript} for the handoff that deletes `preview` in the same
   * revision that writes `transcript`.
   */
  async writePreviewTail(id: string, text: string): Promise<OutboxItem | undefined> {
    if (!(await this.#backend.get("captures", id))) return undefined;
    let wrote = false;
    const updated = await this.#modifyCapture(id, (data) => {
      const [next, didWrite] = writeTail(data, text);
      wrote = didWrite;
      return next;
    });
    return wrote ? await this.#toItem(updated) : undefined;
  }

  /**
   * Commit the current region: append its text to `committed` and clear the tail
   * in one storage modification.
   *
   * Refuses on the same conditions as {@link writePreviewTail} and for the same
   * reason — a late commit after the transcript has landed must not restore
   * `preview`.
   *
   * One modification, not two, because both orderings of two writes publish a
   * state a subscriber can see: the text in both `committed` and `tail`, or in
   * neither. The modifier returns a single preview object carrying the new
   * `committed` entry and no `tail`, so the two changes are one committed
   * revision.
   */
  async commitPreview(id: string, text: string): Promise<OutboxItem | undefined> {
    if (!(await this.#backend.get("captures", id))) return undefined;
    let committed = false;
    const updated = await this.#modifyCapture(id, (data) => {
      const [next, didCommit] = commitRegion(data, text);
      committed = didCommit;
      return next;
    });
    return committed ? await this.#toItem(updated) : undefined;
  }

  /**
   * Write the batch transcript and delete the preview in one storage
   * modification.
   *
   * `patch` cannot do this: it is an `incrementalPatch`, and assigning
   * `undefined` to an optional property does not delete the persisted key. This
   * method uses `incrementalModify` with `delete`, so the `preview` key is gone
   * from the stored document in the same committed revision that writes
   * `transcript`.
   *
   * One revision, not two, because both orderings of two writes publish a state
   * a subscriber can see: transcript-then-delete shows final text beside stale
   * provisional text; delete-then-transcript shows a row with neither, which
   * looks like a failed transcription.
   *
   * The `patch` argument carries the status change and any other fields the
   * relay needs alongside the transcript — the same fields that were previously
   * spread into `patch(id, { transcript, status, attempts })`. `transcript`
   * itself is handled by this method and is omitted from the patch type so a
   * caller cannot accidentally pass two different copies.
   */
  async writeTranscript(
    id: string,
    transcript: Transcript,
    patch: Omit<OutboxPatch, "transcript">,
  ): Promise<OutboxItem> {
    if (!(await this.#backend.get("captures", id))) {
      throw new Error(`outbox: no item with id "${id}"`);
    }
    const updated = await this.#modifyCapture(id, (data) => {
      const merged = handoffTranscript(data, transcript, patch);
      // The backend hands back clean documents, so what the modifier sees is
      // exactly the persisted shape and the strict parse survives directly --
      // `persistedFieldsOf` used to scrub RxDB's metadata off first, and is gone.
      outboxDocumentSchema.parse(merged);
      return merged;
    });
    return this.#toItem(updated);
  }

  /** The captured audio, or `undefined` once it has been dropped. */
  async getAudio(id: string): Promise<Blob | undefined> {
    return await this.#backend.getBlob("captures", id, AUDIO_ATTACHMENT_ID);
  }

  /**
   * Delete the audio while keeping the item.
   *
   * An unconditional primitive: it drops the bytes whenever it is called, and
   * asks no questions about the item's status. **It does not decide anything.**
   *
   * *Whether* it gets called is the relay's policy, not storage's — it is
   * `createRelay({ dropAudioAfterTranscription })`, which defaults to `false`
   * and fires only after a transcription has actually succeeded
   * (`docs/implementation/09-offline-first.md` §"What goes where"). Turning it
   * on frees the iOS quota and shortens how long a recording of someone's home
   * sits on disk; it is off until transcription is real and its output trusted,
   * because the deletion is permanent and unrecoverable.
   */
  async dropAudio(id: string): Promise<void> {
    await this.#backend.removeBlob("captures", id, AUDIO_ATTACHMENT_ID);
  }

  /** Delete an item, its attachment and any plugin-storage entries for it. */
  async remove(id: string): Promise<void> {
    await this.#backend.remove("captures", id);
    await this.#sweepPluginStorage([id]);
  }

  /**
   * Delete many items, their attachments and any plugin-storage entries for
   * them, in one storage write per collection.
   *
   * Ids that are not in the queue are skipped, so this is idempotent — calling
   * it twice with the same list is not an error.
   *
   * Returns how many items were actually deleted.
   */
  async removeMany(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const removed = await this.#backend.removeMany("captures", ids);
    // Sweep after the removal so a failed bulkRemove does not orphan the
    // plugin-storage entries before the capture is gone — and so the sweep
    // runs even for ids that were already absent (their plugin-storage
    // entries may still be present if the capture was deleted by another
    // means).
    await this.#sweepPluginStorage(ids);
    // The backend reports how many documents actually went, not how many ids were
    // offered, which keeps the return value honest when some were already gone.
    return removed;
  }

  /**
   * Empty the queue — or the part of it matching `query` — and sweep
   * plugin-storage entries for every removed item.
   *
   * The "reset this device" primitive, and what a UI's *clear queue* button
   * should call. The `list()`-then-`remove()`-in-a-loop version a consumer
   * writes instead is one storage write per item and one re-emission of
   * `items$` per item, so a queue of thirty rows repaints thirty times.
   *
   * Returns how many items were deleted.
   */
  async clear(query: OutboxQuery = {}): Promise<number> {
    const items = await this.list(query);
    const deleted = await this.removeMany(items.map((item) => item.id));
    return deleted;
  }

  /** Close the database. The instance is unusable afterwards. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#backend.close();
  }

  // -----------------------------------------------------------------------
  // Plugin-scoped storage
  // -----------------------------------------------------------------------

  /**
   * A namespaced, capture-scoped key-value handle a plugin writes through.
   *
   * The handle bakes in the `captureId` (an outbox item id) and `pluginId`, so
   * two plugins cannot read or clobber each other's keys. Core sweeps every
   * entry for a capture when the capture is dropped ({@link remove},
   * {@link removeMany}, {@link clear}) or discarded ({@link patch} with
   * `status: "discarded"`), so a plugin never needs to clean up after itself —
   * and forgetting to do so can never leak.
   *
   * The storage is durable (same RxDB database as the outbox), so the two
   * halves of a plugin that run in different tabs, minutes apart, see the same
   * entries. A fresh handle over the same database reads what a prior handle
   * wrote.
   */
  pluginStorage(captureId: string, pluginId: string): PluginStorage {
    return createPluginStorage(this.#backend, captureId, pluginId);
  }

  /**
   * Storage scoped to one capture, with the plugin yet to name itself.
   *
   * This is the handle shape the relay puts in `TranscribeOptions.storage`:
   * the capture is fixed by the caller (the relay, which is draining that
   * capture) and the plugin dimension is supplied by whoever receives the
   * scope — a transcriber naming itself, conventionally by its `engine` id.
   * See {@link CaptureStorageScope} for what the handle promises.
   */
  captureStorage(captureId: string): CaptureStorageScope {
    return createCaptureStorageScope(this.#backend, captureId);
  }

  /**
   * Storage scoped to one plugin, across every capture it has entries for —
   * the **construction-time** handle a host hands an extractor, which knows
   * which plugin it is building. The plugin's transcriber half writes
   * per-capture entries through `TranscribeOptions.storage`; this scope is how
   * the extractor half reads them back, one capture at a time, with live reads
   * so a swept capture is never returned stale. See {@link PluginStorageScope}
   * for what a plugin author can and cannot rely on — in particular that the
   * scope is **not** bounded to a session.
   */
  pluginStorageScope(pluginId: string): PluginStorageScope {
    return createPluginStorageScope(this.#backend, pluginId);
  }

  /**
   * Delete every plugin-storage entry for the given capture ids.
   *
   * Called from {@link remove}, {@link removeMany}, {@link clear} and
   * {@link patch} (when the status becomes `discarded`) — the four places a
   * capture leaves the outbox. It removes entries for **every** plugin that
   * wrote against the capture, not just one, because the sweep is by
   * `captureId` alone.
   */
  async #sweepPluginStorage(captureIds: readonly string[]): Promise<void> {
    if (captureIds.length === 0) return;
    // One query for the whole batch, which is why the port's entry finder takes a
    // set of scope ids rather than one: clearing a thirty-row queue would
    // otherwise be thirty round trips on the "reset this device" path.
    const entries = await this.#backend.find("entries", {
      scopeKind: "capture",
      scopeId: captureIds,
    });
    if (entries.length === 0) return;
    await this.#backend.removeMany(
      "entries",
      entries.map((entry) => entry.id),
    );
  }

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  /**
   * Open a session: the auditor is starting a job. The session owns extraction,
   * review and write state for a set of recordings captured together.
   *
   * The id and idempotency key are generated if not supplied. `ctx` (the write
   * destination) and `ref` (what the session is for) are required — the session
   * owns its destination and its subject, and both are decided once.
   */
  async openSession(options: OpenSessionInput): Promise<SessionItem> {
    // `ctx` is typed `unknown` (required), but `z.unknown()` accepts
    // `undefined` — so the schema parse alone cannot enforce presence. A
    // host that bypasses the type system would silently open a session with
    // no write destination.
    //
    // The object check is the same guard one level up. `sessionRxSchema` types
    // `ctx` as an object, so a primitive passes both the TypeScript signature
    // (`unknown`) and the zod parse, then fails deep inside RxDB's insert
    // validator where the error names a JSON-schema path rather than the
    // mistake. Refusing it here costs nothing and says what is wrong.
    if (options.ctx === undefined || typeof options.ctx !== "object" || options.ctx === null) {
      throw new Error(
        "openSession: `ctx` must be an object — the session owns its write destination, and " +
          "the adapter parses it through `ToolAdapter.ctxSchema`.",
      );
    }
    const inserted = await this.#backend.insert(
      "sessions",
      sessionDocumentSchema.parse({
        id: options.id ?? this.#createId(),
        status: "open",
        openedAt: this.#nowIso(),
        ctx: options.ctx,
        ref: options.ref,
        attempts: 0,
        nextAttemptAt: this.#nowIso(),
        idempotencyKey: options.idempotencyKey ?? this.#createIdempotencyKey(),
      } satisfies SessionDocument),
    );
    return this.#toSession(inserted);
  }

  /**
   * Close a session: the auditor is done walking the house.
   *
   * Transitions `open → extracting` so the relay picks it up on its next drain
   * and runs session-level extraction. Sets `closedAt`.
   *
   * Refuses a session that is not `open`: closing an already-closed or
   * finished session would either double-write `closedAt` or jump the state
   * machine backwards, and either is a bug the caller should hear about.
   */
  async closeSession(id: string): Promise<SessionItem> {
    if (!(await this.#backend.get("sessions", id))) {
      throw new Error(`outbox: no session with id "${id}"`);
    }
    const updated = await this.#modifySession(id, (current) => {
      if (current.status !== "open") {
        throw new Error(
          `outbox: session ${id} is "${current.status}", not "open", so it cannot be closed.`,
        );
      }
      const merged = {
        ...current,
        status: "extracting" as const,
        closedAt: this.#nowIso(),
      };
      sessionDocumentSchema.parse(merged);
      return merged;
    });
    return this.#toSession(updated);
  }

  /** One session by id, or `undefined` if it is not there. */
  async getSession(id: string): Promise<SessionItem | undefined> {
    const document = await this.#backend.get("sessions", id);
    return document ? this.#toSession(document) : undefined;
  }

  /** Every session, `openedAt`-ascending — or just the ones matching `query`. */
  async listSessions(query: SessionQuery = {}): Promise<SessionItem[]> {
    const documents = await this.#backend.find("sessions", sessionFinder(query));
    return documents.map((document) => this.#toSession(document));
  }

  /**
   * Sessions as a live stream, `openedAt`-ascending. Same shape as
   * {@link watch} for recordings: RxDB pushes a new array on every write,
   * including writes from another tab.
   */
  watchSessions(query: SessionQuery = {}): Observable<SessionItem[]> {
    return this.#backend
      .watch("sessions", sessionFinder(query))
      .pipe(map((documents) => documents.map((document) => this.#toSession(document))));
  }

  /**
   * The lowest-`openedAt` session the relay has not finished with — regardless
   * of whether its backoff has elapsed. Readiness is the relay's decision, not
   * storage's, for the same reason as {@link nextPending} on recordings.
   */
  async nextPendingSession(): Promise<SessionItem | undefined> {
    const [session] = await this.listSessions({
      status: ACTIVE_SESSION_STATUSES,
      limit: 1,
    });
    return session;
  }

  /**
   * Apply a partial update to a session. The merged document is validated
   * **before** the write, so a bad status or a malformed field fails here
   * rather than at the next reload.
   */
  async patchSession(id: string, patch: SessionPatch): Promise<SessionItem> {
    const existing = await this.#backend.get("sessions", id);
    if (!existing) throw new Error(`outbox: no session with id "${id}"`);
    sessionItemSchema.parse({ ...this.#toSession(existing), ...patch });
    const updated = await this.#modifySession(id, (current) => ({ ...current, ...patch }));
    return this.#toSession(updated);
  }

  /**
   * Record what a human decided about a parked session, and move it forward.
   *
   * The only way out of `awaiting-review` on a session, and it **only** works
   * from `awaiting-review`. Guarded by `incrementalModify`, which RxDB re-runs
   * against the current document on write conflict, so the status check and the
   * mutation cannot be split by a second tab or a duplicate submission — the
   * same guard shape as {@link reopenSessionForReview}'s own status check below.
   *
   * - `accepted` / `edited` → `writing`, with `attempts` reset so the write
   *   gets a clean backoff budget. The relay picks the session up on its next
   *   drain and passes `outcome.fields` to the write step.
   * - `discarded` → `done`. Unlike the recording's discard (which drops audio),
   *   there is no audio on the session to drop — the recordings stay in the
   *   outbox. The session is finished; the `reviewOutcome` records why.
   */
  async submitSessionReview(id: string, outcome: PersistedReviewOutcome): Promise<SessionItem> {
    const parsed = reviewOutcomeSchema.parse(outcome);
    if (!(await this.#backend.get("sessions", id))) {
      throw new Error(`outbox: no session with id "${id}"`);
    }

    const patch: SessionPatch =
      parsed.status === "discarded"
        ? { reviewOutcome: parsed, status: "done" }
        : { reviewOutcome: parsed, status: "writing", attempts: 0 };

    const updated = await this.#modifySession(id, (current) => {
      if (current.status !== "awaiting-review") {
        throw new Error(
          `outbox: session ${id} is "${current.status}", not "awaiting-review", so a review ` +
            "cannot be submitted for it. Another tab or an earlier submission has already moved it on.",
        );
      }
      const merged = { ...current, ...patch };
      sessionDocumentSchema.parse(merged);
      return merged;
    });
    return this.#toSession(updated);
  }

  /**
   * Re-park a session at the review gate — or, when its recording set has moved,
   * at `extracting` so the relay re-extracts first. "Amend" is the user-facing
   * word; the API keeps one method because the body is the same for every source
   * status.
   *
   * **`awaiting-review`, `done` and `dead` are the legal source statuses.** Any
   * ACTIVE status is refused, because it would race the relay — that is the line,
   * not finishedness.
   *
   * `awaiting-review` is here because a recording can be added to a session that
   * is already parked: `enqueue` never looks at the session's status, and the
   * relay transcribes the new recording regardless. That left a parked draft
   * covering fewer recordings than the session holds, with no way out —
   * `closeSession` refuses anything but `open`, and this method used to refuse
   * anything but `done`/`dead`. The reviewer would open a draft with the later
   * clip missing and nothing saying so. Re-parking from `awaiting-review` with an
   * unchanged recording set is a deliberate no-op beyond resetting `attempts`. The guard's reasoning for `done` was that
   * reopening would double-write; that is sound and currently vacuous — vendor
   * egress is gated, so nothing has reached the host tool. When egress lands,
   * a second review of an already-written session must update the records it
   * created rather than create more, which requires the vendor identifier
   * `write` does not return yet (tracked as its own Asana ticket).
   *
   * Also refused: a session missing `extracted` OR missing
   * `extractedFromRecordingIds`. Both are needed to re-present the extraction
   * for review — `extracted` is the draft, and `extractedFromRecordingIds`
   * names the recordings whose transcripts produced it (the grounding source).
   * The refusal message branches on which terminal status was found, since
   * "already written" and "gave up" are different things to explain.
   *
   * Clears the stale `reviewOutcome` and resets `attempts` to `0` — the
   * reviewer changed something, so the previous cycle's exhaustion says nothing
   * about this one's chances. `lastError` is deliberately left — it explains
   * why the session needed reopening.
   *
   * ## Where it lands, and why that is a decision
   *
   * **`awaiting-review` when the recording set is unchanged** — the common case,
   * a correction to what was already captured. Re-extraction costs a model call
   * over the whole field set, and there is nothing new for it to read.
   *
   * **`extracting` when the set has moved**, so the relay re-extracts and then
   * parks the session for review. Without this, an auditor who submitted, then
   * remembered the attic and recorded a fourth clip, would reopen onto the draft
   * computed before that clip existed — reviewing a document with the attic
   * missing, and nothing anywhere saying so. `closeSession` cannot rescue them:
   * it refuses any status but `open`.
   *
   * The comparison is against every recording that is not `discarded` or `dead`,
   * **not** against the transcribed ones. `extractedFromRecordingIds` holds the
   * transcribed set, so comparing like with like would find nothing new in the
   * exact case this exists for: at the moment of reopen the fourth clip has not
   * transcribed yet. Comparing eligible-to-transcribed is safe because the relay
   * drains recordings before sessions — the clip transcribes, then extraction
   * runs over it. It is symmetric too: discarding a recording after the fact
   * also moves the set, and that extraction is stale in the other direction.
   */
  async reopenSessionForReview(id: string): Promise<SessionItem> {
    if (!(await this.#backend.get("sessions", id))) {
      throw new Error(`outbox: no session with id "${id}"`);
    }

    // Read before the modify: `incrementalModify` takes a synchronous mutator
    // and this is an outbox query. Recordings the extraction would never read
    // are excluded, so discarding one does not read as new work forever.
    const eligible = (await this.list({ sessionId: id }))
      .filter((r) => r.status !== "discarded" && r.status !== "dead")
      .map((r) => r.id)
      .sort();

    const updated = await this.#modifySession(id, (current) => {
      const cached = current.extractedFromRecordingIds ?? [];
      // An empty eligible set never counts as movement — see the note below.
      const setMoved =
        eligible.length > 0 &&
        (cached.length !== eligible.length || eligible.some((rid, i) => rid !== cached[i]));

      if (current.status !== "dead" && current.status !== "done") {
        // `awaiting-review` is accepted ONLY when the recording set has moved,
        // and that condition is load-bearing twice over.
        //
        // It is what gives a parked session a way out at all: `enqueue` never
        // looks at the session's status, so a recording can be added to a
        // session already sitting at the review gate, and the relay transcribes
        // it. That left a draft covering fewer recordings than the session
        // holds, with no move available — `closeSession` refuses anything but
        // `open`, and this method used to refuse anything but `done`/`dead`.
        //
        // And it is what keeps re-parking a NON-stale session an error rather
        // than a silent no-op. Two tabs racing to rescue the same session must
        // still settle as one winner and one refusal: the loser reads the
        // already-parked document with an unchanged set and is told so. Accepting
        // `awaiting-review` unconditionally would make both callers succeed and
        // would make an implementation that lost the race indistinguishable from
        // one that won it — see `outbox-reopen-cross-tab.browser.test.ts`.
        if (current.status !== "awaiting-review" || !setMoved) {
          throw new Error(
            `outbox: session ${id} is "${current.status}" with ` +
              `${setMoved ? "a changed" : "an unchanged"} recording set, so there is nothing to ` +
              "re-park. A finished session can be reopened; a parked one can be refreshed only " +
              "when a recording has been added or discarded since its extraction.",
          );
        }
      }
      // "Already written" and "gave up" are different things to explain, and
      // the caller is looking at one of them. A `done` session told it "never
      // reached extraction" is being described as the opposite of what it is.
      const because =
        current.status === "done"
          ? "this session completed its write, so amending it means reviewing that extraction again"
          : current.status === "dead"
            ? "this session gave up before completing, so reopening it means reviewing what it had"
            : "this session is already parked for review, so re-parking it only refreshes the draft";

      if (current.extracted === undefined) {
        throw new Error(
          `outbox: session ${id} is "${current.status}" but has no extracted data to review — ` +
            `${because}, and there is none to re-park it with.`,
        );
      }
      if (current.extractedFromRecordingIds === undefined) {
        throw new Error(
          `outbox: session ${id} is "${current.status}" and has extracted data but no recording ` +
            `ids, so the extraction's provenance is lost — ${because}, and there is nothing to ` +
            "ground the extracted values against.",
        );
      }

      // On `setMoved` above: an empty eligible set never counts as movement.
      // Every recording being gone does make the stored draft stale, but
      // re-extracting over no transcript would replace it with nothing, which is
      // worse than re-presenting what the model last said. (Whether such a
      // session should be reviewable at all is an older open question — the
      // session-entity design's §12.1 — and this does not answer it.)

      const merged = {
        ...current,
        status: setMoved ? ("extracting" as const) : ("awaiting-review" as const),
        attempts: 0,
      };
      delete merged.reviewOutcome;
      sessionDocumentSchema.parse(merged);
      return merged;
    });
    return this.#toSession(updated);
  }

  #nowIso(): string {
    return new Date(this.#now()).toISOString();
  }

  /**
   * Read a capture, modify it, write it back — with the modifier run against the
   * document as committed.
   *
   * The port re-runs the modifier on a write conflict, which is what lets the
   * guards inside these modifiers (`commitRecording`'s status check,
   * `writePreviewTail`'s refusal) be correct: a check made against a stale read
   * can be wrong by the time the write lands.
   */
  async #modifyCapture(
    id: string,
    modify: (data: OutboxDocument) => OutboxDocument,
  ): Promise<StoredDocument> {
    return await this.#backend.modify("captures", id, (current) =>
      modify(current as unknown as OutboxDocument),
    );
  }

  /** {@link Outbox.#modifyCapture} for sessions. */
  async #modifySession(
    id: string,
    modify: (data: SessionDocument) => SessionDocument,
  ): Promise<StoredDocument> {
    return await this.#backend.modify("sessions", id, (current) =>
      modify(current as unknown as SessionDocument),
    );
  }

  /**
   * A capture's chunk blobs, in name order, with the document that owns them.
   *
   * Shared by the two merge paths so they cannot disagree about which blobs count
   * as chunks or what order they go in.
   */
  async #chunksOf(
    id: string,
  ): Promise<{ document: OutboxDocument; chunks: readonly BlobDescriptor[] }> {
    const document = await this.#backend.get("captures", id);
    if (!document) throw new Error(`outbox: no item ${id}`);
    const typed = document as unknown as OutboxDocument;
    const sourceId = typed.capture?.sourceId;
    if (!sourceId) throw new Error(`outbox: item ${id} has no capture.sourceId`);
    const chunks = (await this.#backend.listBlobs("captures", id))
      .filter((blob) => isChunkOf(blob.id, sourceId))
      .sort((a, b) => a.id.localeCompare(b.id));
    return { document: typed, chunks };
  }

  /**
   * Project one stored capture into what a consumer sees.
   *
   * The derived fields cost a blob lookup now, where they used to be a property
   * read off an in-memory RxDB stub. {@link Outbox.#toItems} is the form to reach
   * for when projecting more than one — this is for the single-document paths.
   */
  async #toItem(document: StoredDocument): Promise<OutboxItem> {
    const blobs = await this.#backend.listBlobs("captures", document.id);
    return itemFrom(document, blobs);
  }

  /** {@link Outbox.#toItem} for a whole result set, with one blob lookup for all of it. */
  async #toItems(documents: readonly StoredDocument[]): Promise<OutboxItem[]> {
    const blobs = await this.#backend.listBlobsMany(
      "captures",
      documents.map((document) => document.id),
    );
    return documents.map((document) => itemFrom(document, blobs.get(document.id) ?? []));
  }

  #toSession(document: StoredDocument): SessionItem {
    // The backend hands back exactly the persisted fields, so the `strictObject`
    // parse survives with no scrubbing. Sessions carry no blobs, so unlike a
    // capture there is nothing derived to look up and this stays synchronous.
    return sessionItemSchema.parse(document);
  }
}

/**
 * Build a consumer's item from a stored document and its blob descriptors.
 *
 * `audioReady` looks for the one canonical audio blob by its constant id;
 * `audioBytes` falls back to the accumulated chunks while a recording is still
 * in flight, which is what makes a partially-captured row report real progress.
 */
function itemFrom(document: StoredDocument, blobs: readonly BlobDescriptor[]): OutboxItem {
  const typed = document as unknown as OutboxDocument;
  const canonical = blobs.find((blob) => blob.id === AUDIO_ATTACHMENT_ID);
  const audioBytes =
    canonical?.length ??
    (typed.status === "recording" && typed.capture
      ? sumChunkBytes(blobs, typed.capture.sourceId)
      : 0);
  return outboxItemSchema.parse({
    ...document,
    audioReady: canonical !== undefined,
    audioBytes,
  });
}

/**
 * {@link OutboxQuery} → the port's captures finder.
 *
 * One function so `list`, `watch` and `nextPending` cannot disagree about what a
 * query means. It is now a near-identity — the port's finder takes the same three
 * dimensions — where it used to build a Mango selector. Translating a query into
 * whatever the storage engine wants is the backend's job, not this file's, which
 * is the whole reason the finder set is closed.
 */
function captureFinder({ status, sessionId, limit }: OutboxQuery): Finders["captures"] {
  return {
    ...(status === undefined ? {} : { status: [status].flat() }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** {@link SessionQuery} → the port's sessions finder. Same rationale as {@link captureFinder}. */
function sessionFinder({ status, ref, limit }: SessionQuery): Finders["sessions"] {
  return {
    ...(status === undefined ? {} : { status: [status].flat() }),
    ...(ref === undefined ? {} : { ref }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** Total durable bytes of one capture's chunk blobs. Reads descriptor lengths, never bytes. */
function sumChunkBytes(blobs: readonly BlobDescriptor[], sourceId: string): number {
  let total = 0;
  for (const blob of blobs) {
    if (isChunkOf(blob.id, sourceId)) total += blob.length;
  }
  return total;
}
