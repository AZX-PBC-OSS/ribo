import { addRxPlugin, createRxDatabase, removeRxDatabase } from "rxdb";
import type { RxCollection, RxDatabase, RxStorage } from "rxdb";
import { RxDBAttachmentsPlugin } from "rxdb/plugins/attachments";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";

import {
  CAPTURES_COLLECTION_NAME,
  CAPTURE_DOCUMENT_UPGRADES,
  PLUGIN_STORAGE_COLLECTION_NAME,
  SESSION_COLLECTION_NAME,
  backfillSessions,
} from "@azx/ribo-core";
import type { CaptureDocument, PluginStorageDocument, SessionDocument } from "@azx/ribo-core";

import { createRxdbBackend } from "./backend.js";
import { toMigrationStrategies } from "./migration-strategies.js";

import {
  PLUGIN_STORAGE_MIGRATION_STRATEGIES,
  SESSION_MIGRATION_STRATEGIES,
  captureRxSchema,
  pluginStorageRxSchema,
  sessionRxSchema,
} from "./schemas.js";

/**
 * The RxDB collection holding the storage documents.
 *
 * Parameterised by `CaptureDocument` — what is *stored* — not by `Capture`,
 * which is the projection consumers see and carries two fields derived from the
 * attachment store rather than from the document.
 * @category Offline & Storage
 */
export type OutboxCollection = RxCollection<CaptureDocument>;

/**
 * The RxDB collection holding session documents.
 *
 * Parameterised by `SessionDocument` — the persisted shape, not `SessionItem`
 * (which is the same today, but the split mirrors the recording's
 * document/item pair so a future derived field has a place to land).
 * @category Offline & Storage
 */
export type SessionCollection = RxCollection<SessionDocument>;

/**
 * The RxDB collection holding plugin-scoped storage entries — key-value pairs
 * namespaced by plugin id and capture id. Core sweeps entries for a capture
 * when it is dropped or discarded; see `storage.scopedStore`.
 * @category Offline & Storage
 */
export type PluginStorageCollection = RxCollection<PluginStorageDocument>;

/**
 * The RxDB database this package owns. Three collections: recordings, sessions and plugin storage.
 *
 * @category Offline & Storage
 */
export type OutboxDatabase = RxDatabase<{
  outbox: OutboxCollection;
  sessions: SessionCollection;
  pluginStorage: PluginStorageCollection;
}>;

/**
 * Schema-migration strategies for the storage collection, keyed by the schema
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
 * `Storage.writePreviewTail` / `Storage.commitPreview` and deleted only by
 * `storage.captures.writeTranscript`, so pre-v3 documents simply have no preview, which is
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
 * v6 → v7 adds an optional `annotations` field to the `transcript` sub-object,
 * so a transcriber can contribute structured data (page boundaries, table
 * structure) alongside the text. The field is optional and absent on existing
 * documents, so the strategy is identity — the same reasoning as strategies 1
 * through 5: an absent optional field needs no transformation.
 *
 * **The bump is not needed to read the new field, and that is worth stating plainly** because the
 * obvious justification is circular. `transcript` is `{ type: "object" }` in the RxDB schema, so
 * RxDB neither validates nor indexes its interior; the stored schema is otherwise unchanged, and
 * annotations round-trip through a close and reopen at version 6 with no strategy at all
 * (measured, by reverting the bump and running the round-trip test).
 *
 * What the bump buys is a clean failure on DOWNGRADE. `transcriptSchema` is a `z.strictObject`,
 * so old code reading a document written by new code rejects it for the unknown key — and without
 * a version bump RxDB opens the collection happily and that rejection surfaces deep in the
 * application, on a recording the user can see. At version 7, old code refuses at `addCollections`
 * with a version mismatch instead. A stale cached bundle or a rolled-back deploy is an ordinary
 * event for a browser SDK, so the trade is a per-document identity pass now against a legible
 * failure then.
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
 * new version makes the storage **fail to open**, not fail to migrate. The error
 * arrives at open time and does not mention migrations.
 *
 * Exported (rather than inlined into `addCollections`) so a test can exercise
 * the strategy function directly, independent of a real migration run.
 * @category Offline & Storage
 */
export const CAPTURE_MIGRATION_STRATEGIES = toMigrationStrategies(CAPTURE_DOCUMENT_UPGRADES);

/**
 * Default IndexedDB database name.
 *
 * Namespaced because the host app owns the origin and we are a library living in
 * it — an unprefixed `storage` would be a genuine collision risk.
 * @category Offline & Storage
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
  // (`autoMigrate` defaults to true), so without this the storage fails to OPEN —
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
 * from `openStorage`. The default is a factory rather than a shared instance so
 * each database gets its own, matching the pre-injection behaviour exactly.
 */
function defaultStorage(): RxStorage<unknown, unknown> {
  return getRxStorageDexie();
}

/**
 * Open (or create) the storage database.
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
  options: { ignoreDuplicate?: boolean } = {},
): Promise<OutboxDatabase> {
  registerPlugins();
  const database = await createRxDatabase<{
    outbox: OutboxCollection;
    sessions: SessionCollection;
    pluginStorage: PluginStorageCollection;
  }>({
    name,
    storage,
    // Leave RxDB's cross-tab machinery on. The field app is a browser app and a
    // user with two tabs open must not get two relays racing the same document;
    // multi-instance mode is what gives us leader election later.
    multiInstance: true,
    eventReduce: true,
    // RxDB refuses a second `RxDatabase` on the same name in one JS context
    // (DB8), because its unit of "context" is the tab. That is right for
    // production and wrong for the one test that has to prove two contexts see
    // each other's writes and cannot both claim a sequence. With
    // `multiInstance` on, two instances in one tab genuinely talk over
    // BroadcastChannel and share `navigator.locks`, so this simulates two tabs
    // rather than side-stepping the check. Never set it outside a test.
    ...(options.ignoreDuplicate === true ? { ignoreDuplicate: true } : {}),
    // Audio attachments are the bulk of what this database holds, and a document
    // revision is dead the moment its successor is written. Without a cleanup
    // policy the old revisions accumulate against the iOS quota.
    cleanupPolicy: {},
  });
  await database.addCollections({
    [CAPTURES_COLLECTION_NAME]: {
      schema: captureRxSchema,
      migrationStrategies: CAPTURE_MIGRATION_STRATEGIES,
    },
    [SESSION_COLLECTION_NAME]: {
      schema: sessionRxSchema,
      migrationStrategies: SESSION_MIGRATION_STRATEGIES,
    },
    [PLUGIN_STORAGE_COLLECTION_NAME]: {
      schema: pluginStorageRxSchema,
      migrationStrategies: PLUGIN_STORAGE_MIGRATION_STRATEGIES,
    },
  });

  // The cross-collection half of the v5 → v6 migration, which the per-document
  // strategies above structurally cannot do. It lives in core and is written
  // against the port, so it runs over a backend rather than over RxDB — this
  // package supplies the backend and decides *when*, which is the whole split.
  // Safe to run unconditionally: it is a no-op on a database with no carriers.
  await backfillSessions(createRxdbBackend(database, name));

  return database;
}

/**
 * Delete the named database from IndexedDB entirely, attachments included.
 *
 * Exists for tests and for the "wiped storage" recovery path in `09 §iOS`, not as
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
