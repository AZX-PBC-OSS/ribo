/**
 * @module @azx/ribo-storage-rxdb
 *
 * @file `@azx/ribo-storage-rxdb` — the RxDB implementation of ribo's storage port.
 *
 * `@azx/ribo-core` owns the contracts and every piece of domain logic; this
 * package owns the durable substrate underneath it. Nothing here knows what a
 * capture status means or which recordings belong to a session.
 *
 * Two entry points, and the difference is whether you are choosing a backend:
 *
 * - {@link openRxdbBackend} builds a backend over the Dexie storage — the
 *   batteries-included path, and what a browser host wants.
 * - {@link createRxdbBackend} wraps a database you opened yourself, for a host
 *   injecting its own `RxStorage` (memory for tests, SQLite the day the field
 *   app leaves the browser).
 *
 * The pre-wired path lives here rather than at `@azx/ribo-core/rxdb` because
 * that subpath would make core import this package, which imports core.
 */

export { createRxdbBackend, openRxdbBackend } from "./open.js";
export type { OpenRxdbBackendOptions, RxdbStorageBackend } from "./open.js";
// `backfillSessions` used to be exported here. It moved to `@azx/ribo-core`,
// where it is written against the storage port rather than against RxDB — import
// it from there and hand it a backend. `openOutboxDatabase` still runs it, so a
// host on the batteries-included path needs to do nothing.
export { openOutboxDatabase, removeOutboxDatabase } from "./database.js";
export type { OutboxDatabase } from "./database.js";
