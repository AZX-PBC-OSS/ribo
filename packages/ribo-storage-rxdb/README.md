# `@azx/ribo-storage-rxdb`

The RxDB implementation of ribo's storage port — the durable substrate under
`@azx/ribo-core`'s capture, session and key-value stores.

Core owns the contracts and every piece of domain logic. This package owns
everything RxDB-shaped: Mango queries, attachments, incremental modification,
the metadata RxDB hangs off a document, and the schema versions. Nothing here
knows what a capture status means or which recordings belong to a session.

## Using it

```ts
import { openRxdbBackend } from "@azx/ribo-storage-rxdb";

const backend = await openRxdbBackend();
```

That is the batteries-included path: the Dexie storage (IndexedDB) already
wired, on the database named `ribo-outbox`.

To choose your own engine — RxDB's memory storage for a browser test, a
React-Native/SQLite storage the day the field app leaves the browser — pass one:

```ts
const backend = await openRxdbBackend({ storage: getRxStorageMemory() });
```

`createRxdbBackend(database, name)` wraps an `RxDatabase` you opened yourself,
for a host that wants its own collections alongside ribo's.

## Why this is a separate package

So that a consumer using ribo's contracts is not obliged to install RxDB, and so
that core's public types never name an RxDB type. See
`docs/roadmap/design/storage-port-design.md`.

The pre-wired `openRxdbBackend` lives here rather than at `@azx/ribo-core/rxdb`
because that subpath would make core import this package, which imports core.

## Conformance

This backend is validated by `@azx/ribo-core/testing`'s conformance kit, in real
Chromium against real IndexedDB, in `src/backend.browser.test.ts`. The kit is
the executable form of the port's six obligations, and passing it is what makes
an implementation of the port real rather than merely type-correct.

Two of those obligations — that reactive queries see other contexts' writes, and
that sequence allocation is atomic across contexts — need two connections to one
database. RxDB refuses that in a single JS context by default, since its unit of
context is the tab; the test file explains how it gets two anyway, and why that
is a faithful simulation rather than a way around the check.

## What is not here yet

The database-opening code, the schemas, the migration strategies and the session
backfill still live in `@azx/ribo-core` while its `Outbox` class is what uses
them. They move here — and RxDB leaves core's dependencies — in the task that
puts core's domain logic onto the port. They are deliberately not duplicated in
the meantime: two copies of a migration strategy is how a device gets stranded.
