import type { RxJsonSchema } from "rxdb";
import { z } from "zod";

import { baseRecordingSchema } from "../recording.js";
import { transcriptSchema } from "../transcript.js";

/** The RxDB collection name. One collection for recordings; sessions have their own. */
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
 * The recording state machine — capture and transcription only.
 *
 * ```
 * recording → queued → transcribing → transcribed
 *                     ↘ (transient) → failed → (backoff elapses) → retry
 *                     ↘ (terminal)  → dead
 *                     ↘ discarded (human decision)
 * ```
 *
 * Extraction, review and write moved to the **session** (`session-schema.ts`).
 * The recording narrows to what it is: metadata for one captured dictation and
 * the transcript that came out of it. Once transcribed, the recording is
 * finished from the relay's perspective — the session owns the next steps.
 *
 * **`dead` is the only terminal state.** `failed` is a *resting* state: the
 * relay picks it back up once `nextAttemptAt` has passed, which is why
 * `failed ∈ ACTIVE_OUTBOX_STATUSES`. An item leaves `failed` for `dead` only by
 * exhausting `maxAttempts` or by a terminal failure classification.
 *
 * `discarded` means the contractor threw that recording away. Its words should
 * not return through a later extraction — `session-extract.ts` excludes
 * `discarded` recordings from the joined transcript.
 */
export const OUTBOX_STATUSES = [
  "recording",
  "queued",
  "transcribing",
  "transcribed",
  "failed",
  "dead",
  "discarded",
] as const;

export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/**
 * Statuses the relay will still act on for a recording.
 *
 * `queued` (waiting to transcribe), `transcribing` (in flight), and `failed`
 * (resting, retryable after backoff). **`transcribed` is NOT active** — the
 * relay is done with the recording; the session owns the next steps.
 */
export const ACTIVE_OUTBOX_STATUSES = [
  "queued",
  "transcribing",
  "failed",
] as const satisfies readonly OutboxStatus[];

/**
 * Whether the relay would act on this status.
 *
 * Exported so a caller re-reading an item can ask the same question `nextPending()` asked, rather
 * than re-listing the statuses and drifting from them.
 */
export function isActiveStatus(status: OutboxStatus): boolean {
  return (ACTIVE_OUTBOX_STATUSES as readonly OutboxStatus[]).includes(status);
}

/**
 * Statuses the relay will not act on again unattended. `transcribed` is here
 * because the relay is done with the recording — the session owns extraction
 * and write. `dead` is terminal; `discarded` is a human decision.
 */
export const FINISHED_OUTBOX_STATUSES = [
  "transcribed",
  "dead",
  "discarded",
] as const satisfies readonly OutboxStatus[];

/**
 * In-flight capture. Its own category because it is neither: the relay must not
 * act on it (there is no committed audio yet), and it is plainly not finished.
 */
export const RECORDING_OUTBOX_STATUSES = ["recording"] as const;

/**
 * The persisted shape of one recording document — exactly the fields that live
 * in IndexedDB, and nothing else.
 *
 * This is a **trust boundary** in both directions (AGENTS.md §4): documents that
 * come back out of IndexedDB were written by an older build of this code, or by
 * a tab running a different version, so they are parsed rather than cast — and
 * documents going in are parsed too, so a bug surfaces at the write rather than
 * three reloads later.
 *
 * Pinned field-for-field against {@link outboxRxSchema} by `schema.test.ts`.
 * Anything added here must be added there, and vice versa.
 *
 * **Session-level fields moved to `session-schema.ts` in v6** (extracted,
 * extractedBy, reviewOutcome, writeResult, writtenInstances, idempotencyKey).
 * The recording keeps capture and transcription; the session owns everything
 * downstream.
 */
export const outboxDocumentSchema = z
  .strictObject({
    /** Stable id, and the RxDB primary key. */
    id: z.string().min(1),
    /**
     * Monotonic ordering key. The relay processes the lowest-`seq` **active**
     * recording first, which preserves capture order for transcription.
     */
    seq: z.number().int().nonnegative(),
    status: z.enum(OUTBOX_STATUSES),
    /**
     * The session this recording belongs to. Required — every recording is
     * enqueued into a session. The session owns extraction, review and write
     * state; the recording is capture + transcription only.
     */
    sessionId: z.string().min(1),
    /**
     * How many times transcription has failed for this recording. Drives the
     * backoff curve and, against `RelayOptions.maxAttempts`, when the relay
     * gives up and calls it `dead`.
     */
    attempts: z.number().int().nonnegative(),
    /**
     * Earliest ISO timestamp at which this recording may be attempted again.
     * Persisted rather than held in a timer so the backoff schedule survives a
     * reload — on iOS the tab is the only execution context there is, and it
     * dies often.
     */
    nextAttemptAt: z.iso.datetime(),
    /** When the recording entered the queue. */
    enqueuedAt: z.iso.datetime(),
    /** Message from the most recent failure, for the "needs attention" UI. */
    lastError: z.string().optional(),
    /** Capture metadata. The audio bytes live in the attachment, not here. */
    recording: baseRecordingSchema,
    /**
     * Step output — present once transcription has succeeded.
     *
     * **Write it with {@link Outbox.writeTranscript}, never with `patch`.** `transcript` is still
     * reachable through {@link OutboxPatch} — it has to be, because the relay's retry path patches
     * other fields on the same rows — so nothing stops a future caller setting it directly. Doing
     * so would leave `preview` behind on a committed row, where nothing removes it again: `patch`
     * is an `incrementalPatch` and cannot delete a key at all. That is a convention here, not a
     * fence, and this sentence is the only thing holding it.
     */
    transcript: transcriptSchema.optional(),
    /**
     * Capture identity, present on a row recorded through the durable path. `sourceId`
     * names the chunk attachments and must NEVER change — recovery finds every chunk of
     * a recording through it.
     */
    capture: z.strictObject({ sourceId: z.string().min(1) }).optional(),
    /**
     * Live-transcription preview: settled text plus the provisional tail of the
     * region still being transcribed, accumulated while `status === "recording"`
     * and deleted wholesale when the batch transcript lands.
     *
     * **Not patchable** — see {@link OutboxPatch}. Written through
     * `Outbox.writePreviewTail` and `Outbox.commitPreview`, and deleted in the
     * same `incrementalModify` that writes `transcript`.
     */
    preview: z
      .strictObject({ committed: z.array(z.string()), tail: z.string().optional() })
      .optional(),
  })
  .superRefine((doc, ctx) => {
    if (doc.status === "recording" && !doc.capture) {
      ctx.addIssue({ code: "custom", message: "a recording row must carry capture" });
    }
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
export const DERIVED_OUTBOX_ITEM_KEYS = ["audioBytes", "audioReady"] as const;

/**
 * What a *consumer* sees: the persisted document plus the attachment facts.
 * Same projection as before the split — the recording still carries audio.
 */
export const outboxItemSchema = outboxDocumentSchema.extend({
  /** Whether the `AUDIO_ATTACHMENT_ID` attachment exists **right now**. */
  audioReady: z.boolean(),
  /** Durable bytes on disk for this item: the canonical attachment, or the
   * accumulated chunks while still recording. `0` when there are neither. */
  audioBytes: z.number().int().nonnegative(),
});

/** Inferred from {@link outboxItemSchema} — never hand-declared alongside it. */
export type OutboxItem = z.infer<typeof outboxItemSchema>;

/**
 * The fields a caller may change after enqueue.
 *
 * `id`, `seq`, `enqueuedAt`, `recording`, `sessionId` and `capture` are
 * deliberately absent: they are decided once and re-deciding any of them would
 * break ordering, provenance, session membership or idempotency.
 *
 * `preview` is absent because it is written only through
 * `Outbox.writePreviewTail` / `Outbox.commitPreview` and deleted only in the
 * same `incrementalModify` that writes `transcript`.
 */
export type OutboxPatch = Partial<
  Omit<
    OutboxDocument,
    "id" | "seq" | "enqueuedAt" | "recording" | "sessionId" | "capture" | "preview"
  >
>;

/**
 * The RxDB JSON schema.
 *
 * Hand-written rather than generated from the zod schema above, because RxDB
 * needs metadata zod has no concept of — `primaryKey`, `indexes`, `attachments`,
 * and the `maxLength`/`minimum`/`maximum`/`multipleOf` bounds it uses to build
 * fixed-width index keys. `schema.test.ts` pins the two descriptions of the same
 * document against each other so they cannot drift apart unnoticed.
 */
export const outboxRxSchema: RxJsonSchema<OutboxDocument> = {
  version: 6,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 64 },
    seq: { type: "number", minimum: 0, maximum: 1_000_000_000, multipleOf: 1 },
    status: { type: "string", maxLength: 16 },
    sessionId: { type: "string", maxLength: 64 },
    attempts: { type: "integer", minimum: 0 },
    nextAttemptAt: { type: "string", maxLength: 32 },
    enqueuedAt: { type: "string", maxLength: 32 },
    lastError: { type: "string" },
    recording: { type: "object" },
    transcript: { type: "object" },
    capture: { type: "object" },
    preview: { type: "object" },
  },
  required: [
    "id",
    "seq",
    "status",
    "sessionId",
    "attempts",
    "nextAttemptAt",
    "enqueuedAt",
    "recording",
  ],
  indexes: ["seq"],
  attachments: {},
};
