import { addRxPlugin, createRxDatabase, removeRxDatabase } from "rxdb";
import type { RxCollection, RxDatabase, RxStorage } from "rxdb";
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
 * create documents in another collection. So the session-level fields are
 * stashed in a module-level Map ({@link MIGRATED_SESSION_DATA}) keyed by a
 * deterministic session id derived from `recording.ctx.assessmentId`. The
 * post-migration step in {@link openOutboxDatabase} reads the Map and creates
 * session documents, then patches each recording's `sessionId` from the
 * placeholder to the real value.
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
/**
 * Session-level fields stashed by the v6 migration strategy for the
 * post-migration step to create session documents from.
 *
 * RxDB migration strategies cannot write to other collections, so the v6
 * strategy stashes `extracted`, `extractedBy`, `reviewOutcome`, `writeResult`,
 * `writtenInstances` and `idempotencyKey` here, keyed by a deterministic
 * session id derived from `recording.ctx.assessmentId`. After
 * `addCollections` completes (which runs the migration), the post-migration
 * step in {@link openOutboxDatabase} reads this Map, creates session documents,
 * and patches each recording's `sessionId` from the placeholder to the real
 * value. The Map is cleared after the post-migration step runs.
 */
interface MigratedSessionData {
  extracted?: Record<string, unknown>;
  extractedBy?: string;
  reviewOutcome?: PersistedReviewOutcome;
  writeResult?: Record<string, unknown>;
  writtenInstances?: Record<string, boolean[]>;
  idempotencyKey: string;
  recordingIds: string[];
}

export const MIGRATED_SESSION_DATA = new Map<string, MigratedSessionData>();

/**
 * Derive a deterministic session id from the recording's `ctx.assessmentId`.
 * Recordings with no `assessmentId` get a singleton session.
 */
function migratedSessionId(ctx: unknown): string {
  if (typeof ctx === "object" && ctx !== null && "assessmentId" in ctx) {
    const assessmentId = (ctx as Record<string, unknown>).assessmentId;
    if (typeof assessmentId === "string" && assessmentId.length > 0) {
      return `migrated-session-${assessmentId}`;
    }
  }
  // Recordings with no assessmentId share one singleton session per outbox.
  // A deterministic id (not a random UUID) so multiple recordings with no
  // assessmentId in the same outbox land in the same session.
  return `migrated-session-singleton`;
}

export const OUTBOX_MIGRATION_STRATEGIES = {
  1: (doc: OutboxDocument) => doc,
  2: (doc: OutboxDocument) => doc,
  3: (doc: OutboxDocument) => doc,
  4: (doc: OutboxDocument) => doc,
  5: (doc: OutboxDocument) => doc,
  6: (doc: Record<string, unknown>) => {
    // v5 → v6: session entity split. Stash the session-level fields for the
    // post-migration step, then drop them from the recording document.
    const sessionId = migratedSessionId(doc.recording);

    const existing = MIGRATED_SESSION_DATA.get(sessionId);
    if (existing) {
      existing.recordingIds.push(doc.id as string);
    } else {
      MIGRATED_SESSION_DATA.set(sessionId, {
        extracted: doc.extracted as Record<string, unknown> | undefined,
        extractedBy: doc.extractedBy as string | undefined,
        reviewOutcome: doc.reviewOutcome as PersistedReviewOutcome | undefined,
        writeResult: doc.writeResult as Record<string, unknown> | undefined,
        writtenInstances: doc.writtenInstances as Record<string, boolean[]> | undefined,
        idempotencyKey: (doc.idempotencyKey as string) ?? crypto.randomUUID(),
        recordingIds: [doc.id as string],
      });
    }

    const next: Record<string, unknown> = { ...doc };
    delete next.extracted;
    delete next.extractedBy;
    delete next.reviewOutcome;
    delete next.writeResult;
    delete next.writtenInstances;
    delete next.idempotencyKey;
    // Map the old statuses to the new recording-only statuses.
    const oldStatus = next.status as string;
    if (
      oldStatus === "extracting" ||
      oldStatus === "awaiting-review" ||
      oldStatus === "writing" ||
      oldStatus === "done"
    ) {
      next.status = "transcribed";
    }
    // Placeholder — the post-migration step replaces it with the real session id.
    next.sessionId = sessionId;
    return next as OutboxDocument;
  },
};

export type { MigratedSessionData };

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

  // Post-migration: create session documents from the stashed v5 data.
  // The v6 migration strategy stashed session-level fields in
  // MIGRATED_SESSION_DATA; now that both collections are open, create the
  // session documents and the recordings already carry the right sessionId.
  if (MIGRATED_SESSION_DATA.size > 0) {
    const sessionsCollection = database.collections.sessions;
    const nowIso = new Date().toISOString();
    for (const [sessionId, data] of MIGRATED_SESSION_DATA) {
      // Determine the session status from the stashed data:
      // - If reviewOutcome is present and writeResult is present → done
      // - If reviewOutcome is present but no writeResult → writing
      // - If extracted is present but no reviewOutcome → awaiting-review
      // - Otherwise → open (or done if all recordings are transcribed)
      const hasExtracted = data.extracted !== undefined;
      const hasReview = data.reviewOutcome !== undefined;
      const hasWrite = data.writeResult !== undefined;
      const status = hasWrite
        ? "done"
        : hasReview
          ? "writing"
          : hasExtracted
            ? "awaiting-review"
            : "done"; // no extraction — nothing to do
      await sessionsCollection.insert({
        id: sessionId,
        status,
        openedAt: nowIso,
        ...(status !== "done" ? {} : { closedAt: nowIso }),
        attempts: 0,
        nextAttemptAt: nowIso,
        idempotencyKey: data.idempotencyKey,
        ...(data.extracted !== undefined ? { extracted: data.extracted } : {}),
        ...(data.extractedBy !== undefined ? { extractedBy: data.extractedBy } : {}),
        ...(data.extracted !== undefined
          ? { extractedFromRecordingIds: data.recordingIds.sort() }
          : {}),
        ...(data.reviewOutcome !== undefined ? { reviewOutcome: data.reviewOutcome } : {}),
        ...(data.writeResult !== undefined ? { writeResult: data.writeResult } : {}),
        ...(data.writtenInstances !== undefined ? { writtenInstances: data.writtenInstances } : {}),
      } as SessionDocument);
    }
    MIGRATED_SESSION_DATA.clear();
  }

  return database;
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
