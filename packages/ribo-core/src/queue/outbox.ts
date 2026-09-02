import type { MangoQuery, RxAttachmentCreator, RxDocument, RxStorage } from "rxdb";
import type { Observable } from "rxjs";
import { map } from "rxjs";

import type { Recording } from "../recording.js";
import { baseRecordingSchema } from "../recording.js";
import type { Transcript } from "../transcript.js";
import { isChunkOf } from "./chunk-names.js";
import {
  openOutboxDatabase,
  type OutboxCollection,
  type OutboxDatabase,
  type SessionCollection,
} from "./database.js";
import { commitRegion, handoffTranscript, writeTail } from "./preview.js";
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
  recording: Recording;
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

/**
 * The document as handed to `insert`, with the audio attached **inline**.
 *
 * RxDB 17 accepts an `_attachments` array on an insert and folds it into the
 * same storage write as the document (`rx-collection.ts`: `bulkInsert`
 * normalizes inline attachments *before* the single `storageInstance.bulkWrite`
 * call). The field is not part of `OutboxDocument` — it is RxDB metadata, and
 * the document schema is a `strictObject` — so the insert payload gets its own
 * type rather than a cast at the call site.
 */
type OutboxInsert = OutboxDocument & { _attachments: RxAttachmentCreator[] };

export interface OpenOutboxOptions {
  /** Storage database name. Defaults to `ribo-outbox`. */
  name?: string;
  /**
   * The RxDB storage engine to persist to. Defaults to `getRxStorageDexie()`
   * (IndexedDB), so every existing caller is unchanged.
   *
   * This is the one seam a host needs to choose where the outbox lives without
   * touching the {@link Outbox} class or its durability logic: memory
   * (`getRxStorageMemory` from `rxdb/plugins/storage-memory`) for fast,
   * browser-free tests, Dexie for the browser field app, and a
   * React-Native/SQLite `RxStorage` the day it leaves the browser. If you also
   * call {@link removeOutboxDatabase}, pass it the *same* storage — RxDB removes
   * through the engine's own layout.
   *
   * This is deliberately the *Level 1* seam: injecting an `RxStorage` under a
   * still-concrete `Outbox`. Extracting a formal `Outbox` interface plus a
   * storage conformance-test kit ("Level 2") is deferred until a genuinely
   * non-RxDB backend is real — doing it now would be a contract with one
   * implementation.
   */
  storage?: RxStorage<unknown, unknown>;
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable id source. Defaults to `crypto.randomUUID`. */
  createId?: () => string;
  /** Injectable idempotency-key source. Defaults to `crypto.randomUUID`. */
  createIdempotencyKey?: () => string;
}

/** Open (or create) the durable outbox. */
export async function openOutbox(options: OpenOutboxOptions = {}): Promise<Outbox> {
  const database = await openOutboxDatabase(options.name, options.storage);
  return new Outbox(database, options);
}

/**
 * The durable outbox: an RxDB collection plus the small set of operations the
 * relay and the UI need.
 *
 * Deliberately *not* the state machine. This class knows how to store an item,
 * how to hand back the next one in order, and nothing about what
 * `transcribing` means — that lives in `relay.ts`. Keeping the split lets the
 * durability tests exercise storage with no steps configured at all.
 */
export class Outbox {
  readonly #database: OutboxDatabase;
  readonly #collection: OutboxCollection;
  readonly #sessionsCollection: SessionCollection;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #createIdempotencyKey: () => string;

  /**
   * Serializes seq allocation. Reading the current maximum and inserting the
   * successor is a read-modify-write, and two concurrent `enqueue` calls would
   * otherwise both read the same maximum and both claim the same seq — silently
   * breaking the ordering guarantee the relay is built on.
   */
  #enqueueChain: Promise<unknown> = Promise.resolve();

  constructor(database: OutboxDatabase, options: OpenOutboxOptions = {}) {
    this.#database = database;
    this.#collection = database.collections.outbox;
    this.#sessionsCollection = database.collections.sessions;
    this.#now = options.now ?? (() => Date.now());
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.#createIdempotencyKey = options.createIdempotencyKey ?? (() => crypto.randomUUID());
  }

  /** The underlying RxDB database, for hosts that want to add their own collections. */
  get database(): OutboxDatabase {
    return this.#database;
  }

  get closed(): boolean {
    return this.#database.closed;
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
    return this.#collection
      .find(mangoQuery(query))
      .$.pipe(map((docs) => docs.map((doc) => this.#toItem(doc))));
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
    return this.#serialized(async () => {
      const document = outboxDocumentSchema.parse({
        id: this.#createId(),
        seq: (await this.#highestSeq()) + 1,
        status: "queued",
        sessionId,
        attempts: 0,
        // Immediately eligible: a fresh recording has no backoff to serve.
        nextAttemptAt: this.#nowIso(),
        enqueuedAt: this.#nowIso(),
        recording: baseRecordingSchema.parse(recording),
      } satisfies OutboxDocument);

      const insert: OutboxInsert = {
        ...document,
        _attachments: [
          {
            id: AUDIO_ATTACHMENT_ID,
            // A `Blob` from `MediaRecorder` always carries a type; a hand-built
            // one might not, and RxDB requires a non-empty content type.
            type: audio.type || "application/octet-stream",
            data: audio,
          },
        ],
      };
      const doc = await this.#collection.insert(insert);
      // Projected from the inserted document, so the returned item carries the
      // same `audioReady` / `audioBytes` a subscriber sees for it.
      return this.#toItem(doc);
    });
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
    return this.#serialized(async () => {
      const document = outboxDocumentSchema.parse({
        id: this.#createId(),
        seq: (await this.#highestSeq()) + 1,
        status: "recording",
        sessionId,
        attempts: 0,
        nextAttemptAt: this.#nowIso(),
        enqueuedAt: this.#nowIso(),
        recording: baseRecordingSchema.parse(recording),
        capture: { sourceId },
      } satisfies OutboxDocument);
      const doc = await this.#collection.insert(document);
      return this.#toItem(doc);
    });
  }

  /**
   * Write one chunk attachment. The `name` is a `chunkName(sourceId, …)` string;
   * the caller is responsible for naming and ordering.
   */
  async appendChunk(id: string, name: string, blob: Blob): Promise<void> {
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item ${id}`);
    await doc.putAttachment({
      id: name,
      type: blob.type || "application/octet-stream",
      data: blob,
    });
  }

  /**
   * Read all chunk attachments for `id`'s `capture.sourceId`, in name order, and
   * concatenate them into one `Blob`. Used at commit and at recovery.
   */
  async mergeChunks(id: string): Promise<Blob> {
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item ${id}`);
    const sourceId = doc.capture?.sourceId;
    if (!sourceId) throw new Error(`outbox: item ${id} has no capture.sourceId`);
    const chunks = doc
      .allAttachments()
      .filter((a) => isChunkOf(a.id, sourceId))
      .sort((a, b) => a.id.localeCompare(b.id));
    const parts: Blob[] = [];
    for (const chunk of chunks) {
      parts.push(await chunk.getData());
    }
    return new Blob(parts, { type: doc.recording.mimeType });
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
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item ${id}`);
    const sourceId = doc.capture?.sourceId;
    if (!sourceId) throw new Error(`outbox: item ${id} has no capture.sourceId`);
    const chunks = doc
      .allAttachments()
      .filter((a) => isChunkOf(a.id, sourceId))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (chunks.length <= 1) return null;
    const parts: Blob[] = [];
    for (let i = 0; i < chunks.length - 1; i++) {
      parts.push(await chunks[i]!.getData());
    }
    return new Blob(parts, { type: doc.recording.mimeType });
  }

  /**
   * Commit a durable recording: write the canonical `AUDIO_ATTACHMENT_ID`
   * attachment, transition `recording → queued` with the decoded `durationMs`,
   * and delete the chunk attachments. The caller has already merge-verified the
   * audio; this method writes what it is given.
   */
  async commitRecording(id: string, audio: Blob, durationMs: number): Promise<OutboxItem> {
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item ${id}`);
    // 1. Write the canonical audio.
    await doc.putAttachment({
      id: AUDIO_ATTACHMENT_ID,
      type: audio.type || "application/octet-stream",
      data: audio,
    });
    // 2. Transition recording → queued and set durationMs from the decoded audio.
    await doc.incrementalModify((data) => {
      if (data.status !== "recording")
        throw new Error(`outbox: ${id} is ${data.status}, not recording — commit refused`);
      return {
        ...data,
        status: "queued" as const,
        recording: { ...data.recording, durationMs },
      };
    });
    // 3. Sweep the chunk attachments — the canonical audio is the only audio now.
    const sourceId = doc.capture?.sourceId;
    if (sourceId) {
      for (const attachment of doc.allAttachments()) {
        if (isChunkOf(attachment.id, sourceId)) await attachment.remove();
      }
    }
    // Re-read for the projection — the attachment stubs changed.
    const settled = await this.#collection.findOne(id).exec();
    if (!settled) throw new Error(`outbox: item ${id} vanished during commit`);
    return this.#toItem(settled);
  }

  /** One item by id, or `undefined` if it is not there. */
  async get(id: string): Promise<OutboxItem | undefined> {
    const doc = await this.#collection.findOne(id).exec();
    return doc ? this.#toItem(doc) : undefined;
  }

  /** Every item, seq-ascending — or just the ones matching `query`. */
  async list(query: OutboxQuery = {}): Promise<OutboxItem[]> {
    const docs = await this.#collection.find(mangoQuery(query)).exec();
    return docs.map((doc) => this.#toItem(doc));
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
   */
  async patch(id: string, patch: OutboxPatch): Promise<OutboxItem> {
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item with id "${id}"`);
    outboxItemSchema.parse({ ...this.#toItem(doc), ...patch });
    const updated = await doc.incrementalPatch(patch);
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
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) return undefined;
    let wrote = false;
    const updated = await doc.incrementalModify((data) => {
      const [next, didWrite] = writeTail(data, text);
      wrote = didWrite;
      return next;
    });
    return wrote ? this.#toItem(updated) : undefined;
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
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) return undefined;
    let committed = false;
    const updated = await doc.incrementalModify((data) => {
      const [next, didCommit] = commitRegion(data, text);
      committed = didCommit;
      return next;
    });
    return committed ? this.#toItem(updated) : undefined;
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
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item with id "${id}"`);
    const updated = await doc.incrementalModify((data) => {
      const merged = handoffTranscript(data, transcript, patch);
      outboxDocumentSchema.parse(persistedFieldsOf(merged));
      return merged;
    });
    return this.#toItem(updated);
  }

  /** The captured audio, or `undefined` once it has been dropped. */
  async getAudio(id: string): Promise<Blob | undefined> {
    const doc = await this.#collection.findOne(id).exec();
    const attachment = doc?.getAttachment(AUDIO_ATTACHMENT_ID);
    return attachment ? await attachment.getData() : undefined;
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
    const doc = await this.#collection.findOne(id).exec();
    await doc?.getAttachment(AUDIO_ATTACHMENT_ID)?.remove();
  }

  /** Delete an item and its attachment. */
  async remove(id: string): Promise<void> {
    const doc = await this.#collection.findOne(id).exec();
    await doc?.remove();
  }

  /**
   * Delete many items and their attachments in one storage write.
   *
   * Ids that are not in the queue are skipped, so this is idempotent — calling
   * it twice with the same list is not an error.
   *
   * Returns how many items were actually deleted.
   */
  async removeMany(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.#collection.bulkRemove([...ids]);
    // `error` collects per-document write failures (a 404 for an id that was
    // already gone, most commonly). Reporting the successes rather than the
    // input length keeps the return value honest about what happened.
    return result.success.length;
  }

  /**
   * Empty the queue — or the part of it matching `query`.
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
    return await this.removeMany(items.map((item) => item.id));
  }

  /** Close the database. The instance is unusable afterwards. */
  async close(): Promise<void> {
    await this.#database.close();
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
    const doc = await this.#sessionsCollection.insert(
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
    return this.#toSession(doc);
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
    const doc = await this.#sessionsCollection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no session with id "${id}"`);
    const updated = await doc.incrementalModify((current) => {
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
      sessionDocumentSchema.parse(persistedSessionFieldsOf(merged));
      return merged;
    });
    return this.#toSession(updated);
  }

  /** One session by id, or `undefined` if it is not there. */
  async getSession(id: string): Promise<SessionItem | undefined> {
    const doc = await this.#sessionsCollection.findOne(id).exec();
    return doc ? this.#toSession(doc) : undefined;
  }

  /** Every session, `openedAt`-ascending — or just the ones matching `query`. */
  async listSessions(query: SessionQuery = {}): Promise<SessionItem[]> {
    const docs = await this.#sessionsCollection.find(sessionMangoQuery(query)).exec();
    return docs.map((doc) => this.#toSession(doc));
  }

  /**
   * Sessions as a live stream, `openedAt`-ascending. Same shape as
   * {@link watch} for recordings: RxDB pushes a new array on every write,
   * including writes from another tab.
   */
  watchSessions(query: SessionQuery = {}): Observable<SessionItem[]> {
    return this.#sessionsCollection
      .find(sessionMangoQuery(query))
      .$.pipe(map((docs) => docs.map((doc) => this.#toSession(doc))));
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
    const doc = await this.#sessionsCollection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no session with id "${id}"`);
    sessionItemSchema.parse({ ...this.#toSession(doc), ...patch });
    const updated = await doc.incrementalPatch(patch);
    return this.#toSession(updated);
  }

  /**
   * Record what a human decided about a parked session, and move it forward.
   *
   * The only way out of `awaiting-review` on a session, and it **only** works
   * from `awaiting-review`. Same guard, same `incrementalModify` pattern, and
   * the same ABA-race analysis as {@link submitReview} on recordings — see
   * that method's doc comment for the mechanism; it applies here unchanged.
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
    const doc = await this.#sessionsCollection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no session with id "${id}"`);

    const patch: SessionPatch =
      parsed.status === "discarded"
        ? { reviewOutcome: parsed, status: "done" }
        : { reviewOutcome: parsed, status: "writing", attempts: 0 };

    const updated = await doc.incrementalModify((current) => {
      if (current.status !== "awaiting-review") {
        throw new Error(
          `outbox: session ${id} is "${current.status}", not "awaiting-review", so a review ` +
            "cannot be submitted for it. Another tab or an earlier submission has already moved it on.",
        );
      }
      const merged = { ...current, ...patch };
      sessionDocumentSchema.parse(persistedSessionFieldsOf(merged));
      return merged;
    });
    return this.#toSession(updated);
  }

  /**
   * Move a `done` or `dead` session back to `awaiting-review`, so a human can
   * correct whatever went wrong and resubmit. "Amend" is the user-facing word;
   * the API keeps the one method because the body is the same for both source
   * statuses.
   *
   * **`done` and `dead` are the only legal source statuses.** Any active
   * status would race the relay. The guard's reasoning for `done` was that
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
   */
  async reopenSessionForReview(id: string): Promise<SessionItem> {
    const doc = await this.#sessionsCollection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no session with id "${id}"`);

    const updated = await doc.incrementalModify((current) => {
      if (current.status !== "dead" && current.status !== "done") {
        throw new Error(
          `outbox: session ${id} is "${current.status}", not "done" or "dead", so it cannot ` +
            "be reopened for review. Only a finished session may be re-parked this way.",
        );
      }
      // "Already written" and "gave up" are different things to explain, and
      // the caller is looking at one of them. A `done` session told it "never
      // reached extraction" is being described as the opposite of what it is.
      const because =
        current.status === "done"
          ? "this session completed its write, so amending it means reviewing that extraction again"
          : "this session gave up before completing, so reopening it means reviewing what it had";

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

      const merged = { ...current, status: "awaiting-review" as const, attempts: 0 };
      delete merged.reviewOutcome;
      sessionDocumentSchema.parse(persistedSessionFieldsOf(merged));
      return merged;
    });
    return this.#toSession(updated);
  }

  async #highestSeq(): Promise<number> {
    const docs = await this.#collection.find({ sort: [{ seq: "desc" }], limit: 1 }).exec();
    // -1 so the first item is seq 0.
    return docs[0]?.seq ?? -1;
  }

  #nowIso(): string {
    return new Date(this.#now()).toISOString();
  }

  #toItem(doc: RxDocument<OutboxDocument>): OutboxItem {
    // `toJSON()` strips RxDB's meta fields (`_rev`, `_meta`, `_deleted`,
    // `_attachments`), so what comes back is the document we described in zod
    // and nothing else — which is why a `strictObject` parse survives here.
    //
    // Stripping `_attachments` is also exactly why the attachment facts have to
    // be read off the document separately. `getAttachment` reads the in-memory
    // stub on `doc._data`, so it does not fetch bytes — a property lookup, not I/O.
    //
    // `audioReady` reads the `AUDIO_ATTACHMENT_ID` attachment directly: with the
    // canonical pointer deleted in revision 9, there is only one canonical audio
    // attachment, and its id is the constant.
    const canonical = doc.getAttachment(AUDIO_ATTACHMENT_ID);
    const audioBytes =
      canonical?.length ??
      (doc.status === "recording" && doc.capture ? sumChunkBytes(doc, doc.capture.sourceId) : 0);
    return outboxItemSchema.parse({
      ...doc.toJSON(),
      audioReady: canonical !== null,
      audioBytes,
    });
  }

  #toSession(doc: RxDocument<SessionDocument>): SessionItem {
    // Same `toJSON()` rationale as `#toItem`: strips RxDB meta fields so the
    // `strictObject` parse survives. No attachment facts to compute — the
    // session has no attachments today.
    return sessionItemSchema.parse(doc.toJSON());
  }

  async #serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#enqueueChain.then(work, work);
    this.#enqueueChain = next.catch(() => undefined);
    return next;
  }
}

/**
 * The persisted fields of a document, with RxDB's own metadata left behind.
 *
 * `incrementalModify` does not hand its modifier a clean document: rxdb 17's
 * `modifierFromPublicToInternal` passes the internal one, which carries
 * `_attachments` (a real value), plus `_deleted`, `_meta` and `_rev`. Since
 * {@link outboxDocumentSchema} is a `strictObject`, parsing that object whole
 * fails with `unrecognized_keys` — so anything validating a document mid-modifier
 * has to project it first.
 *
 * Keyed off the schema's own `shape` rather than a hand-written list of metadata
 * names: a field added to the schema is then included automatically, and a
 * metadata field a future RxDB adds cannot leak in and defeat the strict parse.
 *
 * **It does weaken the parse in one direction, and that is the trade.**
 * `outboxDocumentSchema` is a trust boundary in *both* directions
 * (`schema.ts`: documents may have been written by an older build or another tab),
 * and a `strictObject` normally makes an unrecognized *persisted* key a hard
 * failure. Projecting first turns that into a silent omission: the stray key is
 * left out of the parse and still rides out on the returned document, so it
 * survives the write unexamined. `patch()` does not have this hole — it parses the
 * whole projection. The alternative was naming RxDB's four metadata keys here
 * instead, which fails the other way round: the day RxDB adds a fifth, every
 * `submitReview` starts throwing `unrecognized_keys` on a healthy document. A
 * strange persisted field passing through is recoverable; a method that cannot
 * write at all is not.
 */
function persistedFieldsOf(data: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(outboxDocumentSchema.shape)) {
    if (key in data) fields[key] = data[key];
  }
  return fields;
}

/**
 * {@link OutboxQuery} → RxDB's Mango query.
 *
 * One function so `list`, `watch` and `nextPending` cannot disagree about what a
 * query means — in particular about the `seq`-ascending sort, which is the
 * queue's ordering guarantee and is not optional in any of them.
 */
function mangoQuery({ status, sessionId, limit }: OutboxQuery): MangoQuery<OutboxDocument> {
  const statuses = status === undefined ? undefined : [status].flat();
  const selector: Record<string, unknown> = {};
  if (statuses) selector.status = { $in: statuses };
  if (sessionId !== undefined) selector.sessionId = sessionId;
  return {
    // A `selector` of `{}` is not the same as no selector to every RxDB query
    // planner, so the key is omitted entirely rather than left empty.
    ...(Object.keys(selector).length > 0 ? { selector } : {}),
    sort: [{ seq: "asc" }],
    ...(limit === undefined ? {} : { limit }),
  };
}

/** Total durable bytes of one capture's chunk attachments. Reads stub lengths, never bytes. */
function sumChunkBytes(doc: RxDocument<OutboxDocument>, sourceId: string): number {
  let total = 0;
  for (const attachment of doc.allAttachments()) {
    if (isChunkOf(attachment.id, sourceId)) total += attachment.length;
  }
  return total;
}

/**
 * The persisted fields of a session document, with RxDB's own metadata left
 * behind. Same rationale as {@link persistedFieldsOf}: `incrementalModify`
 * passes the internal document, which carries `_rev`, `_meta`, `_deleted` and
 * `_attachments`, and `sessionDocumentSchema` is a `strictObject` — so parsing
 * the whole thing fails with `unrecognized_keys`.
 */
function persistedSessionFieldsOf(data: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of Object.keys(sessionDocumentSchema.shape)) {
    if (key in data) fields[key] = data[key];
  }
  return fields;
}

/**
 * {@link SessionQuery} → RxDB's Mango query.
 *
 * Same pattern as {@link mangoQuery}: one function so `listSessions`,
 * `watchSessions` and `nextPendingSession` cannot disagree about what a query
 * means — in particular about the `openedAt`-ascending sort.
 */
function sessionMangoQuery({ status, ref, limit }: SessionQuery): MangoQuery<SessionDocument> {
  const statuses = status === undefined ? undefined : [status].flat();
  const selector: Record<string, unknown> = {};
  if (statuses) selector.status = { $in: statuses };
  if (ref !== undefined) selector.ref = ref;
  return {
    ...(Object.keys(selector).length > 0 ? { selector } : {}),
    sort: [{ openedAt: "asc" }],
    ...(limit === undefined ? {} : { limit }),
  };
}
