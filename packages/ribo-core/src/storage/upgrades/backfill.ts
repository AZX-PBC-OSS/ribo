/**
 * @file The v5 → v6 migration's cross-collection half.
 *
 * The ladder carries what a migration can say about one document at a time.
 * This is the rest of it, and the reason the rung in `v5-to-v6.ts` is only half
 * a migration: turning a set of v5 recordings into sessions means grouping them,
 * deciding one status from the whole group, and writing into a *different*
 * collection. A per-document function structurally cannot do any of that, which
 * is why the original was split expand/contract in the first place.
 *
 * It lives in core, written against `StorageBackend`, because it needs exactly
 * four port operations and nothing else — find, get, insert, modify. A backend
 * applies the rungs with whatever its engine provides, then calls this. It owns
 * when; core owns what.
 *
 * Relocated from `@azx/ribo-storage-rxdb`, where the RxDB types were the only
 * thing backend-specific about it. See
 * `docs/roadmap/design/storage-migrations-design.md` §6.
 */

import type { CaptureDocument } from "../capture-schema.js";
import type { PersistedReviewOutcome } from "../../review/review.js";
import type { SessionDocument } from "../session-schema.js";
import type { StorageBackend } from "../port.js";

/**
 * The v5 session-level fields, carried on the recording document by the v6
 * migration until {@link backfillSessions} has lifted them onto a session and
 * cleared it.
 *
 * A single optional bag rather than six loose properties, so no new code can
 * accidentally read a v5 field as if it were current, and so clearing it is one
 * delete. Nothing outside migration writes this. It is persisted rather than
 * held in memory because a crash between the migration finishing and the
 * backfill running would otherwise lose the data for good.
 * @category Offline & Storage
 */
export interface LegacySessionFields {
  extracted?: Record<string, unknown>;
  extractedBy?: string;
  reviewOutcome?: PersistedReviewOutcome;
  writeResult?: Record<string, unknown>;
  writtenInstances?: Record<string, boolean[]>;
  idempotencyKey?: string;
}

/** Read the migration carrier off a recording document. */
function legacyOf(doc: CaptureDocument): LegacySessionFields | undefined {
  return doc.legacy;
}

/**
 * The write destination for a migrated session, or an empty object when the
 * recording carried none.
 *
 * `sessionRxSchema` types `ctx` as an object and lists it as required, so a
 * minted session whose `ctx` is `undefined` or a primitive is rejected at
 * insert — and that insert happens inside the backend's open, so the failure
 * is a device that will not open its own storage. An empty object keeps the
 * failure where it belongs: the write step parses `ctx` through the adapter's
 * `ctxSchema`, refuses it terminally, and the session goes `dead` with an error
 * a human can read. That is what the same recording did before the session
 * owned its destination.
 */
function migratedCtx(ctx: unknown): Record<string, unknown> {
  return typeof ctx === "object" && ctx !== null ? (ctx as Record<string, unknown>) : {};
}

/**
 * Derive a `ref` from the recording's `ctx.assessmentId`, with the same singleton
 * fallback `captureV5ToV6Upgrade`'s session id uses. This is the same recovery the
 * relay used to do on every write — done once at migration time instead.
 */
function migratedSessionRef(ctx: unknown): string {
  if (typeof ctx === "object" && ctx !== null && "assessmentId" in ctx) {
    const assessmentId = (ctx as Record<string, unknown>).assessmentId;
    if (typeof assessmentId === "string" && assessmentId.length > 0) {
      return assessmentId;
    }
  }
  return "migrated-session-singleton";
}

/** Build one session document from every recording that migrated into it. */
function sessionDocumentFromMigratedGroup(
  sessionId: string,
  group: readonly CaptureDocument[],
): SessionDocument {
  const bagOf = (doc: CaptureDocument): LegacySessionFields => legacyOf(doc) ?? {};
  const bySeq = [...group].sort((a, b) => a.seq - b.seq);

  // The extraction can be on any recording. Prefer the one the human actually
  // reviewed; failing that the most recent, which is the closest thing v5 has to
  // "the current answer".
  const withExtraction = bySeq.filter((doc) => bagOf(doc).extracted !== undefined);
  const source =
    withExtraction.find((doc) => bagOf(doc).reviewOutcome !== undefined) ??
    withExtraction[withExtraction.length - 1];

  const reviewed = bySeq.find((doc) => bagOf(doc).reviewOutcome !== undefined);
  const written = bySeq.find((doc) => bagOf(doc).writeResult !== undefined);

  const everyRecordingIsGone = bySeq.every(
    (doc) => doc.status === "discarded" || doc.status === "dead",
  );
  const status: SessionDocument["status"] = written
    ? "done"
    : reviewed
      ? "writing"
      : source
        ? "awaiting-review"
        : everyRecordingIsGone
          ? "done"
          : // Nothing extracted and recordings still live: the auditor was
            // mid-capture when they upgraded. `open` keeps the work reachable —
            // `done` is terminal, so it would transcribe and then strand, while
            // `summarizeWork` counted it as synced and told them it was safe.
            "open";

  const openedAt = bySeq[0]!.enqueuedAt;

  return {
    id: sessionId,
    status,
    openedAt,
    // The session owns its write destination. `ctx` from the first recording
    // in the group — the same recording the relay used to pick — and `ref`
    // from the `assessmentId` the session id already extracts.
    //
    // `migratedCtx` rather than the raw value, because a v5 recording is not
    // guaranteed to carry one. `Recording["ctx"]` is `unknown`, and zod's
    // `strictObject` rejects a MISSING key while accepting an explicit
    // `undefined` — so `ctx: undefined` was legal to enqueue, and JSON storage
    // then drops the key entirely. Minting a session from such a recording with
    // no `ctx` produces a document the session schema refuses at insert, which
    // rejects the backend's open on every launch: an un-bootable app, not a
    // degraded one. Substituting an empty object reproduces exactly what that
    // recording did before this change — the write step's `ctxSchema.safeParse`
    // refuses it, the session goes `dead`, and the rest of the storage works.
    ctx: migratedCtx(bySeq[0]!.recording.ctx),
    ref: migratedSessionRef(bySeq[0]!.recording.ctx),
    // A session past `open` had, by definition, stopped accepting recordings.
    ...(status === "open" ? {} : { closedAt: bySeq[bySeq.length - 1]!.enqueuedAt }),
    attempts: 0,
    nextAttemptAt: openedAt,
    // Deterministic so a re-run cannot mint a second key for the same session.
    idempotencyKey: bagOf(bySeq[0]!).idempotencyKey ?? `migrated-${sessionId}`,
    ...(source ? { extracted: bagOf(source).extracted } : {}),
    ...(source && bagOf(source).extractedBy !== undefined
      ? { extractedBy: bagOf(source).extractedBy }
      : {}),
    ...(source ? { extractedFromRecordingIds: [source.id] } : {}),
    ...(reviewed ? { reviewOutcome: bagOf(reviewed).reviewOutcome } : {}),
    ...(written ? { writeResult: bagOf(written).writeResult } : {}),
  };
}

/**
 * Lift every migrated recording onto a session, then clear the carriers.
 *
 * Run this after applying the capture ladder's rungs and before handing the
 * storage to anything else. It is a no-op on a database with no migrated rows,
 * so a backend may call it unconditionally at open.
 */
export async function backfillSessions(backend: StorageBackend): Promise<void> {
  const recordings = (await backend.find("captures", {})) as CaptureDocument[];
  if (recordings.length === 0) return;

  const groups = new Map<string, CaptureDocument[]>();
  for (const doc of recordings) {
    // Only migrated rows carry a legacy bag. A recording enqueued by current
    // code already has a real session and must not be swept into a synthetic one.
    if (legacyOf(doc) === undefined) continue;
    const { sessionId } = doc;
    const group = groups.get(sessionId);
    if (group) group.push(doc);
    else groups.set(sessionId, [doc]);
  }

  for (const [sessionId, group] of groups) {
    // The idempotency hinge. A crash between the insert below and the clear that
    // follows it leaves the carriers in place with the session already built, so
    // the next open finds this group again — and must leave it alone rather than
    // colliding on the primary key.
    const existing = await backend.get("sessions", sessionId);
    if (!existing) {
      await backend.insert("sessions", sessionDocumentFromMigratedGroup(sessionId, group));
    }
    // Contract, folded into the same step. v6 is not deployed, so the carrier
    // never has to outlive the backfill that consumes it and no second schema
    // version is needed to tidy it away. Ordered strictly after the session
    // exists: the session is built from the whole group before anything is
    // cleared, so losing this write costs only tidiness, never data.
    for (const doc of group) {
      await backend.modify("captures", doc.id, (current) => {
        const next = { ...current };
        delete (next as { legacy?: unknown }).legacy;
        return next;
      });
    }
  }
}
