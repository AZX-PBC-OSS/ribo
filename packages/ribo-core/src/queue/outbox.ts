import type { MangoQuery, RxAttachmentCreator, RxDocument, RxStorage } from "rxdb";
import type { Observable } from "rxjs";
import { map } from "rxjs";

import type { Recording } from "../recording.js";
import { baseRecordingSchema } from "../recording.js";
import type { PersistedReviewOutcome } from "../review.js";
import { reviewOutcomeSchema } from "../review.js";
import { isChunkOf } from "./chunk-names.js";
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
        // The non-durable enqueue path has no `capture` — audio is committed in
        // one write, not chunked.
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
   * Record what a human decided about a parked item, and move it forward.
   *
   * The only way out of `awaiting-review`, and it **only** works from
   * `awaiting-review`. That guard is not defensive tidiness: `multiInstance: true`
   * means a second tab holds its own `Outbox` over the same IndexedDB database, so
   * without it a stale tab could submit a review for an item that has since reached
   * `done` — patching a completed row back to `writing` and causing a second write —
   * or discard one while a write is in flight.
   *
   * Applied through `incrementalModify`, which RxDB re-runs against the **current**
   * revision on write conflict, so the status check and the mutation cannot be
   * split by another writer. Verified in rxdb 17.4.0's `incremental-write.ts`: on a
   * 409 the queue item is put back on the queue with `lastKnownDocumentState`
   * replaced by the conflict's `documentInDb`, and the modifier runs again over
   * that. `patch()` is not usable here: it reads with `findOne`, validates, then
   * writes, and (contrary to what one might assume from `enqueue`) it does **not**
   * go through this class's `#serialized` chain — that chain guards only the
   * sequence-number allocation in `enqueue`.
   *
   * The genuinely-concurrent case is covered in `outbox.browser.test.ts` and it
   * really does traverse that retry, not a cheaper path: `addWrite` calls
   * `triggerRun()` synchronously inside its promise executor, and `triggerRun`
   * takes the pending-write map over synchronously before its first `await`, so a
   * second submission always lands in a *fresh* batch carrying a
   * `lastKnownDocumentState` captured before the first write committed. The two
   * cannot be folded into one batch and chained modifier-over-modifier.
   *
   * The cross-*tab* case — two independent `RxDatabase` connections, not two calls
   * on one — is the one this guard exists for and, for `submitReview` itself, still
   * the one no test drives directly; that remains judged not worth the process-
   * global `RxDBDevModePlugin` side effect while the single-instance 409 above
   * exercises the identical retry mechanism. What changed: a cross-tab test now
   * exists for {@link reopenForReview} (`outbox-reopen-cross-tab.browser.test.ts`,
   * isolated into its own file so that plugin cannot leak into this file's
   * assertions), proving the mechanism itself is sound across two connections. It
   * proves that for `reopenForReview`'s own guard, not for this one — the two are
   * separate `incrementalModify` calls on separate documents-in-time — but the two
   * guards are structurally identical, so a reader satisfied by one should weigh
   * the other the same way.
   *
   * **This guard is also now exposed to the ABA race {@link reopenForReview}'s own
   * doc comment documents**, for a reason specific to that method: before it
   * existed, `awaiting-review` could only ever be entered once per item, so a
   * status predicate was a sound identity check by construction. `reopenForReview`
   * added a way back in, which turned the state machine into a cycle
   * (`dead → awaiting-review → writing → dead → …`), and `submitReview`'s
   * `current.status !== "awaiting-review"` check can no longer tell "the
   * `awaiting-review` I read" from "a later `awaiting-review`, reached by a second
   * reopen after the first one finished and died again" apart, for a suspended-then-
   * resumed caller spanning that whole cycle. See {@link reopenForReview} for the
   * concrete sequence and why it is judged unlikely today rather than closed.
   *
   * - `accepted` / `edited` → `writing`, with `attempts` reset so the write gets a
   *   clean backoff budget. The relay picks the item up on its next drain and
   *   passes `outcome.fields` to the write step.
   * - `discarded` → `discarded`, and the audio is dropped. An auditor abandoning a
   *   dictation should not leave a recording of someone's home on the device; the
   *   row is kept because "captured and deliberately discarded" is worth seeing.
   *
   * An `edited` outcome that rejected *every* field still moves to `writing`, with
   * an empty field set. That is `resolveReview`'s rule and it is preserved here on
   * purpose — rejecting everything is a statement about the extraction, discarding
   * is a statement about the recording, and collapsing the two would lose the
   * distinction (and, worse, would drop audio the human never asked to discard).
   * Refusing to *write* an empty field set is `relay.ts`'s `#write`, which is where
   * the one invariant about reaching the host tool already lives.
   *
   * Takes the persisted (loose) outcome. `ReviewOutcome` erases to it at the hook
   * boundary — one document schema serves every host tool's field set — and its
   * `fields` is already the reassembled nested object `resolveReview` produced.
   *
   * @throws if the item does not exist, or is not `awaiting-review`. A duplicate
   * submission — two clicks, or two tabs — therefore fails loudly on the second
   * rather than silently rewriting a row that has moved on.
   *
   * **A rejection does not always mean nothing happened.** Every rejection before
   * the `incrementalModify` resolves leaves the row untouched, but a `discarded`
   * submission whose `dropAudio` then fails rejects with the status *already
   * committed* and the audio still on the device. A caller holding a review screen
   * open must not read a rejection as "still awaiting review": re-submitting will
   * fail with `is "discarded"`, because the review did land. The failure is
   * surfaced rather than swallowed on purpose — silently failing to destroy a
   * recording of someone's home is the worse outcome of the two, and the retry is
   * `dropAudio(id)` on its own.
   */
  async submitReview(id: string, outcome: PersistedReviewOutcome): Promise<OutboxItem> {
    const parsed = reviewOutcomeSchema.parse(outcome);
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item with id "${id}"`);

    const patch: OutboxPatch =
      parsed.status === "discarded"
        ? { reviewOutcome: parsed, status: "discarded" }
        : { reviewOutcome: parsed, status: "writing", attempts: 0 };

    const updated = await doc.incrementalModify((current) => {
      if (current.status !== "awaiting-review") {
        throw new Error(
          `outbox: item ${id} is "${current.status}", not "awaiting-review", so a review cannot be submitted for it. Another tab or an earlier submission has already moved it on.`,
        );
      }
      const merged = { ...current, ...patch };
      // Validated inside the modifier, against the revision actually being
      // written. `persistedFieldsOf` is not tidying: RxDB hands the modifier its
      // *internal* document, which carries `_attachments`, `_deleted`, `_meta` and
      // `_rev` alongside the persisted fields, and the document schema is a
      // `strictObject` — parsing `merged` whole fails with `unrecognized_keys`.
      // The metadata rides back out on the returned object, which RxDB
      // reattaches either way.
      outboxDocumentSchema.parse(persistedFieldsOf(merged));
      return merged;
    });

    if (parsed.status !== "discarded") return this.#toItem(updated);

    // Dropped only AFTER the status is committed. A crash between the two then
    // leaves a `discarded` row that still holds its audio — untidy, but
    // recoverable — rather than an `awaiting-review` row whose recording has
    // silently vanished, which would look reviewable and be unrecoverable with
    // nothing to say why.
    await this.dropAudio(id);
    // Re-read rather than projecting `updated`: `audioReady` and `audioBytes` are
    // facts about the attachment store, and that handle was projected before the
    // drop. A discard removes the attachment, never the row, so it is still there.
    const settled = await this.#collection.findOne(id).exec();
    // Not reachable through this method — and asserted rather than `!`-ed for the
    // same reason the re-read exists at all: the point is to stop depending on what
    // RxDB happens to do, and an opaque `TypeError` from inside `#toItem` is a poor
    // way to learn it changed.
    if (!settled) throw new Error(`outbox: item "${id}" vanished while its review was recorded`);
    return this.#toItem(settled);
  }

  /**
   * Move a `dead` item back to `awaiting-review`, so a human can correct whatever
   * killed it and resubmit through {@link submitReview}.
   *
   * **`dead` is the only legal source status**, and each of the others is refused
   * for a different reason rather than by blanket suspicion:
   *
   *   - `done` — the write already reached the host tool. Reopening it is not a
   *     recovery, it is a way to write twice, which is exactly the double-write
   *     `submitReview`'s own guard exists to prevent one step later.
   *   - `discarded` — a human already made a deliberate, audited decision to
   *     abandon this recording (`submitReview`'s own doc comment). Undoing that is
   *     a different feature nobody has asked this method to be, and the audio may
   *     already be gone.
   *   - `queued` / `transcribing` / `extracting` / `writing` / `failed` — every
   *     status the relay still owns. There is nothing broken to recover from here,
   *     only a race with whatever the relay is doing (or about to do) to the same
   *     row to lose.
   *
   * `dead` is also the only status the two documented recovery paths ever produce:
   * both `toWriteStep` (`write-step.ts`) and `#write` (`relay.ts`) throw a
   * `TerminalQueueError` when the reviewed data cannot be written, `#recordFailure`
   * resolves every terminal failure straight to `dead` (never `failed` — that
   * status is for the transient case, see `schema.ts`), and both throw sites tell
   * the reader to re-park the item and review it afresh. Before this method, that
   * advice meant a raw `Outbox.patch(id, { status: "awaiting-review" })` — the same
   * shape `relay.browser.test.ts` uses to simulate a state-machine bug jumping the
   * review gate by hand. This method is the supported replacement for that patch,
   * and both throw sites now name it instead.
   *
   * Also refused: a `dead` item missing `extracted`, OR missing `transcript`.
   * **A reviewable item needs both, not just the one this method originally
   * checked.** `buildReviewRequest(extracted, transcript, …)` (`review.ts`) takes
   * both arguments, and `isSpanGrounded` inside it checks every extracted span
   * against `transcript.text` — without a transcript there is nothing to ground a
   * value against, so a UI handed this item could not even render an honest
   * review card, let alone flag an ungrounded one. Through the real pipeline this
   * second check can never fire: `relay.ts`'s `nextStep` never returns `"extract"`
   * until a transcript is already persisted, so `extracted` implies `transcript`
   * by construction for any item the relay itself produced. It exists anyway
   * because `patch()` — a public, unrestricted method — does not enforce that
   * ordering, and a document built by hand (a test fixture, a future migration, a
   * host that reached for `patch` instead of this method) could carry one without
   * the other. Refusing it here is cheaper than a `ReviewPanel` that has to guess
   * why `isSpanGrounded` just threw on `undefined.text`.
   *
   * **Clears the stale `reviewOutcome`.** Whatever a human decided last time — the
   * only way a `dead` item can carry `extracted` at all is by having passed through
   * `submitReview` once already and failed later, at the write step — is deleted
   * outright rather than left in place or overwritten with `undefined`. Leaving it
   * would let the NEXT `submitReview` merge a decision nobody just made into a
   * review that has not happened yet, silently resurrecting a rejected field or an
   * edit the human never saw this time. `attempts` is also reset to `0`, the same
   * as every other entry into `awaiting-review` (`relay.ts`'s `#extract`) — see
   * that field's own note below on what this does, and does not, bound.
   *
   * `lastError` is deliberately left alone. It is why the item needed reopening in
   * the first place, and clearing it here would remove the one thing on the row
   * that explains that to whoever is looking at it next.
   *
   * Applied through `incrementalModify`, for the identical reason {@link submitReview}
   * is: the status check and the mutation must not be split by a second tab
   * reopening — or resubmitting — the same item. See that method's own doc comment
   * for the mechanism; it applies here unchanged.
   *
   * ## A cycle, and the ABA race it opens — documented, not closed
   *
   * Before this method existed, `awaiting-review` was enterable exactly once per
   * item: `#extract` was the only way in, `submitReview` the only way out, and
   * neither can run twice on the same item (the first because the relay never
   * revisits `awaiting-review`; the second because its own guard refuses anything
   * but `awaiting-review`). A status predicate checked inside `incrementalModify`
   * was therefore a sound proxy for "the specific transition I observed": there
   * was only ever one `awaiting-review` to observe.
   *
   * This method removes that property. The machine now has a cycle —
   * `dead → awaiting-review → writing → dead → awaiting-review → …` — and a status
   * string cannot tell "the `dead` I read" from "a *later* `dead`, reached by a
   * full trip around the cycle after mine." Concretely, for this method's own
   * guard to clear the wrong `reviewOutcome`:
   *
   *   1. Caller A calls `reopenForReview(id)` while the item is `dead` at
   *      revision R1. Its first write attempt is built against R1.
   *   2. Before that write commits, some other writer — a second tab, most
   *      plausibly — takes the item all the way around the cycle: `submitReview`
   *      parks a fresh review at `writing` (R2), and a second write failure lands
   *      it back on `dead` at R3, with a **new** `reviewOutcome` already cleared
   *      and re-set by that trip.
   *   3. For A to clear THAT `reviewOutcome` rather than abort, A's write must
   *      conflict and retry landing on R3 directly — never once observing R2
   *      (`awaiting-review`) or the `writing` revision in between, either of which
   *      would fail A's own status check and abort the call right there.
   *
   * Step 3 is the load-bearing one, and it is why this is documented rather than
   * fixed pre-emptively. `incrementalModify` retries on *conflict*, not on a timer
   * (`submitReview`'s own doc comment: `triggerRun()` fires synchronously inside
   * `addWrite`'s promise executor), so A's pending call would ordinarily be woken
   * and re-invoked at R2 within the same event-loop turn R2 is written — long
   * before a second, human-driven `submitReview` → write-failure round trip could
   * complete. For A to skip straight from R1 to R3, A's own retry-continuation has
   * to be starved of a turn on the event loop for the *entire* span of that human
   * interaction (read the failure, decide, click reopen, review, submit — seconds
   * at the least), not merely delayed by normal write latency. That specific
   * starvation is a poor match for either of this project's real targets:
   * `schema.ts`'s own note on `nextAttemptAt` is that "on iOS the tab is the only
   * execution context there is, and it dies often" — dying, on iOS, generally
   * means the page reloads from nothing rather than the JS heap freezing an
   * in-flight promise and resuming it later, which would destroy A's pending call
   * outright rather than let it resume zombie-like; a desktop background tab
   * throttles newly-scheduled timers, not an already-in-flight IndexedDB
   * transaction or the promise continuation waiting on it. Judged unlikely on that
   * basis — an inference from documented platform behaviour, not a citation of a
   * spec that settles it — rather than on the strength of "two tabs is a rare
   * shape": two tabs is exactly the case this file's other concurrency notes take
   * seriously.
   *
   * The fix, if this stops being unlikely — a browser behaviour changes, a
   * non-browser host with different scheduling guarantees adopts this package, or
   * `reopenForReview` gains a caller whose own write path can stall for
   * comparable spans — is a persisted generation counter: increment a field (e.g.
   * on every transition *into* `dead`) in `#recordFailure`, require the caller to
   * pass back the value it last observed on the item it is looking at, and refuse
   * here unless the current document's counter still matches. That is deliberately
   * NOT done pre-emptively: it changes this method's signature from "the id" to
   * "the id, plus a token every caller must remember to thread through," for a
   * race with no caller yet and, per the above, no plausible trigger on either of
   * this project's shipped runtimes. Schema cost is not why it is deferred — this
   * package still has no published users (`database.ts`'s
   * `OUTBOX_MIGRATION_STRATEGIES` says the same thing about the v0→v1 migration:
   * "nothing is published and there are no users, so no deployed data is at risk
   * here"), and a generation field would be a one-line addition. The deferral is
   * about the API-shape cost landing on every future caller for a benefit this
   * analysis could not justify today. `submitReview`'s own doc comment points back
   * here for the half of this it now shares.
   *
   * @throws if the item does not exist, is not `dead`, or is missing `extracted`
   * or `transcript`.
   */
  async reopenForReview(id: string): Promise<OutboxItem> {
    const doc = await this.#collection.findOne(id).exec();
    if (!doc) throw new Error(`outbox: no item with id "${id}"`);

    const updated = await doc.incrementalModify((current) => {
      if (current.status !== "dead") {
        throw new Error(
          `outbox: item ${id} is "${current.status}", not "dead", so it cannot be reopened for ` +
            "review. Only a dead item may be re-parked this way — reopening a finished item would " +
            "risk a second write, and reopening one the relay still owns would only race it.",
        );
      }
      if (current.extracted === undefined) {
        throw new Error(
          `outbox: item ${id} has no extracted data to review — it never reached extraction, so ` +
            "there is nothing to re-park it with.",
        );
      }
      if (current.transcript === undefined) {
        throw new Error(
          `outbox: item ${id} has extracted data but no transcript, which the real pipeline never ` +
            "produces on its own (extraction never runs before a transcript is persisted) — " +
            "something patched this document directly. There is nothing to ground the extracted " +
            "values against, so it cannot be reopened for review either.",
        );
      }

      // Deleted outright rather than left or set to `undefined`: a key present
      // with value `undefined` still round-trips through structured clone and
      // would still parse against `outboxDocumentSchema`'s `.optional()`, but the
      // point being made is a review that has not happened yet, which an ABSENT
      // key says unambiguously — see `persistedFieldsOf` for the same instinct
      // applied to RxDB's own metadata.
      const merged = { ...current, status: "awaiting-review" as const, attempts: 0 };
      delete merged.reviewOutcome;

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

/** Total durable bytes of one capture's chunk attachments. Reads stub lengths, never bytes. */
function sumChunkBytes(doc: RxDocument<OutboxDocument>, sourceId: string): number {
  let total = 0;
  for (const attachment of doc.allAttachments()) {
    if (isChunkOf(attachment.id, sourceId)) total += attachment.length;
  }
  return total;
}
