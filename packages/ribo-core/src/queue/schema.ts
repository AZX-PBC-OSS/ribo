import type { RxJsonSchema } from "rxdb";
import { z } from "zod";

import { baseRecordingSchema } from "../recording.js";
import { reviewOutcomeSchema } from "../review.js";
import { transcriptSchema } from "../transcript.js";

/** The RxDB collection name. One collection; the queue is not sharded. */
export const OUTBOX_COLLECTION_NAME = "outbox";

/**
 * The attachment id the captured audio is stored under.
 *
 * Audio is an **RxDB attachment**, not a base64 field on the document
 * (`docs/implementation/09-offline-first.md`). A base64 blob inlined into the
 * document would be re-read, re-parsed and re-emitted by every query that so
 * much as lists the queue — including the UI's live `items$` subscription.
 * Attachments are fetched only when something actually asks for the bytes.
 */
export const AUDIO_ATTACHMENT_ID = "audio";

/**
 * The per-item state machine from `09`:
 *
 * ```
 * queued → transcribing → extracting → awaiting-review → writing → done
 *                                                     ↘ discarded
 *                      ↘ (transient) → failed → (backoff elapses) → retry
 *                      ↘ (terminal)  → dead ⇢ awaiting-review (Outbox.reopenForReview)
 * ```
 *
 * **The two arrows out of `awaiting-review`, and the one arrow back into it from
 * `dead`, are the only ones no code takes on its own.** Every other transition is
 * the relay's; these three are human-driven: `Outbox.submitReview` for the two out,
 * `Outbox.reopenForReview` for the one back in. Until `submitReview` is called the
 * item is not in {@link ACTIVE_OUTBOX_STATUSES} and the relay drains straight past
 * it; `reopenForReview` only ever arrives FROM `dead`, so it can add an item back
 * to the parked set but can never let one skip review on the way there.
 *
 * **`dead` is the only terminal state.** `failed` is a *resting* state: the
 * relay picks it back up once `nextAttemptAt` has passed, which is why
 * `failed ∈ ACTIVE_OUTBOX_STATUSES`. An item leaves `failed` for `dead` only by
 * exhausting `maxAttempts` or by a terminal failure classification. "Terminal"
 * describes what the RELAY does with it — nothing, ever, on its own — not that
 * nothing can. `Outbox.reopenForReview` is a way out, same as `submitReview` is
 * for `awaiting-review`: a human decision, never something `#recordFailure`
 * reaches for itself.
 *
 * Resist the temptation to describe both as "terminal because no step is in
 * flight". That phrasing is *nearly* true and it already cost us one design
 * error — `docs/implementation/09-offline-first.md` was written that way and
 * described a machine where backoff had nowhere to live. Say what is true:
 * one resting state, one terminal state.
 */
export const OUTBOX_STATUSES = [
  "queued",
  "transcribing",
  "extracting",
  "awaiting-review",
  "writing",
  "done",
  "failed",
  "dead",
  "discarded",
] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/**
 * Statuses the relay will still act on. Everything else is finished — or, in the
 * case of `awaiting-review`, waiting on a human.
 *
 * **`awaiting-review` is missing from this list on purpose, and that omission is
 * the review gate.** `nextPending()` selects `list({ status: ACTIVE_OUTBOX_STATUSES })`,
 * so a parked item is never handed to the relay, and the next capture drains past
 * it. Add `awaiting-review` here and the relay will pick a parked item up,
 * `nextStep()` will see `extracted` present and return `"write"`, and un-reviewed
 * model output goes to the host tool. `schema.test.ts` pins this, and
 * `relay.browser.test.ts` proves the behaviour end to end.
 */
export const ACTIVE_OUTBOX_STATUSES = [
  "queued",
  "transcribing",
  "extracting",
  "writing",
  "failed",
] as const satisfies readonly OutboxStatus[];

/**
 * Statuses the relay will not act on again unattended. `dead` has a human-driven
 * way out (`Outbox.reopenForReview`); `done` and `discarded` have none. See the
 * fuller distinction drawn above {@link OUTBOX_STATUSES} between "terminal" and
 * "truly final" — this constant's name is the former, not the latter.
 */
export const FINISHED_OUTBOX_STATUSES = [
  "done",
  "dead",
  "discarded",
] as const satisfies readonly OutboxStatus[];

/**
 * The persisted shape of one outbox document — exactly the fields that live in
 * IndexedDB, and nothing else.
 *
 * This is a **trust boundary** in both directions (AGENTS.md §4): documents that
 * come back out of IndexedDB were written by an older build of this code, or by
 * a tab running a different version, so they are parsed rather than cast — and
 * documents going in are parsed too, so a bug surfaces at the write rather than
 * three reloads later.
 *
 * Pinned field-for-field against {@link outboxRxSchema} by `schema.test.ts`.
 * Anything added here must be added there, and vice versa.
 */
export const outboxDocumentSchema = z.strictObject({
  /** Stable id, and the RxDB primary key. */
  id: z.string().min(1),
  /**
   * Monotonic ordering key. The relay processes the lowest-`seq` **active** item
   * first, which is what "serial, lowest first" in `09` buys: capture order is the
   * order items are *offered* to the relay, and it stays write order for every step
   * the relay decides on its own.
   *
   * **Review is the one step a human orders, so writes follow review order.** An
   * item parked at `awaiting-review` leaves the active set, the next capture drains
   * past it, and — once the recordings ahead of it have parked, finished or died —
   * whichever recording is reviewed first writes first, even if it was captured
   * second. (A lower-`seq` sibling resting in `failed` is still active, and still
   * holds the queue until its backoff elapses; `relay.ts`'s `#drain` explains why
   * that one must not be overtaken.) This used to read "capture order is write
   * order" and that is no longer true; it is narrowed on purpose rather than
   * defended, because holding writes to capture order would let one un-reviewed
   * recording block every write behind it, which is the exact stall the parked
   * design exists to avoid.
   */
  seq: z.number().int().nonnegative(),
  status: z.enum(OUTBOX_STATUSES),
  /**
   * Generated once, at enqueue, and reused on **every** retry — that is the
   * whole point. Sent as `Idempotency-Key` on external writes so an ambiguous
   * success (write landed, response lost) cannot double-write. Regenerating it
   * on retry would silently undo the guarantee, which is why no patch type in
   * this package lets you change it.
   */
  idempotencyKey: z.string().min(1),
  /**
   * How many times a step has failed for this item. Drives the backoff curve
   * and, against `RelayOptions.maxAttempts`, when the relay gives up and calls
   * it `dead`. Reset to `0` on every fresh entry into `awaiting-review` — see
   * that option's own doc comment for why `maxAttempts` is a per-cycle budget
   * rather than a lifetime cap on the item.
   */
  attempts: z.number().int().nonnegative(),
  /**
   * Earliest ISO timestamp at which this item may be attempted again. Persisted
   * rather than held in a timer so the backoff schedule survives a reload — on
   * iOS the tab is the only execution context there is, and it dies often.
   */
  nextAttemptAt: z.iso.datetime(),
  /** When the item entered the queue. */
  enqueuedAt: z.iso.datetime(),
  /** Message from the most recent failure, for the "needs attention" UI. */
  lastError: z.string().optional(),
  /** Capture metadata. The audio bytes live in the attachment, not here. */
  recording: baseRecordingSchema,
  /** Step output — present once transcription has succeeded. */
  transcript: transcriptSchema.optional(),
  /** Step output — present once extraction has succeeded. */
  extracted: z.record(z.string(), z.unknown()).optional(),
  /** Step output — whatever the tool adapter returned from the write. */
  writeResult: z.record(z.string(), z.unknown()).optional(),
  /**
   * What the human decided. Present once review has been submitted; absent means
   * this item has not been reviewed, which `relay.ts` treats as a hard error at
   * write time rather than a default-accept.
   */
  reviewOutcome: reviewOutcomeSchema.optional(),
});

/** Inferred from {@link outboxDocumentSchema} — never hand-declared alongside it. */
export type OutboxDocument = z.infer<typeof outboxDocumentSchema>;

/**
 * The fields of the projection that are **derived from the attachment store**
 * rather than read out of the document.
 *
 * Named as a constant because two tests depend on the exact set: the drift
 * guard that pins {@link outboxDocumentSchema} against {@link outboxRxSchema}
 * (these keys must be absent from the RxDB schema — they are never persisted)
 * and the one that pins {@link outboxItemSchema} against the document schema
 * (these keys, and only these, are the difference).
 */
export const DERIVED_OUTBOX_ITEM_KEYS = ["audioBytes", "hasAudio"] as const;

/**
 * What a *consumer* sees: the persisted document plus the attachment facts.
 *
 * Why this is a second schema rather than two more fields on the document.
 * `_attachments` is RxDB metadata, and `RxDocument.toJSON()` strips it — so a
 * projection built from `toJSON()` alone genuinely cannot tell "audio was never
 * attached" from "audio was attached and later dropped" from "audio is in
 * flight". Both readings are the absence of information, and a UI that must
 * honestly report a dropped recording (once `dropAudioAfterTranscription` is on,
 * or once iOS evicts the origin's storage) needs to tell them apart.
 *
 * Persisting a `hasAudio` **column** would be the wrong fix: it is a second copy
 * of a truth the attachment store already holds, and it would go stale the
 * moment anything removed the bytes without going through this class — which is
 * exactly what iOS eviction does. So it is computed, per read, from the
 * document's live attachment stub. That stub is already in memory (RxDB carries
 * it on `_data`), so this costs no I/O: `getAttachment` is a property lookup,
 * not a fetch of the bytes.
 *
 * `audioBytes` rides along for the same free reason — the stub carries the
 * length — and it lets a queue UI show a size without loading a recording into
 * memory just to call `.size` on it. `hasAudio` is the signal to branch on;
 * `audioBytes` is `0` whenever `hasAudio` is `false`.
 *
 * Both fields also make `items$` re-emit *meaningfully* across an attachment
 * change. The document's own fields are byte-identical before and after a
 * `putAttachment` or a `dropAudio`, so a memoizing consumer could not otherwise
 * tell that anything happened.
 */
export const outboxItemSchema = outboxDocumentSchema.extend({
  /** Whether the audio attachment exists **right now**. */
  hasAudio: z.boolean(),
  /** Size of that attachment in bytes; `0` when there is none. */
  audioBytes: z.number().int().nonnegative(),
});

/** Inferred from {@link outboxItemSchema} — never hand-declared alongside it. */
export type OutboxItem = z.infer<typeof outboxItemSchema>;

/**
 * The fields a caller may change after enqueue.
 *
 * Derived from the **document** schema, so the projection's computed fields
 * (`hasAudio`, `audioBytes`) are unpatchable by construction — they are facts
 * about the attachment store, and `putAttachment` / `dropAudio` are the only
 * things entitled to change them.
 *
 * `id`, `seq`, `enqueuedAt`, `recording` and `idempotencyKey` are deliberately
 * absent: they are decided once and re-deciding any of them would break
 * ordering, provenance or idempotency.
 */
export type OutboxPatch = Partial<
  Omit<OutboxDocument, "id" | "seq" | "enqueuedAt" | "recording" | "idempotencyKey">
>;

/**
 * The RxDB JSON schema.
 *
 * Hand-written rather than generated from the zod schema above, because RxDB
 * needs metadata zod has no concept of — `primaryKey`, `indexes`, `attachments`,
 * and the `maxLength`/`minimum`/`maximum`/`multipleOf` bounds it uses to build
 * fixed-width index keys. `schema.test.ts` pins the two descriptions of the same
 * document against each other so they cannot drift apart unnoticed.
 *
 * Typed against `OutboxDocument`, not `OutboxItem`: `hasAudio` and `audioBytes`
 * are projected, never stored, and a storage schema that mentioned them would be
 * claiming to persist something it does not.
 */
export const outboxRxSchema: RxJsonSchema<OutboxDocument> = {
  version: 1,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 64 },
    // Indexed, so RxDB needs a bounded range and a step to encode it as a
    // sortable string. A billion queued recordings on one device is not a
    // scenario; ten digits of headroom is plenty.
    seq: { type: "number", minimum: 0, maximum: 1_000_000_000, multipleOf: 1 },
    status: { type: "string", maxLength: 16 },
    idempotencyKey: { type: "string", maxLength: 64 },
    attempts: { type: "integer", minimum: 0 },
    nextAttemptAt: { type: "string", maxLength: 32 },
    enqueuedAt: { type: "string", maxLength: 32 },
    lastError: { type: "string" },
    recording: { type: "object" },
    transcript: { type: "object" },
    extracted: { type: "object" },
    writeResult: { type: "object" },
    reviewOutcome: { type: "object" },
  },
  required: [
    "id",
    "seq",
    "status",
    "idempotencyKey",
    "attempts",
    "nextAttemptAt",
    "enqueuedAt",
    "recording",
  ],
  // Only `seq`. Every query this package issues sorts by it, and the status
  // filter is a cheap post-filter over a queue that is tens of items long, not
  // millions. An index nothing uses is a write-amplification cost with no payoff.
  indexes: ["seq"],
  // Presence of this key is what enables attachments at all — omit it and
  // `putAttachment` throws.
  attachments: {},
};
