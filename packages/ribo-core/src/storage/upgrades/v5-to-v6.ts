/**
 * @file The v5 → v6 capture migration's per-document half.
 *
 * Relocated from `@azx/ribo-storage-rxdb` unchanged. It is pure domain logic —
 * which fields the session owns, which statuses it absorbs, how a recording is
 * grouped — and nothing in it knows what a database is, which is the whole
 * argument for it living here. See `docs/roadmap/design/storage-migrations-design.md` §4.
 *
 * This is only half the migration. The cross-collection half groups these rows
 * into sessions and cannot be expressed as a per-document function; it still
 * lives in the RxDB package as `backfillSessions` and moves here later.
 */

import type { PersistedReviewOutcome } from "../../review.js";

interface LegacySessionFields {
  extracted?: Record<string, unknown>;
  extractedBy?: string;
  reviewOutcome?: PersistedReviewOutcome;
  writeResult?: Record<string, unknown>;
  writtenInstances?: Record<string, boolean[]>;
  idempotencyKey?: string;
}

/** v5 recording statuses that the session, not the recording, now owns. */
const V5_SESSION_OWNED_STATUSES = new Set(["extracting", "awaiting-review", "writing", "done"]);

/**
 * Derive a deterministic session id from the recording's `ctx.assessmentId`.
 * Recordings with no `assessmentId` get a singleton session.
 *
 * Deterministic (not a random UUID) is load-bearing twice over: it is what
 * groups a job's recordings into one session, and it is what lets the backfill
 * re-run without creating a second session for work it already lifted.
 *
 * `ref` now carries the "what this session is for" meaning the id-as-
 * assessment-id trick was reaching for; the session keeps its own generated
 * id, and `ref` is the indexed query target. This function stays because its
 * output is still the session id that groups recordings together.
 */
function migratedSessionId(ctx: unknown): string {
  if (typeof ctx === "object" && ctx !== null && "assessmentId" in ctx) {
    const assessmentId = (ctx as Record<string, unknown>).assessmentId;
    if (typeof assessmentId === "string" && assessmentId.length > 0) {
      return `migrated-session-${assessmentId}`;
    }
  }
  // Recordings with no assessmentId share one singleton session per storage.
  return `migrated-session-singleton`;
}

export const captureV5ToV6Upgrade = (doc: Record<string, unknown>): Record<string, unknown> => {
  // v5 → v6, the EXPAND half of the split. Per-document, no side effects, and
  // idempotent: running it twice on the same document yields the same result,
  // which is what a checkpoint-resumed migration requires.
  const next: Record<string, unknown> = { ...doc };

  const legacy: LegacySessionFields = {};
  if (doc.extracted !== undefined) legacy.extracted = doc.extracted as Record<string, unknown>;
  if (doc.extractedBy !== undefined) legacy.extractedBy = doc.extractedBy as string;
  if (doc.reviewOutcome !== undefined)
    legacy.reviewOutcome = doc.reviewOutcome as PersistedReviewOutcome;
  if (doc.writeResult !== undefined)
    legacy.writeResult = doc.writeResult as Record<string, unknown>;
  if (doc.writtenInstances !== undefined)
    legacy.writtenInstances = doc.writtenInstances as Record<string, boolean[]>;
  if (doc.idempotencyKey !== undefined) legacy.idempotencyKey = doc.idempotencyKey as string;

  delete next.extracted;
  delete next.extractedBy;
  delete next.reviewOutcome;
  delete next.writeResult;
  delete next.writtenInstances;
  delete next.idempotencyKey;
  next.legacy = legacy;

  // The recording state machine narrows to capture + transcription. A row
  // parked in a status the session now owns has, by definition, been
  // transcribed already.
  if (V5_SESSION_OWNED_STATUSES.has(next.status as string)) next.status = "transcribed";

  // The RECORDING'S CTX, not the recording. `migratedSessionId` reads
  // `ctx.assessmentId`, and a recording has no `assessmentId` of its own —
  // handing it the whole recording made the `"assessmentId" in ctx` test
  // always false, so every row on a device fell through to the singleton and
  // one session swallowed every job the auditor had ever captured. The
  // parameter is `unknown`, so nothing failed; the storage simply grouped
  // wrongly and silently.
  next.sessionId = migratedSessionId((doc.recording as { ctx?: unknown } | undefined)?.ctx);
  return next;
};
