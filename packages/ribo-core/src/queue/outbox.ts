import type { MangoQuery, RxAttachmentCreator, RxDocument, RxStorage } from "rxdb";
import type { Observable } from "rxjs";
import { map } from "rxjs";

import type { Recording } from "../recording.js";
import { baseRecordingSchema } from "../recording.js";
import { openOutboxDatabase, type OutboxCollection, type OutboxDatabase } from "./database.js";
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

/** What a caller hands the queue: capture metadata plus the bytes. */
export interface EnqueueInput {
  recording: Recording;
  audio: Blob;
}

/**
 * Which items a read is interested in. Every field is optional, and the empty
 * query means "everything, seq-ascending" — the historical behaviour of
 * `list()` and `items$`.
 */
export interface OutboxQuery {
  /**
   * Keep only items in this status (or any of these statuses).
   *
   * Status is the filter the queue UI actually wants — "show me what still
   * needs attention" is `status: ACTIVE_OUTBOX_STATUSES` — and it is the only
   * one cheap enough to be worth offering without a second index: the selector
   * is a post-filter over the `seq` index, which is right for a queue of tens
   * and would want revisiting at a thousand rows.
   */
  status?: OutboxStatus | readonly OutboxStatus[];
  /** At most this many items, still lowest-`seq` first. */
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
  async enqueue({ recording, audio }: EnqueueInput): Promise<OutboxItem> {
    return this.#serialized(async () => {
      const document = outboxDocumentSchema.parse({
        id: this.#createId(),
        seq: (await this.#highestSeq()) + 1,
        status: "queued",
        idempotencyKey: this.#createIdempotencyKey(),
        attempts: 0,
        // Immediately eligible: a fresh item has no backoff to serve.
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
      // same `hasAudio` / `audioBytes` a subscriber sees for it.
      return this.#toItem(doc);
    });
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
    // stub on `doc._data`; it does not fetch the bytes, so this stays as cheap
    // as the projection it replaced.
    const attachment = doc.getAttachment(AUDIO_ATTACHMENT_ID);
    return outboxItemSchema.parse({
      ...doc.toJSON(),
      hasAudio: attachment !== null,
      audioBytes: attachment?.length ?? 0,
    });
  }

  async #serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#enqueueChain.then(work, work);
    this.#enqueueChain = next.catch(() => undefined);
    return next;
  }
}

/**
 * {@link OutboxQuery} → RxDB's Mango query.
 *
 * One function so `list`, `watch` and `nextPending` cannot disagree about what a
 * query means — in particular about the `seq`-ascending sort, which is the
 * queue's ordering guarantee and is not optional in any of them.
 */
function mangoQuery({ status, limit }: OutboxQuery): MangoQuery<OutboxDocument> {
  const statuses = status === undefined ? undefined : [status].flat();
  return {
    // A `selector` of `{}` is not the same as no selector to every RxDB query
    // planner, so the key is omitted entirely rather than left empty.
    ...(statuses ? { selector: { status: { $in: statuses } } } : {}),
    sort: [{ seq: "asc" }],
    ...(limit === undefined ? {} : { limit }),
  };
}
