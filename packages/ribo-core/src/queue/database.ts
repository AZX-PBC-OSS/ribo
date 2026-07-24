import { addRxPlugin, createRxDatabase, removeRxDatabase } from "rxdb";
import type { RxCollection, RxDatabase, RxStorage } from "rxdb";
import { RxDBAttachmentsPlugin } from "rxdb/plugins/attachments";
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
    [OUTBOX_COLLECTION_NAME]: { schema: outboxRxSchema },
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
