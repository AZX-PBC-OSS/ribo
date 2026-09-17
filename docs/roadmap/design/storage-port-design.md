# Storage, Not an Outbox — Design

**Date:** 2026-09-16
**Author:** AZX
**Status:** Draft — for review, no implementation plan written yet
**Touches:** `@azx/ribo-core` (`src/queue/` → `src/storage/`), `@azx/ribo-ui-react`, `playground`, guide
**Adds:** `@azx/ribo-storage-rxdb`

---

## 1. What prompted this

Ribo is being positioned as a library other people adopt, not just the engine behind one field
app. Three things follow from that, and all three point at the same subsystem.

**The vocabulary is wrong.** "Outbox" named a queue of recordings waiting to go out. The class
called `Outbox` now fronts three collections — recordings, sessions, and plugin-scoped key-value
entries — and only the first is anything like an outbox. Sessions are not outbound; plugin storage
is not a queue.

**RxDB is in the contract, not just the implementation.** `@azx/ribo-core` depends on `rxdb`
directly, and its public surface exports `OutboxCollection`, `OutboxDatabase`, `SessionCollection`,
`PluginStorageCollection`, three `RxJsonSchema` values, and an `RxStorage` option. A consumer
cannot program against ribo's contracts without taking RxDB's types, and `Outbox.database` hands
out the raw database as a documented escape hatch.

**There is no first-class way to add a store.** A host that wants its own durable state reaches
`outbox.database` and adds an RxDB collection — which is to say, the extension mechanism is the
leak.

This doc genericizes the outbox into **storage**: a `Storage` container over named stores, a port
that a backend implements, and RxDB as the first implementation of that port.

## 2. Why a port now, when it was deferred

`packages/ribo-core/src/queue/outbox.ts:143-149` declined this explicitly:

> This is deliberately the _Level 1_ seam: injecting an `RxStorage` under a still-concrete
> `Outbox`. Extracting a formal `Outbox` interface plus a storage conformance-test kit ("Level 2")
> is deferred until a genuinely non-RxDB backend is real — doing it now would be a contract with
> one implementation.

That reasoning was sound and its premise has not changed: **no second production backend is
planned.** SQLite or a native store may come; neither is scheduled, and neither shapes this design.

What changed is the motive. The port is not being built to enable a swap. It is being built so that
core's contracts stop naming RxDB types, so hosts and plugins can declare a store without reaching
through to RxDB, and so the vocabulary describes what the subsystem actually is. Portability is a
consequence, not the goal.

The practical guard against "a contract with one implementation" is that there will be two from the
first commit: RxDB for production and an in-memory backend for tests and development, both passing
the same conformance kit. The memory backend is cheap, and it proves by construction that core runs
with no RxDB present — which is the claim the whole exercise rests on.

**What this deliberately is not.** The port is not shaped around backends that do not exist. There
is no capability tiering, no lowest-common-denominator retreat, and no accommodation for remote or
eventually-consistent stores. See §8.

## 3. The layout

Two facts made the split much smaller than it looks.

**RxDB is confined to six of the fifteen modules under `src/queue/`** — `database.ts`, `outbox.ts`,
`plugin-storage.ts`, and the three `*-schema.ts` files. `relay.ts`, `capture-session.ts`,
`recovery.ts`, `preview.ts`, `session-extract.ts`, `backoff.ts`, `capture-lock.ts` and
`chunk-names.ts` already depend on `Outbox`'s interface rather than on RxDB. They need renamed
imports, not rewrites.

**No package outside `ribo-core` imports RxDB at all.** The blast radius is one package plus docs.

### `@azx/ribo-core`

Keeps the contracts and all the domain logic. Dependencies drop to `rxjs` and `zod`.
`src/queue/` becomes `src/storage/`, containing:

- **The port** — the backend contract (§4). No RxDB; no rxjs beyond `Observable`.
- **The store facades** — `outbox.ts` splits into a capture store, a session store and a key-value
  store, each holding the domain logic that lives in `Outbox` today (sequence allocation, chunk
  merge, status transitions, the sweep, review resolution), written against the port. Plus a small
  `Storage` container that opens a backend and hands out the three.
- **The zod document schemas** — these stay. They are the contract and the read-time parse, and
  they are where legacy tolerance lives, including the `z.preprocess` that stamps `kind` onto rows
  written before the capture union existed. They have nothing to do with RxDB.
- **The conformance kit**, published under a `./testing` subpath (§9).
- **The memory backend**, for tests and development.

### `@azx/ribo-storage-rxdb`

Owns everything RxDB: the three `RxJsonSchema` values, the migration strategies, `backfillSessions`,
the Dexie wiring, `removeRxDatabase`, and the default database name. It implements the port and
does nothing else.

Putting the schema versions here — `outbox` v7, `sessions` v2, `pluginStorage` v0 — makes migrations
a backend's private business, which is where they belong. A different backend has a different
migration story, or none.

### The batteries-included path

`@azx/ribo-storage-rxdb` re-exports `openStorage` with the Dexie backend pre-bound, so the common
case is one import.

This deviates from the first sketch, which put that entry at `@azx/ribo-core/rxdb`. That subpath
would make core import the RxDB package, which imports core — a package cycle. It survives pnpm but
breaks build ordering and is the sort of thing a careful adopter notices. Hosting the pre-wired
entry in the storage package gives identical ergonomics with the dependency arrow pointing one way.

The cost is that the default path is two installs rather than one. A third umbrella package
depending on both would fix that; it is not worth the moving parts until someone asks.

## 4. The port contract

The port knows about documents, blobs and three named collections — captures, sessions and entries.
It knows nothing about statuses, sequences or sessions.

Three is the whole set, and it does not grow when a host declares a store. A declared store is a
namespace within the entries collection, distinguished by its `owner` (§6.1), not a fourth
collection — which is why the store-declaration surface costs the port nothing and why a backend
never learns how many stores exist.

### Operations

**Reads** — get one by id; run a named finder; subscribe to a named finder as an `Observable`.
Subscription is the only rxjs in the contract, and it is already core's public vocabulary.

**Writes** — insert; insert-with-next-sequence (§4.3); modify one by id through a conflict-safe
read-modify-write; upsert; remove one; remove many, reporting how many actually went.

**Blobs** — put, get, list (ids and lengths), list-for-many, remove — scoped to a document, which is how audio and
chunks are already keyed.

**Lifecycle** — open, close.

### 4.1 The finders are closed, not a query language

This is what keeps the contract from becoming a database. The code asks three questions, and the
port names exactly those three:

| Finder   | Filter                                   | Order               |
| -------- | ---------------------------------------- | ------------------- |
| Captures | optional status set, optional session id | sequence ascending  |
| Sessions | optional status set, optional ref        | opened-at ascending |
| Entries  | scope kind and id, optional owner        | key ascending       |

Each takes an optional limit. `nextPending` (`outbox.ts:440`) is the captures finder with a limit of
one, not a separate operation.

A backend implements those three and indexes them however it likes. Nothing about Mango selectors,
`$in`, or sort specifications crosses the boundary: `mangoQuery` and `sessionMangoQuery`
(`outbox.ts:1113` and `outbox.ts:1158`) stop being translation layers in core and become the RxDB
backend's private business.

### 4.2 The obligations

These are behaviours, not signatures. Each is true today and each is something a naive backend
would break silently, which is why the conformance kit exists.

1. **Insert-with-blobs is one write.** There must be no observable moment where a reactive finder
   has published a capture whose audio reads back missing. This is what `enqueue` documents at
   `outbox.ts:236-245`, and it holds today only because RxDB folds document and attachment into a
   single IndexedDB transaction.
2. **Reactive finders see writes from other contexts.** Two tabs on one database observe each other.
3. **Modify does not lose a concurrent update.** Conflict-safe, not last-write-wins.
4. **Listing blobs reads lengths, not bytes.** The derived `audioBytes` sums chunk stub lengths; a
   backend that materialised blobs to answer would exhaust memory on a real queue.
5. **Documents handed back are clean** — no backend metadata. Core's document schemas are
   `strictObject`, and core currently carries two functions whose only job is scrubbing `_rev`,
   `_meta`, `_deleted` and `_attachments` off RxDB's internal documents before parsing
   (`outbox.ts:1070` onward). Making cleanliness the port's obligation deletes both — a
   simplification, not a relocation.
6. **Sequence allocation is atomic** — see below.

### 4.3 Sequence allocation

Today `enqueue` reads the highest sequence and inserts its successor, serialised by an in-process
promise chain (`outbox.ts:1063`). That chain is per-instance, not per-device: two tabs enqueueing
simultaneously can read the same highest sequence, and nothing holds `CAPTURE_LOCK` at enqueue time
to stop them. The bug predates this work.

Rather than carry the race across the port and document it, **insert-with-next-sequence is a single
port operation** and atomicity is the backend's obligation. The RxDB backend implements it by
holding a Web Lock across read-highest-and-insert, which closes the cross-tab race device-wide. A
SQLite or native backend would get the same guarantee from an autoincrement column.

This puts a browser-specific primitive behind the port, where a backend that does not need it is not
forced to care — and it deletes core's serialisation chain rather than porting it. No schema change.

### 4.3a What building it changed — batch blob reads

The one operation this design did not anticipate. A capture's `audioReady` and `audioBytes` are
derived from its blobs, and they are derived for **every row of every query result** — the previous
implementation got them from in-memory attachment stubs with no I/O at all. Through a port that
becomes real I/O, and the per-document form would mean one round trip per row on every repaint of
the queue.

So the port carries a batch form as well: blobs for many documents, keyed by document id. A backend
that can answer it from documents it has just read should, and the RxDB one does — the stubs are a
property walk, not a fetch.

Two smaller facts the port now states rather than leaves implied, both discovered the same way:
**the first sequence allocated into an empty collection is 0** (the captures schema declares
`minimum: 0` and every device holds zero-based rows, so counting from one would violate the schema
and renumber history), and **attaching a blob to a document that does not exist is refused** rather
than quietly creating an orphan.

### 4.4 What the port excludes

**Locks.** `capture-lock.ts` is the Web Locks API — a browser primitive about which tab is
recording, not about storage. It stays in core untouched. (The sequence lock of §4.3 is internal to
the RxDB backend and unrelated to `CAPTURE_LOCK`.)

**Migrations.** Backend-private, per §3.

**Cross-collection transactions.** The plugin-storage sweep runs _after_ a removal and is documented
as ordered, not atomic. Promising more would be inventing a guarantee the system does not provide.

## 5. The public surface

The rename follows rules rather than a table, and the barrel is regenerated from them.

1. **The container.** `Outbox` → `Storage`; `openOutbox` → `openStorage`; `OpenOutboxOptions` →
   `OpenStorageOptions`. Its flat method set re-homes onto `storage.captures`, `storage.sessions`
   and `storage.store(...)`.
2. **"Outbox" retires as a noun.** Every `OUTBOX_*` constant and `Outbox*` type takes the capture
   store's noun: `CAPTURE_STATUSES`, `ACTIVE_CAPTURE_STATUSES`, `CaptureStatus`, `CapturePatch`,
   `CaptureQuery`.
3. **Everything RxDB-typed leaves core outright** and reappears in `@azx/ribo-storage-rxdb`. The
   on-disk database name stays the string `ribo-outbox`, and the collection names stay `outbox`,
   `sessions` and `pluginStorage` — renaming persisted identifiers would be a migration on the one
   collection where a bad bump strands real recordings, bought for nothing.
4. **`Outbox.database` is deleted.** `storage.backend` returns the port; a host that wants the RxDB
   database gets it from the RxDB package, deliberately.
5. **Neutral names do not move.** All of `relay.ts`, `chunk-names.ts`, `capture-lock.ts`,
   `capture-session.ts`, `recovery.ts`, `session-extract.ts`, the backoff helpers and the entire
   session vocabulary keep their names and change only import paths.
6. **Hooks follow.** `useOutboxItems` → `useCaptures`. The other hooks are unaffected —
   though `useStoragePersistence` concerns the _browser's_ storage-persistence permission, not this
   storage, and gets a docs note rather than a rename.
7. **`TerminalQueueError` → `TerminalError`**, staying in `backoff.ts`. It is a failure
   classification meaning "never retry", not a storage type, and the old name implied a relationship
   it does not have.

### 5.1 The row noun, and the payload rename

`OutboxItem` is the persisted row; the payload it carries at `.recording` is `CaptureItem`, the
union of `Recording` and `DocumentCapture`. Naming the row `Capture` gives the best symmetry —
`storage.captures` yields `Capture[]` — but leaves `Capture` and `CaptureItem` one word apart, with
one containing the other.

**The payload is renamed instead.** The row becomes `Capture`; today's `CaptureItem` becomes
`CapturePayload`. `Transcriber<S extends CapturePayload = Recording>` reads correctly, and the two
nouns stop competing.

This widens the change beyond storage, but less than expected: `CaptureItem` has 85 non-test
references across 19 files, and every code reference is inside `ribo-core` itself — `transcriber.ts`,
`restrict-to-kind.ts`, `fallback-transcriber.ts`, `fake-transcriber.ts`, `recording.ts`,
`capture-item.ts` and storage. The four transcriber packages never name it; they ride the
`= Recording` default. The rest is four guide pages.

## 6. Key-value stores and their scopes

### 6.1 The shape

Today's entry is `{id, captureId, pluginId, key, value}`, keyed on `pluginId ␀ captureId ␀ key` and
indexed on `captureId` and `[captureId, pluginId]`.

Adding a session scope by bolting on an optional `sessionId` would produce two optional fields with
an unstated "exactly one is set" invariant, and RxDB requires indexed fields to be required, so
neither would index. **The scope is generalised instead**: `{id, scopeKind, scopeId, owner, key,
value}`, where `scopeKind` is `capture` or `session`, `scopeId` is the id within it, and `owner`
replaces `pluginId` — a host-defined store is not necessarily a plugin. Both scope fields are
required, so both index cleanly, and a third scope kind later costs no further version bump.

The handle reads `storage.store(owner).capture(id)` or `.session(id)`, each yielding the same
get/set/delete/keys surface as today. The plugin-wide scope's `captures()` generalises to
enumerating scope ids of a given kind for an owner.

**This is a key-value store and stays one.** No schema, no indexes, no query language, no reactive
reads. A store that needs those is a core collection, added deliberately.

### 6.2 Two sweep paths

A missed sweep is a silent leak, so both paths are stated:

- **Capture scope** sweeps where it does today — `remove`, `removeMany`, `clear`, and a patch to
  `discarded`. Four existing call sites.
- **Session scope** sweeps on session removal. This is new: nothing sweeps sessions today. It needs
  its own tests, and the ordered-not-atomic caveat of §4.4 applies to it identically.

### 6.3 The migration, which is required even though there is no data

`pluginStorage` holds no entries anyone depends on. **That does not make this a schema edit in
place**, and reasoning that it does is a mistake this repo has already shipped once (#38, fixed in
#40).

RxDB validates a declared schema against the one the collection was _created_ with. A device that
has merely opened the app since plugin storage landed has the collection at version 0 with the old
shape, whether or not it ever wrote an entry. Changing the shape at the same version fails
`addCollections` with **DB6** — and because `outbox`, `sessions` and `pluginStorage` are added in a
single call on a single database, that failure is not scoped to plugin storage. The whole open
rejects, the capture store is unreachable, and an auditor's recordings and audio attachments are
stranded on the device with clearing the origin's IndexedDB as the only way out.

The field app vendors ribo from a checkout rather than a published release, so unreleased
changesets are not evidence that no device holds the collection.

**So: version 0 → 1 with a real strategy, and the primary key composition does not change.** `id`
stays `owner ␀ scopeId ␀ key`, and `scopeKind` becomes an ordinary indexed field rather than part of
the key. The strategy is field-only — set `scopeKind` to `capture`, move `captureId` into `scopeId`,
rename `pluginId` to `owner` — which is the kind RxDB unambiguously supports.

Not encoding `scopeKind` into the key is slightly less self-describing, and it leans on capture and
session ids being drawn from disjoint spaces in practice (both are `crypto.randomUUID`, plus the
deterministic `migrated-session-*` ids). That is a real if remote weakness, and it is the right
trade against rewriting every row's primary key — a change whose failure mode is entries becoming
silently unreachable rather than erroring (see §11.1).

The cost of a strategy that turns out to have been unnecessary is a few lines. The cost of omitting
a necessary one is a bricked capture store.

**Mechanics:** `outbox-reopen-cross-tab.browser.test.ts` hand-rolls its own `addCollections`, so the
bump must be applied there as well as in the backend. A declared version with no strategy fails
**COL12** rather than DB6.

## 7. Decisions

| #   | Decision                                                                    | Rationale                                                                                                                                           |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A port with domain logic kept in core, not domain-shaped backend interfaces | The state machine is what must be identical across backends; keeping it in core writes it once. The RxDB usage is mechanical, so the port is small. |
| 2   | Two packages: contracts in core, RxDB in `@azx/ribo-storage-rxdb`           | Consumers stop installing RxDB to use ribo's contracts.                                                                                             |
| 3   | Pre-wired entry in the storage package, not a `core/rxdb` subpath           | Avoids a package cycle; identical ergonomics.                                                                                                       |
| 4   | Closed finder set, not a query language                                     | Three questions are all the code asks. A selector language would be RxDB's shape leaking under another name.                                        |
| 5   | Insert-with-next-sequence is atomic in the port                             | Closes a live cross-tab race, deletes core's serialisation chain, and keeps a browser lock behind the port.                                         |
| 6   | Clean rename, no deprecated aliases                                         | Pre-1.0, restricted access, and every consumer is in this repo or the field app. A doubled export surface and a removal schedule buy nothing.       |
| 7   | Persisted identifiers unchanged                                             | Type renames are free; on-disk renames are a migration on the collection where migrations hurt.                                                     |
| 8   | Rename the payload to `CapturePayload`, freeing `Capture` for the row       | Two nouns one word apart, one containing the other, is a permanent tax. The blast radius is one package plus docs.                                  |
| 9   | Key-value stores get capture and session scopes only                        | Answers the gap the current docs name, without an unswept namespace that leaks by construction under quota pressure.                                |
| 9a  | `pluginStorage` bumps v0 → v1 with a strategy despite holding no data       | "No data" is not "no collection". A same-version shape change is a DB6 that takes the capture store down with it (§6.3).                            |
| 9b  | `scopeKind` is an indexed field, not part of the primary key                | Keeps the key composition stable, so no row's primary key is rewritten during migration (§11.1).                                                    |
| 10  | Memory backend ships from the first commit                                  | Proves by construction that core runs without RxDB; two implementations from day one.                                                               |
| 11  | The conformance kit is published                                            | A third-party backend author is exactly who needs it.                                                                                               |

## 8. Out of scope

**Remote and syncing backends.** A web-API store — Google Drive, a server — cannot meet obligations
1 and 2 structurally: a Drive file has one content stream where a capture needs a document plus N
chunk blobs, and change notification is polled rather than synchronous, so reads would not follow
writes. It also cannot be offline-first, which is the product's premise. Replication belongs in a
**sync layer above the port**, not behind it; collapsing "where data lives locally" with "where it
replicates to" would drag the port toward async, eventually-consistent semantics that make the RxDB
path worse in service of a backend nobody would run.

**Capability tiering.** Letting a backend declare which obligations it meets, in the style of
`Transcriber.capability()`, would make core branch on capabilities throughout. That is a permanent
complexity tax paid for hypothetical backends.

**A real second production backend.** OPFS or IndexedDB-direct would be the honest candidate — local,
async, no RxDB reactivity model — and remains the natural next step if one is ever wanted. Not now.

**Fixing sessions' lack of a removal API** beyond what §6.2's sweep requires.

**Two lock bugs this work uncovered but did not cause.** `Relay.syncNow` and `recoverInterrupted`
both awaited the _work_ they held a Web Lock for and not the lock's _release_, so each returned
while still holding a lock it had finished with — a second `syncNow` (the normal shape of a drain
loop) found it busy and silently did nothing, and a recorder starting after recovery was told
capture was busy by a caller that had already finished. They were latent in `main`; moving core onto
the port shifted the timing enough to expose them, and they are fixed here because the suite could
not go green otherwise. Neither is a consequence of the port.

**The write-back egress gating**, unchanged and unrelated.

## 9. Testing

**The conformance kit** is the contract made executable: one suite parameterised by a backend
factory, asserting the six obligations and the three finders' ordering and limit semantics. It runs
against the memory backend in Node and the Dexie backend in the browser project.

It is published under a `./testing` subpath of `@azx/ribo-core` rather than as a fourth package, and
takes `describe`/`it`/`expect` as arguments instead of importing vitest — framework-agnostic, no
peer dependency, usable by a backend author on any runner.

The obligations prose cannot pin are the ones the kit must be sharpest about:

- **Blob atomicity** — subscribe, insert, assert the first emission already has readable audio.
- **Cross-context reactivity** — two backend handles on one database, each seeing the other's writes.
- **Conflict-safe modify** — two concurrent modifies, assert neither is lost.
- **Atomic sequence allocation** — N concurrent inserts, assert N distinct consecutive sequences.
  This must fail against a naive read-highest-then-insert implementation.

**Existing tests** move with their subjects and are renamed. The two large browser suites do not
change in substance: the relay tests already drive the domain surface rather than RxDB, and the
outbox tests become capture-store and session-store tests. `outbox-memory.test.ts` improves — it
currently reaches for RxDB's memory storage and becomes a port-level memory-backend test with no
RxDB at all.

**New behaviour needing new tests:** the session sweep path (§6.2), and the store-declaration
surface.

## 10. Sequencing

The refactor and the rename must not land in the same diff. The rename touches the payload type
across `ribo-core`, every status constant, both hook names, the playground and four guide pages;
the refactor moves durability logic across a new contract. Together they are unreviewable.

1. **Port, memory backend, conformance kit.** New code only; nothing existing is touched and the
   tree stays green.
2. **`@azx/ribo-storage-rxdb`.** Schemas, migrations and Dexie wiring move out of core; the package
   passes the kit.
3. **Core onto the port.** `Outbox` keeps its exact public API while its internals switch to the
   port. The existing suite, unchanged, is the regression check. This is the risky step and it is
   isolated.
4. **The rename.** Mechanical, large, and compiler-verifiable.
5. **Key-value scope generalisation.** The session scope and its sweep path are genuinely new
   behaviour and should not be buried in step 4.

### Check bar

`./check.sh` alone is insufficient: adding a publishable package means `docs:build`,
`changeset status` and `pack-and-consume` must pass too.

### Docs

`docs/guide/offline-and-the-outbox.md` needs renaming, and `docs/guide/plugin-storage.md`,
`AGENTS.md §1` and the README all describe the outbox by name. The docs host matches paths exactly
with an `index.html` fallback, so renaming a guide page breaks direct and deep links unless the old
paths are preserved or redirected.

One changeset marks the break, with the rename map in the guide as a migration note.

## 11. Open questions

1. **Does RxDB support changing a primary key's value during a migration?** §6.3 is designed to
   avoid needing the answer — the key composition stays fixed and `scopeKind` is an ordinary field.
   The question stays open because the failure mode if it is unsupported is entries becoming
   silently unreachable rather than an error, and any future change that touches key composition
   must settle it first. Dependencies were not installed in the worktree where this was drafted, so
   it was not verified against the source.
2. **Does the Web Lock in §4.3 cost measurably on enqueue?** Every capture takes it. A lock
   acquisition should be microseconds against an IndexedDB write, but this is the capture hot path
   and it deserves a measurement rather than an assumption.
3. **Does `storage.backend` want to be public at all?** It replaces `Outbox.database` as the escape
   hatch, but a host that has the backend can bypass every invariant the store facades enforce.
   Keeping it internal and requiring hosts to hold their own backend reference is the stricter
   option.
4. **What owns store-name collisions?** Two packages both calling themselves `pdfjs` share a
   namespace silently. Conventionally the package name is the owner id, but nothing enforces it.
