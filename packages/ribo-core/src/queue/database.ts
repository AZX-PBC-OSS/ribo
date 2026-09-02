import { addRxPlugin, createRxDatabase, removeRxDatabase } from "rxdb";
import type { RxCollection, RxDatabase, RxDocument, RxStorage } from "rxdb";
import { RxDBAttachmentsPlugin } from "rxdb/plugins/attachments";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";

import {
  SESSION_COLLECTION_NAME,
  sessionRxSchema,
  type SessionDocument,
} from "./session-schema.js";
import { OUTBOX_COLLECTION_NAME, outboxRxSchema, type OutboxDocument } from "./schema.js";
import type { PersistedReviewOutcome } from "../review.js";

/**
 * The RxDB collection holding the outbox documents.
 *
 * Parameterised by `OutboxDocument` — what is *stored* — not by `OutboxItem`,
 * which is the projection consumers see and carries two fields derived from the
 * attachment store rather than from the document.
 */
export type OutboxCollection = RxCollection<OutboxDocument>;

/**
 * The RxDB collection holding session documents.
 *
 * Parameterised by `SessionDocument` — the persisted shape, not `SessionItem`
 * (which is the same today, but the split mirrors the recording's
 * document/item pair so a future derived field has a place to land).
 */
export type SessionCollection = RxCollection<SessionDocument>;

/** The RxDB database this package owns. Two collections: recordings and sessions. */
export type OutboxDatabase = RxDatabase<{ outbox: OutboxCollection; sessions: SessionCollection }>;

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
function legacyOf(doc: OutboxDocument): LegacySessionFields | undefined {
  return doc.legacy as LegacySessionFields | undefined;
}

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
export function migratedSessionId(ctx: unknown): string {
  if (typeof ctx === "object" && ctx !== null && "assessmentId" in ctx) {
    const assessmentId = (ctx as Record<string, unknown>).assessmentId;
    if (typeof assessmentId === "string" && assessmentId.length > 0) {
      return `migrated-session-${assessmentId}`;
    }
  }
  // Recordings with no assessmentId share one singleton session per outbox.
  return `migrated-session-singleton`;
}

/**
 * Derive a `ref` from the recording's `ctx.assessmentId`, with the same
 * singleton fallback {@link migratedSessionId} uses. This is the same recovery
 * the relay used to do on every write — done once at migration time instead.
 */
/**
 * The write destination for a migrated session, or an empty object when the
 * recording carried none.
 *
 * `sessionRxSchema` types `ctx` as an object and lists it as required, so a
 * minted session whose `ctx` is `undefined` or a primitive is rejected at
 * insert — and that insert happens inside `openOutboxDatabase`, so the failure
 * is a device that will not open its own outbox. An empty object keeps the
 * failure where it belongs: the write step parses `ctx` through the adapter's
 * `ctxSchema`, refuses it terminally, and the session goes `dead` with an error
 * a human can read. That is what the same recording did before the session
 * owned its destination.
 */
function migratedCtx(ctx: unknown): Record<string, unknown> {
  return typeof ctx === "object" && ctx !== null ? (ctx as Record<string, unknown>) : {};
}

function migratedSessionRef(ctx: unknown): string {
  if (typeof ctx === "object" && ctx !== null && "assessmentId" in ctx) {
    const assessmentId = (ctx as Record<string, unknown>).assessmentId;
    if (typeof assessmentId === "string" && assessmentId.length > 0) {
      return assessmentId;
    }
  }
  return "migrated-session-singleton";
}

/** v5 recording statuses that the session, not the recording, now owns. */
const V5_SESSION_OWNED_STATUSES = new Set(["extracting", "awaiting-review", "writing", "done"]);

/**
 * Schema-migration strategies for the outbox collection, keyed by the schema
 * version being migrated *to*.
 *
 * v0 → v1 added the optional `reviewOutcome` field (the review gate). An absent
 * optional field needs no transformation, so the strategy is identity — but it
 * is declared and exercised rather than skipped, so the migration path exists
 * before a non-trivial one needs it. Nothing is published and there are no
 * users, so no deployed data is at risk here.
 *
 * v1 → v2 added `capture` (optional) — identity, since an absent optional field
 * needs no transformation. Revision 9 removed `canonicalAttachmentId` and
 * `step`, so the strategy no longer populates anything.
 *
 * v2 → v3 added `preview` (optional) — identity, for the same reason: an absent
 * optional field needs no transformation. `preview` is written only by
 * `Outbox.writePreviewTail` / `Outbox.commitPreview` and deleted only by
 * `Outbox.writeTranscript`, so pre-v3 documents simply have no preview, which is
 * the correct state for a recording that was captured before live transcription
 * existed.
 *
 * v3 → v4 added `extractedBy` (optional) — identity, same reasoning again: an
 * absent optional field needs no transformation. It records which engine produced
 * `extracted`, and a document written before on-device extraction existed has no
 * engine to name, which is the correct state for it. Nothing reads `extractedBy`
 * to decide behaviour — it is a trust signal shown at review — so its absence
 * degrades a badge, not the state machine.
 *
 * v4 → v5 added `writtenInstances` (optional) — identity, same reasoning again.
 * A document written before per-instance resumability existed has no per-instance
 * progress, which is the correct state for it: the next write attempt will treat
 * every collection instance as unwritten.
 *
 * v5 → v6 is the **session entity split**. The recording document loses
 * `extracted`, `extractedBy`, `reviewOutcome`, `writeResult`, `writtenInstances`
 * and `idempotencyKey` (those move to the session document), and gains
 * `sessionId` (required — every recording belongs to a session). The recording
 * state machine narrows to capture + transcription: `extracting`, `awaiting-review`,
 * `writing` and `done` are gone; `transcribed` is new.
 *
 * RxDB migration strategies run per-document within a collection and cannot
 * create documents in another collection. The split is therefore done as
 * **expand/contract**, the standard way to divide one entity into two:
 *
 * - **v6 (expand)** — this strategy. Purely per-document and purely additive:
 *   the recording gains `sessionId`, its status is remapped, and the six
 *   session-level fields are moved *sideways* into a `legacy` bag rather than
 *   deleted. Nothing is discarded before it has been copied.
 * - **backfill** — {@link backfillSessions}, run once both collections are
 *   open. It groups the migrated recordings by `sessionId` and upserts one
 *   session per group.
 * - **contract** — the same backfill clears each `legacy` bag once its session
 *   exists. v6 has not been deployed, so the carrier never has to outlive the
 *   step that consumes it and no second schema version is needed.
 *
 * **Why not accumulate across documents in module scope?** Since RxDB 15 the
 * migration runs through the replication protocol and resumes from a
 * checkpoint, so an interrupted migration re-enters with only the documents it
 * had not reached. A checkpoint survives a page reload; module state does not.
 * A cross-document `Map` therefore loses every row migrated before the
 * interruption, and the rows it lost already carry a `sessionId` pointing at a
 * session that will now never be created. Each step above is instead safe to
 * run twice, which is the only property that survives a resumed migration.
 *
 * `attempts` and `nextAttemptAt` are preserved for transcription retry.
 *
 * Note this entry is not optional bookkeeping: RxDB calls into the migration
 * plugin for every version above 0, and a bumped schema with no strategy for the
 * new version makes the outbox **fail to open**, not fail to migrate. The error
 * arrives at open time and does not mention migrations.
 *
 * Exported (rather than inlined into `addCollections`) so a test can exercise
 * the strategy function directly, independent of a real migration run.
 */
export const OUTBOX_MIGRATION_STRATEGIES = {
  1: (doc: OutboxDocument) => doc,
  2: (doc: OutboxDocument) => doc,
  3: (doc: OutboxDocument) => doc,
  4: (doc: OutboxDocument) => doc,
  5: (doc: OutboxDocument) => doc,
  6: (doc: Record<string, unknown>) => {
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
    // parameter is `unknown`, so nothing failed; the outbox simply grouped
    // wrongly and silently.
    next.sessionId = migratedSessionId((doc.recording as { ctx?: unknown } | undefined)?.ctx);
    return next as OutboxDocument;
  },
};

/**
 * Default IndexedDB database name.
 *
 * Namespaced because the host app owns the origin and we are a library living in
 * it — an unprefixed `outbox` would be a genuine collision risk.
 */
export const DEFAULT_OUTBOX_DATABASE_NAME = "ribo-outbox";

let pluginsRegistered = false;

/**
 * RxDB plugins are process-global, and re-adding one is a no-op RxDB is happy to
 * warn about. Registering lazily here keeps the side effect out of module scope,
 * which matters because `@azx/ribo-core` is `sideEffects: false` — an
 * `addRxPlugin` at import time is exactly the kind of thing a bundler is entitled
 * to drop.
 */
function registerPlugins(): void {
  if (pluginsRegistered) return;
  addRxPlugin(RxDBAttachmentsPlugin);
  // Required from schema version 1 onward. RxDB calls into the migration plugin
  // during `addCollections` whenever a collection's schema version is above 0
  // (`autoMigrate` defaults to true), so without this the outbox fails to OPEN —
  // the error arrives at open time and says nothing about migrations.
  addRxPlugin(RxDBMigrationSchemaPlugin);
  pluginsRegistered = true;
}

/**
 * The default `RxStorage`: the free, open-source Dexie one — IndexedDB
 * underneath, so it works on the whole device matrix including iOS Safari
 * (`09 §"Storage adapter"`).
 *
 * It ships **inside** rxdb as `rxdb/plugins/storage-dexie`; rxdb declares `dexie`
 * as its own dependency. Adding a top-level `dexie` dependency to get at it would
 * put two Dexie instances over one IndexedDB database, which is a data-corruption
 * bug, not a duplication annoyance.
 *
 * This is only the *default*. A host can inject another `RxStorage` — memory for
 * tests (`rxdb/plugins/storage-memory`), a React-Native/SQLite storage the day
 * the field app leaves the browser — via the `storage` argument threaded down
 * from `openOutbox`. The default is a factory rather than a shared instance so
 * each database gets its own, matching the pre-injection behaviour exactly.
 */
function defaultStorage(): RxStorage<unknown, unknown> {
  return getRxStorageDexie();
}

/**
 * Open (or create) the outbox database.
 *
 * Every call builds a genuinely fresh `RxDatabase` over the named storage. With
 * the default Dexie storage that is a named IndexedDB database, which is what
 * makes the durability tests meaningful: close one, open another, and nothing
 * but IndexedDB carries state between them.
 *
 * `storage` defaults to Dexie so every existing caller is unchanged; it is
 * evaluated lazily (default-argument, not module scope) so a caller that injects
 * its own engine never even constructs a Dexie storage.
 */
export async function openOutboxDatabase(
  name: string = DEFAULT_OUTBOX_DATABASE_NAME,
  storage: RxStorage<unknown, unknown> = defaultStorage(),
): Promise<OutboxDatabase> {
  registerPlugins();
  const database = await createRxDatabase<{
    outbox: OutboxCollection;
    sessions: SessionCollection;
  }>({
    name,
    storage,
    // Leave RxDB's cross-tab machinery on. The field app is a browser app and a
    // user with two tabs open must not get two relays racing the same document;
    // multi-instance mode is what gives us leader election later.
    multiInstance: true,
    eventReduce: true,
    // Audio attachments are the bulk of what this database holds, and a document
    // revision is dead the moment its successor is written. Without a cleanup
    // policy the old revisions accumulate against the iOS quota.
    cleanupPolicy: {},
  });
  await database.addCollections({
    [OUTBOX_COLLECTION_NAME]: {
      schema: outboxRxSchema,
      migrationStrategies: OUTBOX_MIGRATION_STRATEGIES,
    },
    [SESSION_COLLECTION_NAME]: {
      schema: sessionRxSchema,
    },
  });

  await backfillSessions(database);

  return database;
}

/**
 * Create the session documents the v6 migration's `legacy` bags imply.
 *
 * The **backfill** half of expand/contract. Runs after `addCollections`, so both
 * collections are open and this is ordinary application code rather than
 * anything RxDB has an opinion about.
 *
 * Idempotent, and that is the whole design. A session is created only if one
 * does not already exist under its deterministic id, so this may run on every
 * open, after a half-finished migration, or twice in a race, and converge on the
 * same result: a group whose session already exists is left alone, and clearing
 * an already-cleared carrier is a no-op.
 *
 * Because it groups whole sessions rather than folding one document at a time,
 * it can do three things a per-document migration structurally cannot:
 *
 * 1. **Find the extraction wherever it is.** v5 extracted per recording, so the
 *    auditor's cached work may sit on any of them — not necessarily the first
 *    one the migration happens to visit.
 * 2. **Derive status from every recording**, so "no extraction because the
 *    recordings are still queued" (→ `open`, work preserved) is distinguishable
 *    from "no extraction because every recording was discarded" (→ `done`,
 *    genuinely finished). A per-document fold sees one row and cannot tell.
 * 3. **Record honest provenance.** `extractedFromRecordingIds` names only the
 *    recording that actually produced the extraction, never the whole set. A
 *    salvaged v5 extraction came from one recording's transcript and a
 *    session-wide one joins them all, so the two are not interchangeable and the
 *    field should not claim otherwise. Note this does not yet *cause* anything:
 *    `recordingSetChanged` is the check that would act on it and nothing calls
 *    it, so a migrated session keeps its salvaged extraction until the reopen
 *    path is wired. The field is honest now so that path is correct when it is.
 */
export async function backfillSessions(database: OutboxDatabase): Promise<void> {
  const recordings = await database.collections.outbox.find().exec();
  if (recordings.length === 0) return;

  const groups = new Map<string, RxDocument<OutboxDocument>[]>();
  for (const doc of recordings) {
    // Only migrated rows carry a legacy bag. A recording enqueued by current
    // code already has a real session and must not be swept into a synthetic one.
    if (legacyOf(doc.toJSON() as OutboxDocument) === undefined) continue;
    const { sessionId } = doc;
    const group = groups.get(sessionId);
    if (group) group.push(doc);
    else groups.set(sessionId, [doc]);
  }

  for (const [sessionId, group] of groups) {
    const data = group.map((doc) => doc.toJSON() as OutboxDocument);
    // The idempotency hinge. A crash between the insert below and the clear that
    // follows it leaves the carriers in place with the session already built, so
    // the next open finds this group again — and must leave it alone rather than
    // colliding on the primary key.
    const existing = await database.collections.sessions.findOne(sessionId).exec();
    if (!existing) {
      await database.collections.sessions.insert(sessionDocumentFromMigratedGroup(sessionId, data));
    }
    // Contract, folded into the same step. v6 is not deployed, so the carrier
    // never has to outlive the backfill that consumes it and no second schema
    // version is needed to tidy it away. Ordered strictly after the session
    // exists: the session is built from the whole group before anything is
    // cleared, so losing this write costs only tidiness, never data.
    for (const doc of group) {
      await doc.incrementalModify((current) => {
        const next = { ...current };
        delete (next as { legacy?: unknown }).legacy;
        return next;
      });
    }
  }
}

/** Build one session document from every recording that migrated into it. */
function sessionDocumentFromMigratedGroup(
  sessionId: string,
  group: readonly OutboxDocument[],
): SessionDocument {
  const bagOf = (doc: OutboxDocument): LegacySessionFields => legacyOf(doc) ?? {};
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
    // from the `assessmentId` `migratedSessionId` already extracts.
    //
    // `migratedCtx` rather than the raw value, because a v5 recording is not
    // guaranteed to carry one. `Recording["ctx"]` is `unknown`, and zod's
    // `strictObject` rejects a MISSING key while accepting an explicit
    // `undefined` — so `ctx: undefined` was legal to enqueue, and JSON storage
    // then drops the key entirely. Minting a session from such a recording with
    // no `ctx` produces a document `sessionRxSchema` refuses at insert, which
    // rejects `openOutboxDatabase` on every launch: an un-bootable app, not a
    // degraded one. Substituting an empty object reproduces exactly what that
    // recording did before this change — the write step's `ctxSchema.safeParse`
    // refuses it, the session goes `dead`, and the rest of the outbox works.
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
  } as SessionDocument;
}

/**
 * Delete the named database from IndexedDB entirely, attachments included.
 *
 * Exists for tests and for the "wiped outbox" recovery path in `09 §iOS`, not as
 * routine housekeeping. The database must be closed first.
 *
 * `storage` must match the one the database was opened with — RxDB's
 * `removeRxDatabase` deletes through the storage engine's own layout, so a
 * memory-opened database cannot be removed via Dexie and vice versa. It defaults
 * to Dexie for symmetry with {@link openOutboxDatabase}.
 */
export async function removeOutboxDatabase(
  name: string = DEFAULT_OUTBOX_DATABASE_NAME,
  storage: RxStorage<unknown, unknown> = defaultStorage(),
): Promise<void> {
  registerPlugins();
  await removeRxDatabase(name, storage);
}
