import { z } from "zod";

import { reviewOutcomeSchema } from "../review.js";

/** The RxDB collection name for sessions. Sits beside `outbox` in the same database. */
export const SESSION_COLLECTION_NAME = "sessions";

/**
 * The session state machine:
 *
 * ```
 * open → extracting → awaiting-review → writing → done ⇄ awaiting-review (Storage.reopenSessionForReview)
 *                          ↘ (transient) → failed → (backoff) → retry
 *                          ↘ (terminal)  → dead   ⇄ awaiting-review (Storage.reopenSessionForReview)
 * ```
 *
 * A session owns extraction, review and write state for a set of captures
 * (audio or document) taken together. The outbox item's state machine
 * narrows to capture + transcription; everything downstream moves here.
 *
 * **`open` is the host's phase.** Captures are being taken and
 * transcribed. The relay transcribes the session's captures but does not
 * touch the session itself — session-level extraction waits for the host to
 * close the session (the auditor is done walking the house). This matches what
 * `jobs.ts` already does: the capture set is intentional, not inferred.
 *
 * **`awaiting-review` is the review gate, same as the outbox item's side.** Absent
 * from {@link ACTIVE_SESSION_STATUSES} so the relay drains past it;
 * `Storage.submitSessionReview` is the only way out, `Storage.reopenSessionForReview`
 * the only way back from `done` or `dead`.
 *
 * **Both `done` and `dead` have a human-driven way out.** `failed` is resting,
 * same as the outbox item's: the relay picks it back up once `nextAttemptAt`
 * has passed.
 */
export const SESSION_STATUSES = [
  "open",
  "extracting",
  "awaiting-review",
  "writing",
  "done",
  "failed",
  "dead",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * Statuses the relay will still act on for a session.
 *
 * `extracting` and `writing` are in-flight; `failed` is resting (retryable
 * after backoff). **`open` is NOT active** — the relay does not act on an open
 * session until the host closes it. **`awaiting-review` is NOT active** — the
 * review gate, same omission as the outbox item's side.
 */
export const ACTIVE_SESSION_STATUSES = [
  "extracting",
  "writing",
  "failed",
] as const satisfies readonly SessionStatus[];

/**
 * Statuses the relay will not act on again unattended. Both `done` and `dead`
 * have a human-driven way out (`Storage.reopenSessionForReview`). The constant
 * keeps its name for now — whether it still earns it, or wants renaming to
 * something like `RESTING_SESSION_STATUSES`, is an open question (see the
 * session-ownership design's §10.1), left to a follow-up so a rename does not
 * ride along with a behaviour change.
 */
export const FINISHED_SESSION_STATUSES = [
  "done",
  "dead",
] as const satisfies readonly SessionStatus[];

/**
 * The persisted shape of one session document — exactly the fields that live
 * in IndexedDB, and nothing else.
 *
 * A session owns the state the recording used to carry: `extracted`,
 * `reviewOutcome`, `writeResult` and the vendor-write `idempotencyKey`. The
 * recording keeps capture and transcription; everything downstream moves here.
 *
 * The session also owns its write destination (`ctx`) and what it is for
 * (`ref`). Both are set once at `openSession` and never patched: re-deciding
 * the destination would strand a write, and re-deciding the subject would
 * silently re-target it. `ctx` is opaque to core; `ref` is a bounded string
 * core indexes but never parses.
 *
 * Pinned field-for-field against {@link sessionRxSchema} by
 * `session-schema.test.ts`, the same seam `schema.test.ts` guards for the
 * outbox item.
 */
export const sessionDocumentSchema = z.strictObject({
  /** Stable id, and the RxDB primary key. */
  id: z.string().min(1),
  status: z.enum(SESSION_STATUSES),
  /** When the session was opened. */
  openedAt: z.iso.datetime(),
  /**
   * When the host closed the session. Absent while `status === "open"`.
   * Set by `Storage.closeSession`; a reopened session clears this.
   */
  closedAt: z.iso.datetime().optional(),
  /**
   * The write destination — opaque to core, same posture as `Recording.ctx`.
   * Authoritative for writing: the relay reads `session.ctx`, not a
   * recording's. Set once at `openSession` and never patched.
   */
  ctx: z.unknown(),
  /**
   * What the session is for — a bounded, indexed string naming the job,
   * assessment or work-order. Core never parses it; the contract is that it
   * is queryable and non-unique (two sessions may share one, for a re-audit
   * or a QA pass). Set once at `openSession` and never patched.
   */
  ref: z.string().min(1).max(128),
  /**
   * How many times a session-level step (extract or write) has failed.
   * Drives the backoff curve and, against `RelayOptions.maxAttempts`, when
   * the relay gives up and calls it `dead`. Reset to `0` on every fresh
   * entry into `awaiting-review` — same per-cycle budget as the recording's
   * `attempts`.
   */
  attempts: z.number().int().nonnegative(),
  /**
   * Earliest ISO timestamp at which this session may be attempted again.
   * Persisted so the backoff schedule survives a reload, same as the recording.
   */
  nextAttemptAt: z.iso.datetime(),
  /** Message from the most recent failure, for the "needs attention" UI. */
  lastError: z.string().optional(),
  /** Extraction output. Present once session-level extraction has succeeded. */
  extracted: z.record(z.string(), z.unknown()).optional(),
  /**
   * Which engine produced `extracted`. Absent when the extractor did not report
   * one — a trust signal for review, same as the recording's old `extractedBy`.
   */
  extractedBy: z.string().optional(),
  /**
   * What the extraction cost and which strategy produced it.
   *
   * `extractedBy` above is the *transport*; this is everything else the extractor
   * reported — the strategy that won a ladder, the call count, and the token
   * totals including prefix-cache hits. Absent when the extractor reported
   * nothing beyond the engine, which every pre-existing session is.
   *
   * Persisted rather than left with the extractor because the questions it
   * answers are asked *after* the fact, from a device nobody is watching: did
   * this draft come from the degraded tier, how many calls did it take, and is
   * the prefix cache being hit. A field app that cannot see these has to guess,
   * and a slow path selected silently is how that guessing goes wrong.
   *
   * Loose (`z.record`) for the same reason `extracted` is: one document schema
   * describes every host tool's extractor, and the typed shape lives at the
   * `ExtractionUsage` boundary rather than here.
   */
  extractionUsage: z.record(z.string(), z.unknown()).optional(),
  /**
   * The sorted recording ids whose transcripts produced `extracted`.
   * Absent before the first extraction; changes when a recording is added or
   * discarded after close, triggering a re-extraction. This is the cache key
   * that makes "I forgot the crawlspace" cheap: a reopened session re-extracts
   * only because the set changed.
   */
  extractedFromRecordingIds: z.array(z.string()).optional(),
  /**
   * What the human decided. Present once review has been submitted; absent
   * means this session has not been reviewed, which the relay treats as a
   * hard error at write time — "nothing is written that a human has not seen."
   */
  reviewOutcome: reviewOutcomeSchema.optional(),
  /** Step output — whatever the tool adapter returned from the write. */
  writeResult: z.record(z.string(), z.unknown()).optional(),
  /**
   * The vendor uuid(s) returned by `write`, keyed by instance key — the durable
   * channel a future amend reads. Not cleared on reopen (contrast with
   * `reviewOutcome`, which is).
   */
  receipts: z
    .object({
      singleton: z.string().optional(),
      instances: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    })
    .optional(),
  /**
   * Per-group verbatim spans where the roster recorded an explicit "none of
   * these," keyed by the group's own top-level key. Surfaced from
   * `scopedInstanceExtractor`'s `ExtractionResult.statedEmptyGroups` via
   * `toSessionExtractStep` and `#sessionExtract`. Absent for any extractor that
   * does not use a roster, and for sessions extracted before this field shipped.
   *
   * Set **unconditionally** on every extraction (to `undefined` when the new
   * extraction reports none), not conditionally spread like `extractedBy`/
   * `extractionUsage`: this is content about a specific transcript, not transport
   * metadata, so a re-extraction must clear a prior run's stale quote rather than
   * leave it in place. Consulted by `buildReviewRequest` to produce the
   * `"statedEmpty"` group state on the review tree.
   */
  statedEmptyGroups: z.record(z.string(), z.string()).optional(),
  /**
   * The vendor write idempotency key. Generated once at session open and reused
   * on every retry — same guarantee as the recording's old `idempotencyKey`:
   * an ambiguous success (write landed, response lost) cannot double-write.
   */
  idempotencyKey: z.string().min(1),
});

/** Inferred from {@link sessionDocumentSchema} — never hand-declared alongside it. */
export type SessionDocument = z.infer<typeof sessionDocumentSchema>;

/**
 * What a *consumer* sees. No derived fields today — the session has no
 * attachments — but the split mirrors the recording's document/item pair so a
 * future derived field (e.g. recording count) has a place to land without
 * changing every call site.
 */
export const sessionItemSchema = sessionDocumentSchema;

/** Inferred from {@link sessionItemSchema} — never hand-declared alongside it. */
export type SessionItem = z.infer<typeof sessionItemSchema>;

/**
 * The fields a caller may change after opening a session.
 *
 * `id`, `openedAt`, `idempotencyKey`, `ctx` and `ref` are deliberately absent:
 * they are decided once and re-deciding any of them would break provenance,
 * idempotency, strand a write or silently re-target it. Same reasoning as
 * `CapturePatch` on the recording side.
 */
export type SessionPatch = Partial<
  Omit<SessionDocument, "id" | "openedAt" | "idempotencyKey" | "ctx" | "ref">
>;

/**
 * The RxDB JSON schema for the sessions collection.
 *
 * Hand-written for the same reason `captureRxSchema` is: RxDB needs metadata zod
 * has no concept of — `primaryKey`, `indexes`, and the `maxLength` bounds it
 * uses to build fixed-width index keys. `session-schema.test.ts` pins the two
 * descriptions against each other so they cannot drift.
 */
