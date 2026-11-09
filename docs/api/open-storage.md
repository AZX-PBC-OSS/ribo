# openStorage

`openStorage({ backend })` opens the durability subsystem: a `Storage` with three stores —
`captures` (recordings, documents and their audio), `sessions` (extraction, review, write-back
state), and namespaced key-value stores a host or plugin declares. `OpenStorageOptions`,
`createMemoryBackend` and the store types live here.

## When to reach for it

Reach for this page to look up the open options and the store layout. Reach for
[Offline & Storage](/guide/offline-and-storage) for the two state machines the stores carry, and
[the StorageBackend port](/api/storage-port) if you are implementing a backend rather than
opening one over an existing one.

## Usage

<<< @/api/examples/open-storage.run.ts#usage

## Options

`openStorage(options)` takes `OpenStorageOptions`. There is **no default backend** — every
default would be wrong somewhere: `createMemoryBackend` for tests and development, and
`openRxdbBackend` from `@azx/ribo-storage-rxdb` for a browser host (the production path — the
backend needs IndexedDB, so the RxDB wiring is prose, not node example). The injectable defaults
the page states are observed by the example file's test run rather than retyped:

<<< @/api/examples/open-storage.run.ts#defaults

| Name                   | Type             | Default                                 | What it does                                                                                                                                                                           |
| ---------------------- | ---------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backend`              | `StorageBackend` | **required** — no default, deliberately | Where durable state lives. `createMemoryBackend` for tests; `openRxdbBackend` from `@azx/ribo-storage-rxdb` for a browser host. Core could not construct the RxDB one if it wanted to. |
| `now`                  | `() => number`   | `Date.now` (above, observed)            | Injectable clock, epoch milliseconds.                                                                                                                                                  |
| `createId`             | `() => string`   | `crypto.randomUUID` (above, observed)   | Injectable id source.                                                                                                                                                                  |
| `createIdempotencyKey` | `() => string`   | `crypto.randomUUID` (above, observed)   | Injectable idempotency-key source — stable for the session's life.                                                                                                                     |

Defaults are read from `packages/ribo-core/src/storage/storage.ts`.

## Return value

`openStorage` resolves to a `Storage`:

- `captures` — the capture store: `enqueue` (row plus audio in the same write, sequence allocated
  atomically by the backend), `nextPending`, `patch`, `writeTranscript`, the audio attachments,
  and live queries.
- `sessions` — the session store: `open`, `close`, `submitReview`, `reopenForReview`,
  `nextPending`, `patch`.
- `store(owner)` — a namespaced key-value store for one owner (conventionally a package name);
  two owners that name themselves differently cannot see each other's keys. Declaring one needs
  no schema, no migration and no cooperation from the backend.
- `scopedStore(captureId, owner)` / `captureStore(captureId)` — one capture's namespace, the
  shapes the relay hands a transcriber.
- `backend` / `closed` / `close()` — the backend this was opened over; every store over a closed
  storage is unusable.

## Errors

- A capture enqueued against a nonexistent session, or a session opened twice, throws from the
  store — the stores validate at every boundary with zod, since persisted rows come back out of
  IndexedDB as `unknown`.
- `close()` twice is a no-op; stores used after `close()` fail rather than silently reopen.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including the injectable
defaults quoted under Options.

<<< @/api/examples/open-storage.run.ts

## Related APIs

- [`createRelay`](/api/relay) — the queue that drains what this stores.
- [The StorageBackend port](/api/storage-port) — the contract every backend, including the memory
  one, implements.

## Guides that use it

- [Offline & Storage](/guide/offline-and-storage) — what the stores persist and how it survives a
  reload.

## Reference

- [`openStorage`](/reference/@azx/ribo-core/functions/openStorage.html)
- [`Storage`](/reference/@azx/ribo-core/classes/Storage.html) ·
  [`OpenStorageOptions`](/reference/@azx/ribo-core/interfaces/OpenStorageOptions.html)
- [`CaptureStore`](/reference/@azx/ribo-core/classes/CaptureStore.html) ·
  [`SessionStore`](/reference/@azx/ribo-core/classes/SessionStore.html)
- [`createMemoryBackend`](/reference/@azx/ribo-core/functions/createMemoryBackend.html) ·
  [`removeMemoryDatabase`](/reference/@azx/ribo-core/functions/removeMemoryDatabase.html)
