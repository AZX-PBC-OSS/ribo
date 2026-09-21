import type { Observable } from "rxjs";
import { switchMap } from "rxjs";

import { basePayloadSchema } from "../capture/capture-item.js";
import type { CapturePayload } from "../capture/capture-item.js";
import type { Recording } from "../capture/recording.js";
import { baseRecordingSchema } from "../capture/recording.js";
import { isChunkOf } from "./chunk-names.js";
import { commitRegion, handoffTranscript, writeTail } from "./preview.js";
import {
  ACTIVE_CAPTURE_STATUSES,
  AUDIO_ATTACHMENT_ID,
  captureDocumentSchema,
  captureSchema,
  type Capture,
  type CaptureDocument,
  type CapturePatch,
  type CaptureStatus,
} from "./capture-schema.js";
import type { Transcript } from "../capture/transcript.js";
import { sweepCaptureEntries } from "./entries.js";
import type { BlobDescriptor, Finders, StorageBackend, StoredDocument } from "./port.js";
import type { StoreDeps } from "./deps.js";

/**
 * @file The capture store: every operation over the recordings and documents a
 * device has captured.
 *
 * One of the two halves the old `Outbox` class held. Splitting them is not
 * cosmetic — a recording's state machine and a session's are different machines
 * with different owners, and a file that held both was the largest in the
 * subsystem.
 */

/** What a caller hands the capture store: capture metadata, the bytes, and the owning session. */
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
  recording: CapturePayload;
  audio: Blob;
  /** The session this recording belongs to. */
  sessionId: string;
}

/**
 * Which items a read is interested in. Every field is optional, and the empty
 * query means "everything, seq-ascending" — the historical behaviour of
 * `list()` and `items$`.
 */
export interface CaptureQuery {
  status?: CaptureStatus | readonly CaptureStatus[];
  /** Keep only recordings belonging to this session. */
  sessionId?: string;
  /** At most this many items, still lowest-`seq` first. */
  limit?: number;
}

/** Every operation over captures. Reached as `storage.captures`. */
export class CaptureStore {
  readonly #backend: StorageBackend;
  readonly #now: () => number;
  readonly #createId: () => string;

  constructor(deps: StoreDeps) {
    this.#backend = deps.backend;
    this.#now = deps.now;
    this.#createId = deps.createId;
  }

  /**
   * Every item, seq-ascending, as a live stream. This is what a queue UI renders;
   * RxDB pushes a new array on every write, including writes from another tab.
   *
   * Unfiltered, for the callers that want the whole queue. {@link watch} is the
   * same stream with a {@link CaptureQuery} applied.
   */
  get items$(): Observable<Capture[]> {
    return this.watch();
  }

  /**
   * {@link items$}, narrowed. `watch()` with no argument is exactly `items$`.
   *
   * A method rather than a parameter on the `items$` getter because `items$` is
   * already a property in every consumer that has one, and a getter cannot take
   * arguments.
   */
  /**
   * **What a subscriber may and may not infer from the emissions.**
   *
   * Every emission is a complete snapshot of the query's result, and snapshots
   * arrive in order. What is *not* promised is that every intermediate state
   * gets its own emission: the projection reads blobs after the documents, and
   * a snapshot that is already stale by the time its blobs resolve is dropped in
   * favour of the newer one. Subscribers converge, and a UI repainting the queue
   * wants exactly this.
   *
   * So do not infer a *transition* from two consecutive emissions — a capture can
   * go `queued → transcribing → transcribed` and be published twice, not three
   * times. The two persisted state machines are how a host observes stage
   * changes; this stream is how it renders the current one.
   */
  watch(query: CaptureQuery = {}): Observable<Capture[]> {
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
   * **The document and its audio land in one storage write.** The audio is passed
   * to `insertNext` alongside the document rather than attached afterwards, and
   * the port's first obligation is that no subscriber can observe a capture whose
   * blob is not yet readable. So there is no state in which `items$` has published
   * this item and `getAudio` would answer `undefined` — which is what a two-step
   * version would produce on every single capture.
   *
   * How a backend honours that is its own business; the conformance kit is what
   * holds it to it.
   */
  async enqueue({ recording, audio, sessionId }: EnqueueInput): Promise<Capture> {
    const document = captureDocumentSchema.parse({
      id: this.#createId(),
      // Placeholder. `insertNext` assigns the real one atomically — see below.
      seq: 0,
      status: "queued",
      sessionId,
      attempts: 0,
      // Immediately eligible: a fresh recording has no backoff to serve.
      nextAttemptAt: this.#nowIso(),
      enqueuedAt: this.#nowIso(),
      recording: basePayloadSchema.parse(recording),
    } satisfies CaptureDocument);

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
  }): Promise<Capture> {
    const document = captureDocumentSchema.parse({
      id: this.#createId(),
      seq: 0, // Replaced atomically by `insertNext`, as in `enqueue`.
      status: "recording",
      sessionId,
      attempts: 0,
      nextAttemptAt: this.#nowIso(),
      enqueuedAt: this.#nowIso(),
      recording: baseRecordingSchema.parse(recording),
      capture: { sourceId },
    } satisfies CaptureDocument);
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
  async commitRecording(id: string, audio: Blob, durationMs: number): Promise<Capture> {
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
    const sourceId = (existing as unknown as CaptureDocument).capture?.sourceId;
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
  async get(id: string): Promise<Capture | undefined> {
    const document = await this.#backend.get("captures", id);
    return document ? await this.#toItem(document) : undefined;
  }

  /** Every item, seq-ascending — or just the ones matching `query`. */
  async list(query: CaptureQuery = {}): Promise<Capture[]> {
    return this.#toItems(await this.#backend.find("captures", captureFinder(query)));
  }

  /**
   * The lowest-`seq` item the relay has not finished with — regardless of whether
   * its backoff has elapsed. Readiness is the relay's decision, not storage's,
   * because "the head of the queue is not ready yet" and "there is nothing to do"
   * are different situations and only the relay can tell them apart.
   */
  async nextPending(): Promise<Capture | undefined> {
    const [item] = await this.list({ status: ACTIVE_CAPTURE_STATUSES, limit: 1 });
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
  async patch(id: string, patch: CapturePatch): Promise<Capture> {
    const existing = await this.#backend.get("captures", id);
    if (!existing) throw new Error(`outbox: no item with id "${id}"`);
    captureSchema.parse({ ...(await this.#toItem(existing)), ...patch });
    const updated = await this.#modifyCapture(id, (data) => ({ ...data, ...patch }));
    if (patch.status === "discarded") {
      await sweepCaptureEntries(this.#backend, [id]);
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
   * **Silent to the caller, not in storage.** The port does not promise no-op
   * detection: a modifier that returns the document unchanged still commits a
   * write and still publishes to every `watch()` subscriber. At the real rate — a
   * handful of in-flight replies as a recording closes — that costs nothing, which
   * is why it is left alone. It would matter if anything ever called this in a loop.
   *
   * The refusal checks live **inside** the modifier, not against a copy read
   * beforehand. The port's third obligation is that a modify sees the document as
   * committed, so a check made against a stale read can be wrong by the time the
   * write lands — the recording may have been committed between the read and the
   * retry. A backend may deliver that by re-running the modifier on conflict or by
   * serialising per document; both satisfy it, and the kit pins either.
   *
   * See {@link commitPreview} for the other half of the preview: a commit moves
   * the region's text onto `committed` and clears the tail. See
   * {@link writeTranscript} for the handoff that deletes `preview` in the same
   * revision that writes `transcript`.
   */
  async writePreviewTail(id: string, text: string): Promise<Capture | undefined> {
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
  async commitPreview(id: string, text: string): Promise<Capture | undefined> {
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
    patch: Omit<CapturePatch, "transcript">,
  ): Promise<Capture> {
    if (!(await this.#backend.get("captures", id))) {
      throw new Error(`outbox: no item with id "${id}"`);
    }
    const updated = await this.#modifyCapture(id, (data) => {
      const merged = handoffTranscript(data, transcript, patch);
      // The backend hands back clean documents, so what the modifier sees is
      // exactly the persisted shape and the strict parse survives directly --
      // `persistedFieldsOf` used to scrub RxDB's metadata off first, and is gone.
      captureDocumentSchema.parse(merged);
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
    await sweepCaptureEntries(this.#backend, [id]);
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
    await sweepCaptureEntries(this.#backend, ids);
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
  async clear(query: CaptureQuery = {}): Promise<number> {
    const items = await this.list(query);
    const deleted = await this.removeMany(items.map((item) => item.id));
    return deleted;
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
    modify: (data: CaptureDocument) => CaptureDocument,
  ): Promise<StoredDocument> {
    return await this.#backend.modify("captures", id, (current) =>
      modify(current as unknown as CaptureDocument),
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
  ): Promise<{ document: CaptureDocument; chunks: readonly BlobDescriptor[] }> {
    const document = await this.#backend.get("captures", id);
    if (!document) throw new Error(`outbox: no item ${id}`);
    const typed = document as unknown as CaptureDocument;
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
   * read off an in-memory RxDB stub. {@link CaptureStore.#toItems} is the form to reach
   * for when projecting more than one — this is for the single-document paths.
   */
  async #toItem(document: StoredDocument): Promise<Capture> {
    const blobs = await this.#backend.listBlobs("captures", document.id);
    return itemFrom(document, blobs);
  }

  async #toItems(documents: readonly StoredDocument[]): Promise<Capture[]> {
    const blobs = await this.#backend.listBlobsMany(
      "captures",
      documents.map((document) => document.id),
    );
    return documents.map((document) => itemFrom(document, blobs.get(document.id) ?? []));
  }
}

/**
 * Build a consumer's item from a stored document and its blob descriptors.
 *
 * `audioReady` looks for the one canonical audio blob by its constant id;
 * `audioBytes` falls back to the accumulated chunks while a recording is still
 * in flight, which is what makes a partially-captured row report real progress.
 */
function itemFrom(document: StoredDocument, blobs: readonly BlobDescriptor[]): Capture {
  const typed = document as unknown as CaptureDocument;
  const canonical = blobs.find((blob) => blob.id === AUDIO_ATTACHMENT_ID);
  const audioBytes =
    canonical?.length ??
    (typed.status === "recording" && typed.capture
      ? sumChunkBytes(blobs, typed.capture.sourceId)
      : 0);
  return captureSchema.parse({
    ...document,
    audioReady: canonical !== undefined,
    audioBytes,
  });
}

/**
 * {@link CaptureQuery} → the port's captures finder.
 *
 * One function so `list`, `watch` and `nextPending` cannot disagree about what a
 * query means. It is now a near-identity — the port's finder takes the same three
 * dimensions — where it used to build a Mango selector. Translating a query into
 * whatever the storage engine wants is the backend's job, not this file's, which
 * is the whole reason the finder set is closed.
 */
function captureFinder({ status, sessionId, limit }: CaptureQuery): Finders["captures"] {
  return {
    ...(status === undefined ? {} : { status: [status].flat() }),
    ...(sessionId === undefined ? {} : { sessionId }),
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
