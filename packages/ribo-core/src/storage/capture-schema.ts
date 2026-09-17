import { z } from "zod";

import { basePayloadSchema } from "../capture-item.js";
import { transcriptSchema } from "../transcript.js";

/** The RxDB collection name. One collection for outbox items (audio or document); sessions have their own. */
export const CAPTURES_COLLECTION_NAME = "outbox";

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
 * The outbox item's state machine — capture and transcription only.
 *
 * ```
 * recording → queued → transcribing → transcribed
 *                     ↘ (transient) → failed → (backoff elapses) → retry
 *                     ↘ (terminal)  → dead
 *                     ↘ discarded (human decision)
 * ```
 *
 * Extraction, review and write moved to the **session** (`session-schema.ts`).
 * The outbox item narrows to what it is: metadata for one captured item — audio
 * or document — and the transcript that came out of it. Once transcribed, the
 * item is finished from the relay's perspective — the session owns the next
 * steps.
 *
 * **`dead` is the only terminal state.** `failed` is a *resting* state: the
 * relay picks it back up once `nextAttemptAt` has passed, which is why
 * `failed ∈ ACTIVE_CAPTURE_STATUSES`. An item leaves `failed` for `dead` only by
 * exhausting `maxAttempts` or by a terminal failure classification.
 *
 * `discarded` means the auditor threw that capture away. Its words should
 * not return through a later extraction — `session-extract.ts` excludes
 * `discarded` items from the joined transcript.
 */
export const CAPTURE_STATUSES = [
  "recording",
  "queued",
  "transcribing",
  "transcribed",
  "failed",
  "dead",
  "discarded",
] as const;

export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/**
 * Statuses the relay will still act on for an outbox item.
 *
 * `queued` (waiting to transcribe), `transcribing` (in flight), and `failed`
 * (resting, retryable after backoff). **`transcribed` is NOT active** — the
 * relay is done with the item; the session owns the next steps.
 */
export const ACTIVE_CAPTURE_STATUSES = [
  "queued",
  "transcribing",
  "failed",
] as const satisfies readonly CaptureStatus[];

/**
 * Whether the relay would act on this status.
 *
 * Exported so a caller re-reading an item can ask the same question `nextPending()` asked, rather
 * than re-listing the statuses and drifting from them.
 */
export function isActiveStatus(status: CaptureStatus): boolean {
  return (ACTIVE_CAPTURE_STATUSES as readonly CaptureStatus[]).includes(status);
}

/**
 * Statuses the relay will not act on again unattended. `transcribed` is here
 * because the relay is done with the item — the session owns extraction
 * and write. `dead` is terminal; `discarded` is a human decision.
 */
export const FINISHED_CAPTURE_STATUSES = [
  "transcribed",
  "dead",
  "discarded",
] as const satisfies readonly CaptureStatus[];

/**
 * In-flight capture. Its own category because it is neither: the relay must not
 * act on it (there is no committed audio yet), and it is plainly not finished.
 */
export const RECORDING_CAPTURE_STATUSES = ["recording"] as const;

/**
 * The persisted shape of one outbox item — exactly the fields that live
 * in IndexedDB, and nothing else.
 *
 * This is a **trust boundary** in both directions (AGENTS.md §4): documents that
 * come back out of IndexedDB were written by an older build of this code, or by
 * a tab running a different version, so they are parsed rather than cast — and
 * documents going in are parsed too, so a bug surfaces at the write rather than
 * three reloads later.
 *
 * Pinned field-for-field against {@link captureRxSchema} by `schema.test.ts`.
 * Anything added here must be added there, and vice versa.
 *
 * **Session-level fields moved to `session-schema.ts` in v6** (extracted,
 * extractedBy, reviewOutcome, writeResult, writtenInstances, idempotencyKey).
 * The item keeps capture and transcription; the session owns everything
 * downstream.
 */
export const captureDocumentSchema = z
  .strictObject({
    /** Stable id, and the RxDB primary key. */
    id: z.string().min(1),
    /**
     * Monotonic ordering key. The relay processes the lowest-`seq` **active**
     * item first, which preserves capture order for transcription.
     */
    seq: z.number().int().nonnegative(),
    status: z.enum(CAPTURE_STATUSES),
    /**
     * The session this item belongs to. Required — every item is
     * enqueued into a session. The session owns extraction, review and write
     * state; the item is capture + transcription only.
     */
    sessionId: z.string().min(1),
    /**
     * How many times transcription has failed for this item. Drives the
     * backoff curve and, against `RelayOptions.maxAttempts`, when the relay
     * gives up and calls it `dead`.
     */
    attempts: z.number().int().nonnegative(),
    /**
     * Earliest ISO timestamp at which this item may be attempted again.
     * Persisted rather than held in a timer so the backoff schedule survives a
     * reload — on iOS the tab is the only execution context there is, and it
     * dies often.
     */
    nextAttemptAt: z.iso.datetime(),
    /** When the item entered the queue. */
    enqueuedAt: z.iso.datetime(),
    /** Message from the most recent failure, for the "needs attention" UI. */
    lastError: z.string().optional(),
    /**
     * Capture metadata — the audio branch (`Recording`) or the document branch
     * (`DocumentCapture`), discriminated by `kind`. The bytes live in the
     * attachment, not here.
     *
     * The key stays `recording` even though it now holds either kind, for the
     * same reason `Transcript.recordingId` stays: it is persisted on the v6
     * collection, and a slightly narrow key name is a far better trade than a
     * migration. The name that would fit — `capture` — is already taken by the
     * durable-capture identity on the same document.
     */
    recording: basePayloadSchema,
    /**
     * Step output — present once transcription has succeeded.
     *
     * **Write it with {@link Storage.writeTranscript}, never with `patch`.** `transcript` is still
     * reachable through {@link CapturePatch} — it has to be, because the relay's retry path patches
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
     * **Not patchable** — see {@link CapturePatch}. Written through
     * `Storage.writePreviewTail` and `Storage.commitPreview`, and deleted in the
     * same `incrementalModify` that writes `transcript`.
     */
    preview: z
      .strictObject({ committed: z.array(z.string()), tail: z.string().optional() })
      .optional(),
    /**
     * Migration-only carrier for the v5 session-level fields
     * (`extracted`, `reviewOutcome`, `writeResult`, …), set by the v6 *expand*
     * migration and consumed by `backfillSessions`, which clears it once the
     * session holds the data. Present only between those two steps; nothing in
     * current code writes it.
     *
     * Deliberately an unvalidated bag: it holds data that was already validated
     * under the v5 schema, and re-asserting a shape we are about to drop would
     * turn a stale field into an open failure.
     */
    legacy: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((doc, ctx) => {
    if (doc.status === "recording" && !doc.capture) {
      ctx.addIssue({ code: "custom", message: "a recording row must carry capture" });
    }
  });

/** Inferred from {@link captureDocumentSchema} — never hand-declared alongside it. */
export type CaptureDocument = z.infer<typeof captureDocumentSchema>;

/**
 * The fields of the projection that are **derived from the attachment store**
 * rather than read out of the document.
 *
 * Named as a constant because two tests depend on the exact set: the drift
 * guard that pins {@link captureDocumentSchema} against {@link captureRxSchema}
 * (these keys must be absent from the RxDB schema — they are never persisted)
 * and the one that pins {@link captureSchema} against the document schema
 * (these keys, and only these, are the difference).
 */
export const DERIVED_CAPTURE_KEYS = ["audioBytes", "audioReady"] as const;

/**
 * What a *consumer* sees: the persisted document plus the attachment facts.
 * Same projection as before the split — the recording still carries audio.
 */
export const captureSchema = captureDocumentSchema.extend({
  /** Whether the `AUDIO_ATTACHMENT_ID` attachment exists **right now**. */
  audioReady: z.boolean(),
  /** Durable bytes on disk for this item: the canonical attachment, or the
   * accumulated chunks while still recording. `0` when there are neither. */
  audioBytes: z.number().int().nonnegative(),
});

/** Inferred from {@link captureSchema} — never hand-declared alongside it. */
export type Capture = z.infer<typeof captureSchema>;

/**
 * The fields a caller may change after enqueue.
 *
 * `id`, `seq`, `enqueuedAt`, `recording`, `sessionId` and `capture` are
 * deliberately absent: they are decided once and re-deciding any of them would
 * break ordering, provenance, session membership or idempotency.
 *
 * `preview` is absent because it is written only through
 * `Storage.writePreviewTail` / `Storage.commitPreview` and deleted only in the
 * same `incrementalModify` that writes `transcript`.
 */
export type CapturePatch = Partial<
  Omit<
    CaptureDocument,
    "id" | "seq" | "enqueuedAt" | "recording" | "sessionId" | "capture" | "preview"
  >
>;
