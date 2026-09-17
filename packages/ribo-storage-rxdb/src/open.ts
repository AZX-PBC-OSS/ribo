import type { RxStorage } from "rxdb";

import {
  DEFAULT_OUTBOX_DATABASE_NAME,
  openOutboxDatabase,
  type OutboxDatabase,
} from "./database.js";

import { createRxdbBackend as wrap, type RxdbStorageBackend } from "./backend.js";

/**
 * @file Opening the database, and the two ways to get a backend.
 *
 * The database-opening code still lives in `@azx/ribo-core` while its `Outbox`
 * class is the thing that uses it. It moves here — schemas, migration
 * strategies, `backfillSessions` and all — in the task that takes RxDB out of
 * core's dependencies, at which point this file stops delegating and owns it.
 * Deliberately not duplicated in the meantime: two copies of a migration
 * strategy is exactly the kind of drift that strands a device.
 */

export { createRxdbBackend, type RxdbStorageBackend } from "./backend.js";

/** Options for {@link openRxdbBackend}. */
export interface OpenRxdbBackendOptions {
  /** Database name. Defaults to `ribo-outbox` — the name already on disk. */
  name?: string;
  /**
   * The `RxStorage` to persist to. Defaults to Dexie (IndexedDB), which is what
   * works across the whole device matrix including iOS Safari.
   *
   * Still the right seam for swapping engines — memory for a browser test, a
   * React-Native/SQLite storage later — but it now sits *inside* a backend
   * rather than leaking through core's public API.
   */
  storage?: RxStorage<unknown, unknown>;
  /**
   * Allow a second backend on the same database name in this JS context.
   *
   * **Tests only.** RxDB refuses this by default (DB8) because its unit of
   * context is the tab, and that default is correct for production. The
   * conformance kit needs two contexts on one database to prove they observe
   * each other and cannot both claim a sequence; with `multiInstance` on, two
   * instances in one tab really do communicate over BroadcastChannel and share
   * `navigator.locks`, so this simulates two tabs faithfully.
   */
  ignoreDuplicate?: boolean;
}

/**
 * Open the durable database and return a storage backend over it.
 *
 * The batteries-included path: one call, Dexie already wired.
 */
export async function openRxdbBackend(
  options: OpenRxdbBackendOptions = {},
): Promise<RxdbStorageBackend> {
  const name = options.name ?? DEFAULT_OUTBOX_DATABASE_NAME;
  const database: OutboxDatabase = await openOutboxDatabase(name, options.storage, {
    ignoreDuplicate: options.ignoreDuplicate,
  });
  return wrap(database, name);
}
