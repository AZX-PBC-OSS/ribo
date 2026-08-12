import { addRxPlugin, createRxDatabase, removeRxDatabase } from "rxdb";
import type { RxCollection, RxDatabase, RxStorage } from "rxdb";
import { RxDBAttachmentsPlugin } from "rxdb/plugins/attachments";
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";

import { OUTBOX_COLLECTION_NAME, outboxRxSchema, type OutboxDocument } from "./schema.js";

/**
 * The RxDB collection holding the outbox documents.
 *
 * Parameterised by `OutboxDocument` — what is *stored* — not by `OutboxItem`,
 * which is the projection consumers see and carries two fields derived from the
 * attachment store rather than from the document.
 */
export type OutboxCollection = RxCollection<OutboxDocument>;

/** The RxDB database this package owns. One collection today; more later. */
export type OutboxDatabase = RxDatabase<{ outbox: OutboxCollection }>;

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
 * `Outbox.appendPreviewSegment` and deleted only by `Outbox.writeTranscript`,
 * so pre-v3 documents simply have no preview, which is the correct state for a
 * recording that was captured before live transcription existed.
 *
 * Exported (rather than inlined into `addCollections`) so a test can exercise
 * the strategy function directly, independent of a real migration run.
 */
export const OUTBOX_MIGRATION_STRATEGIES = {
  1: (doc: OutboxDocument) => doc,
  2: (doc: OutboxDocument) => doc,
  3: (doc: OutboxDocument) => doc,
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
  const database = await createRxDatabase<{ outbox: OutboxCollection }>({
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
  });
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
