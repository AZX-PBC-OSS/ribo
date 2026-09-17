# Storage, not an outbox — Implementation Plan

> **For anyone implementing this, human or agent:** work task-by-task, in order. The stages are
> not interchangeable and the ordering is the main risk control: the structural refactor (Stage 3)
> and the rename (Stage 4) are deliberately separated so each is reviewable. If a task's premise
> turns out to be wrong against the actual code, stop and say so rather than improvising around it.

**Goal:** Replace the `Outbox` class with a `Storage` container over named stores, sitting on a
narrow backend port that RxDB implements — so `@azx/ribo-core` stops naming RxDB types, hosts can
declare a store without reaching through to RxDB, and the vocabulary describes what the subsystem
actually is.

**Architecture:** Core keeps every piece of domain logic (sequence allocation, chunk merge, status
transitions, the sweep, review resolution) and writes it against a port of roughly ten mechanical
operations with a closed set of three finders. Two backends implement that port from the first
stage: an in-memory one in core, and `@azx/ribo-storage-rxdb` for production. A published
conformance kit is the executable form of the contract and both backends pass it.

**Tech Stack:** TypeScript, zod 4, rxjs, Vitest 4 (node `unit` + real-Chromium `browser`), tsdown,
pnpm 10.34.5 catalog, RxDB + Dexie.

**Spec:** `docs/roadmap/design/storage-port-design.md`. The plan argues from it; read both. Section
references below (§4.2, §6.3, and so on) are to that document.

---

## Global Constraints

- **Node >= 24, pnpm 10.34.5.** Every command from the repo root. `./check.sh` is the definition of
  done — typecheck, lint, format:check, build:packages, resolve, build:app, pkg:gates, snugg:drift,
  skips:tracked, score:mutations, test. Paste its summary line; never assert success without it.
- **CI runs three gates `./check.sh` does not:** `pnpm docs:build`, `pnpm changeset status
  --since=origin/main`, and `pnpm test:pack-and-consume`. This plan adds a publishable package, so
  all three are part of the bar for every stage from Stage 2 onward. A malformed changeset breaks
  CI and `./check.sh` will not tell you.
- **Persisted identifiers do not change, ever, in this plan.** The database stays named
  `ribo-outbox`; the collections stay `outbox`, `sessions` and `pluginStorage`. Type-level renames
  are free; on-disk renames are a migration on the collection where a bad bump strands real
  recordings. If you find yourself editing one of those strings, you have misread the plan.
- **Any schema change needs a version bump plus a strategy — full stop.** RxDB validates a declared
  schema against the one the collection was created with, so a new or renamed property at the same
  version fails `addCollections` with **DB6**, even when no stored data needs transforming, and
  even when the collection holds nothing. All three collections are added in one call on one
  database, so that failure strands the capture store. A declared version with no strategy fails
  **COL12** instead. `packages/ribo-core/src/queue/outbox-reopen-cross-tab.browser.test.ts`
  hand-rolls its own `addCollections`, so every bump must be applied there too.
- **No deprecated aliases.** Nothing is published; every consumer is in this repo or the field app.
  A doubled export surface and a removal schedule buy nothing (§7, decision 6).
- **A green Vitest run is not evidence a type-level change is complete.** esbuild strips types
  without checking them, so a red `tsc` does not turn Vitest red. Run `pnpm typecheck`.
- **Every guard you add must be proven to discriminate.** Break the thing it guards, observe the
  failure, restore, and report the observed output. This matters most for the conformance kit,
  whose whole purpose is catching a backend that looks right and is not.
- **ESM-only**, `import type` for type-only imports, zod at trust boundaries. `ribo-core` and
  `ribo-adapter-snuggpro` are headless: no `react`, no `document`, no `window`.
- **Test-file naming is the discovery contract.** `*.test.ts` runs in node, `*.browser.test.ts` in
  real Chromium, `*.e2e.test.ts` under `playground/e2e`. Putting a browser test under the wrong
  name silently moves it to a project that cannot run it.
- **Review gate:** after each stage, dispatch a review of that stage's diff before starting the
  next. Do not begin a stage while the previous stage's review is outstanding.

---

# Stage 1 — Port, memory backend, conformance kit

New code only. Nothing existing is touched and the tree stays green throughout.

## Task 1: The port contract and the conformance kit

**Files:** create `packages/ribo-core/src/storage/port.ts` (the contract),
`packages/ribo-core/src/storage/conformance.ts` (the kit), and
`packages/ribo-core/src/storage/index.ts` (a barrel for the new directory; leave the existing
`src/queue/` alone entirely). Modify `packages/ribo-core/package.json` (a `./testing` export
condition) and `packages/ribo-core/tsdown.config.ts` (a second build entry).

**What to do:** Declare the port. It addresses three collections by name — captures, sessions and
entries — and knows nothing about statuses, sequences or sessions as domain concepts. Three is the
whole set and does not grow when a host declares a store: a declared store is a namespace within
the entries collection distinguished by its `owner`, not a fourth collection.

Operations, per §4: get one by id; run a named finder; subscribe to a named finder as an rxjs
`Observable`; insert; insert-with-next-sequence; modify one by id through a conflict-safe
read-modify-write; upsert; remove one; remove many reporting how many actually went; put, get, list
and remove blobs scoped to a document; open and close.

The finders are a closed set, not a query language (§4.1). Captures filter on an optional status
set and an optional session id, ordered by sequence ascending. Sessions filter on an optional
status set and an optional ref, ordered by opened-at ascending. Entries filter on scope kind and
scope id plus an optional owner, ordered by key ascending. Each takes an optional limit. Nothing
resembling a Mango selector, `$in`, or a sort specification appears in the contract.

Blob listing returns ids and lengths only — never bytes (§4.2, obligation 4).

Then write the conformance kit against those types. It exports one function taking a backend
factory plus `describe`, `it` and `expect` as arguments — framework-agnostic, so it imports no test
runner and needs no peer dependency, and a third-party backend author on any runner can use it.
Publish it under a `./testing` subpath with the same three-condition shape every other export in
this repo uses (`@azx/source`, `types`, `default`), and add the matching entry to
`publishConfig.exports`.

The kit asserts the three finders' filter, ordering and limit semantics, and the six obligations of
§4.2. Four of those six are the ones prose cannot pin and the kit must be sharpest about:

- **Blob atomicity.** Subscribe to the captures finder, insert a document with a blob, and assert
  the *first* emission already has readable blob bytes. A kit that inserts and then reads passes
  against a broken backend; the subscription is the whole point.
- **Cross-context reactivity.** Two backend handles over one database, each observing the other's
  writes.
- **Conflict-safe modify.** Two concurrent modifies of different fields on one document; assert
  neither is lost. Last-write-wins must fail this.
- **Atomic sequence allocation.** N concurrent inserts-with-next-sequence; assert N distinct
  consecutive sequences. A naive read-highest-then-insert must fail this.

The remaining two: documents handed back carry no backend metadata, and blob listing does not
materialise bytes.

**Interfaces produced:** the port type (name it for the contract it is, not for RxDB); the three
finder argument types; a blob descriptor carrying id and length; and the kit's entry point taking
`{ createBackend, describe, it, expect }`.

**Tests that must fail first:** the kit itself is the failing test and cannot run — there is no
backend. That is the expected state at the end of this task. Assert only that the package
typechecks, builds both entries, and that `pnpm build:packages` still passes publint and attw with
the new export condition.

**Commit** the port and the kit together; they are one deliverable.

## Task 2: The in-memory backend

**Files:** create `packages/ribo-core/src/storage/memory-backend.ts` and
`packages/ribo-core/src/storage/memory-backend.test.ts`. Modify the storage barrel.

**What to do:** Implement the port in memory and make the kit pass. Blobs are held as `Blob`
values; the reactive finders are rxjs subjects re-evaluated on write.

Two obligations need real thought rather than an obvious implementation, and getting them wrong
here would make the kit worthless as a gate on the RxDB backend:

- **Cross-context reactivity** has no meaning for a module-scope map. Give the backend an explicit
  shared-store handle keyed by database name, so two backend instances opened on the same name
  genuinely share state and observe each other. Without that the kit's reactivity test is
  vacuous — it passes because both handles are the same object.
- **Conflict-safe modify** is trivially satisfied by a synchronous JavaScript implementation, which
  means the memory backend cannot prove the kit's test discriminates. Prove it against a
  deliberately broken variant: implement last-write-wins temporarily, watch the test fail, restore,
  and report the observed output.

**Interfaces produced:** a factory creating a memory backend for a given database name.

**Tests that must fail first:** run the kit against the memory backend before implementing — every
obligation fails. Then implement until green. Separately, for each of the four sharp obligations,
break the backend in the specific way that obligation guards against, confirm exactly that
obligation's test goes red and the others stay green, restore, and report each observed failure.
A kit whose tests have never failed is not known to work.

**Verify:** `pnpm vitest run packages/ribo-core`, then `./check.sh`.

---

**STAGE 1 REVIEW GATE.** Dispatch a review of the Stage 1 diff before starting Stage 2.

---

# Stage 2 — `@azx/ribo-storage-rxdb`

The new package implements the port. Core is not touched in this stage and keeps its own RxDB code
working exactly as it does today.

**Read this before starting:** the three hand-written `RxJsonSchema` values and the migration
strategies will exist in **two places** for the duration of Stages 2 and 3 — core's existing
`src/queue/*-schema.ts` and the new package. This duplication is deliberate: moving them out of
core before core stops using them would make core import the new package, which imports core. Task
6 deletes core's copies. Do not attempt to share them in the meantime.

## Task 3: Scaffold the package and move the RxDB schema layer

**Files:** create `packages/ribo-storage-rxdb/` — `package.json`, `tsconfig.json`,
`tsdown.config.ts`, `README.md`, `src/index.ts`, plus `src/schemas.ts`, `src/migrations.ts` and
`src/backfill.ts`. Modify `pnpm-workspace.yaml` if packages are not globbed. Add a changeset.

**What to do:** Copy `packages/ribo-transcriber-pdfjs/package.json` as the scaffold template — it
is the smallest publishable package and carries the exact `exports` shape, `publishConfig`,
`files`, scripts and devDependency set this repo expects. Dependencies are `@azx/ribo-core`
(`workspace:^`) and `rxdb` (`catalog:`).

Copy into it, from core's `src/queue/`: the three `RxJsonSchema` values from `schema.ts`,
`session-schema.ts` and `plugin-storage-schema.ts`; `OUTBOX_MIGRATION_STRATEGIES`,
`SESSION_MIGRATION_STRATEGIES` and `PLUGIN_STORAGE_MIGRATION_STRATEGIES`; `backfillSessions` and
its helpers from `database.ts`; the Dexie storage default; and the default database name. Import
the zod document schemas and the document types from `@azx/ribo-core` — those stay in core
permanently and must not be copied.

Schema versions travel unchanged: outbox 7, sessions 2, pluginStorage 0. Stage 5 bumps the last one;
nothing in this stage changes a version.

**Interfaces produced:** the three RxJsonSchemas, the three migration-strategy maps,
`backfillSessions`, and the default database name — all exported from the new package's barrel.

**Tests that must fail first:** none for a verbatim move; the deliverable is that the package
builds and publishes cleanly. Verify with `pnpm build:packages` (publint strict and attw at error
level run in-build), `pnpm typecheck`, `pnpm changeset status --since=origin/main`, and
`pnpm test:pack-and-consume`. That last one is not in `./check.sh` and this is exactly the change
it exists to catch.

## Task 4: Implement the port over RxDB

**Files:** create `packages/ribo-storage-rxdb/src/backend.ts`, `src/open.ts`, and
`src/backend.browser.test.ts`.

**What to do:** Implement the port against an `RxDatabase` holding the three collections, and open
that database the way `openOutboxDatabase` does today — same name, same collections, same
`addCollections` call, same migration strategies, same `backfillSessions` afterwards. Keep the
injectable `RxStorage` parameter: it is still the right seam for swapping Dexie for RxDB's memory
storage, and it is now *inside* a backend rather than leaking through core's public API.

Translate the three closed finders into Mango queries here. This is where `mangoQuery` and
`sessionMangoQuery` belong; core will delete its copies in Task 5.

Two obligations need specific implementations rather than falling out of RxDB:

- **Documents handed back are clean** (§4.2, obligation 5). RxDB's `incrementalModify` passes the
  *internal* document, carrying `_rev`, `_meta`, `_deleted` and `_attachments`, and core's document
  schemas are `strictObject` — so scrubbing is now the backend's job. Core's `persistedFieldsOf`
  and `persistedSessionFieldsOf` are the existing implementations of exactly this; port that logic
  here, generically over the collection's field set, and delete core's copies in Task 5.
- **Atomic sequence allocation** (§4.3). Implement insert-with-next-sequence by holding a Web Lock
  across read-highest-and-insert, so the allocation is atomic device-wide rather than
  per-instance. Use a lock name distinct from `CAPTURE_LOCK` — that lock means "which tab is
  recording" and taking it here would deadlock against the recorder. This closes a real cross-tab
  race that exists in `main` today.

Blob operations map to RxDB attachments. Blob listing must read attachment stub lengths and never
call `getData` — obligation 4 exists because materialising a queue of audio blobs to answer "how
many bytes" would exhaust memory.

Insert-with-blobs must remain a single storage write: pass attachments inline to `insert` rather
than writing them afterwards with `putAttachment`, exactly as `enqueue` does today
(`outbox.ts:236-245`). This is obligation 1 and it is the one most easily lost in a refactor.

**Interfaces produced:** a factory creating an RxDB backend from a database name and an optional
`RxStorage`; a removal helper equivalent to today's `removeOutboxDatabase`; and the RxDatabase
handle, exported for hosts that want their own collections — the deliberate replacement for
`Outbox.database`.

**Tests that must fail first:** run the conformance kit against this backend as a
`*.browser.test.ts`, so it executes in real Chromium against Dexie and IndexedDB. Every obligation
fails before the implementation exists. Then, as in Task 2, break each of the four sharp
obligations in turn — most importantly, change insert-with-blobs to write the attachment as a
second step and confirm the atomicity test goes red — restore, and report each observed failure.

**Verify:** `./check.sh` plus the three CI-only gates.

---

**STAGE 2 REVIEW GATE.** Dispatch a review of the Stage 2 diff before starting Stage 3.

---

# Stage 3 — Core onto the port

The risky stage, deliberately isolated. `Outbox` keeps its **exact** public API; only its internals
change. The existing test suite, unchanged, is the regression check — that is the entire safety
argument for this stage, so do not rewrite tests to fit the implementation.

## Task 5: Switch `Outbox` internals to the port

**Files:** modify `packages/ribo-core/src/queue/outbox.ts`, `plugin-storage.ts`, `database.ts`, and
`packages/ribo-core/src/queue/index.ts`.

**What to do:** Replace every RxDB call in `Outbox` and the plugin-storage handles with a port call.
The public surface — every method name, parameter and return type — is unchanged at the end of this
task. `openOutbox` gains a backend parameter; since core can no longer construct an RxDB backend,
callers supply one, and core's own tests supply the memory backend.

Five things get **deleted**, not ported, and each should shrink the diff rather than grow it:

- `persistedFieldsOf` and `persistedSessionFieldsOf` — document cleanliness is now obligation 5,
  discharged by the backend (Task 4).
- `mangoQuery` and `sessionMangoQuery` — translation now lives in the RxDB backend.
- The `#enqueueChain` serialisation chain and `#serialized` (`outbox.ts:1063`) — allocation
  atomicity is now obligation 6, discharged by the backend. Deleting this is what fixes the
  cross-tab race; leaving it in place would merely hide that the port operation is doing nothing.
- `#highestSeq` — folded into insert-with-next-sequence.
- The `database` getter on `Outbox`, and every RxDB type in `src/queue/index.ts`'s export list.

`capture-lock.ts` is untouched. It is the Web Locks API — a browser primitive about which tab is
recording, not storage (§4.4).

**Interfaces produced:** `openOutbox` taking a backend; `Outbox` otherwise byte-identical.

**Tests that must fail first:** none are written in this task. The existing suite is the test. Point
core's tests at the memory backend and run them unchanged. Where a test genuinely asserts
browser-or-RxDB-specific behaviour — cross-tab reopen, IndexedDB eviction, attachment storage —
leave it as a browser test and give it the RxDB backend; Task 6 relocates those.

Expect this task to surface at least one behaviour the port did not anticipate. When it does, add
the obligation to the kit and to §4.2 rather than special-casing core around it — an obligation
discovered here is one a future backend would otherwise have broken silently.

## Task 6: Remove RxDB from core

**Files:** modify `packages/ribo-core/package.json` (drop the `rxdb` dependency); delete core's
`src/queue/database.ts` and the three `*RxSchema` values plus migration-strategy maps from the
`*-schema.ts` files, keeping the zod schemas and every non-RxDB export in those files; relocate the
genuinely backend-specific browser tests into `packages/ribo-storage-rxdb`.

**What to do:** Core's `rxdb` dependency goes. Its `dependencies` become `rxjs` and `zod`.

Move to the RxDB package the tests that assert RxDB or browser storage behaviour rather than domain
behaviour — `outbox-reopen-cross-tab.browser.test.ts` and the schema-version and migration tests
among them. `outbox-memory.test.ts` stays in core and improves: it currently reaches for RxDB's
memory storage and becomes a plain port-level memory-backend test with no RxDB at all.

**One thing to verify rather than assume:** core's remaining browser tests, if any still need a
durable backend, would take `@azx/ribo-storage-rxdb` as a devDependency — and that package depends
on core. pnpm tolerates a devDependency cycle, but the build graph may not. Check whether
`pnpm build:packages` still orders correctly. If it does not, move those tests into the RxDB
package too rather than adding a cycle; the domain tests that only need durability should be on the
memory backend anyway.

**Tests that must fail first:** the decisive test of this whole exercise is that core builds,
typechecks and runs its node suite with no RxDB present. Verify it directly rather than by
inference: after dropping the dependency, confirm `rxdb` does not resolve from
`packages/ribo-core`, and that `pnpm --filter @azx/ribo-core typecheck` and the core unit suite
both pass.

**Verify:** `./check.sh` plus the three CI-only gates.

---

**STAGE 3 REVIEW GATE.** Dispatch a review of the Stage 3 diff before starting Stage 4.

---

# Stage 4 — The rename

Mechanical, large and compiler-verifiable. Nothing here changes behaviour; if a test's *expectation*
changes in this stage, something has gone wrong.

## Task 7: Split `Outbox` into store facades

**Files:** move `packages/ribo-core/src/queue/` to `packages/ribo-core/src/storage/` and split
`outbox.ts` into a capture store, a session store, a key-value store and a small `Storage`
container. Modify every importer of the moved modules.

**What to do:** Structural only — the vocabulary is renamed in Task 8. `Outbox`'s flat method set
re-homes onto three facades: capture methods (enqueue, begin/append/commit recording, chunk
merging, patch, transcript and preview writes, audio access, removal, clearing) onto the capture
store; session methods (open, close, get, list, watch, next-pending, patch, submit review, reopen)
onto the session store; and the three plugin-storage accessors onto the key-value store. The
container opens a backend and exposes the three.

`outbox.ts` is the largest file in the subsystem and splitting it is most of the value of this
task. Keep each facade to its own file.

**Interfaces produced:** the container exposing `captures`, `sessions` and the store accessor;
three facade types.

**Tests that must fail first:** none — this is a refactor under an unchanged suite. Update call
sites mechanically and keep the tests' assertions identical.

## Task 8: The vocabulary rename

**Files:** across `packages/ribo-core/src/`, principally the storage directory plus `transcriber.ts`,
`restrict-to-kind.ts`, `fallback-transcriber.ts`, `fake-transcriber.ts`, `recording.ts`,
`capture-item.ts` and `src/index.ts`.

**What to do:** Apply §5's rules. `Outbox` becomes `Storage`; `openOutbox` becomes `openStorage`;
`OpenOutboxOptions` becomes `OpenStorageOptions`. Every `OUTBOX_*` constant and `Outbox*` type takes
the capture store's noun — `CAPTURE_STATUSES`, `ACTIVE_CAPTURE_STATUSES`, `CaptureStatus`,
`CapturePatch`, `CaptureQuery`. `TerminalQueueError` becomes `TerminalError` and stays in
`backoff.ts`.

Then the pair that needs care (§5.1): the persisted row becomes `Capture`, and today's
`CaptureItem` — the payload union of `Recording` and `DocumentCapture` — becomes `CapturePayload`.
`Transcriber<S extends CapturePayload = Recording>` is the signature that has to read correctly at
the end. Every code reference is inside `ribo-core`; the four transcriber packages never name it
and ride the `= Recording` default, so if this rename reaches them, something is wrong.

Names free of both "outbox" and RxDB do not move: `relay.ts`, `chunk-names.ts`, `capture-lock.ts`,
`capture-session.ts`, `recovery.ts`, `session-extract.ts`, the backoff helpers, and the entire
session vocabulary keep their names and change only import paths.

**Tests that must fail first:** none. The compiler is the test. Run `pnpm typecheck` before the test
suite — a rename that misses a reference shows up there and not necessarily in Vitest.

## Task 9: Consumers

**Files:** `packages/ribo-ui-react/src/use-outbox-items.ts` (renamed to match),
`context.ts`, `use-ribo-instance.ts`, `use-recorder.ts`, `use-review.ts`, `use-sessions.ts`,
`packages/ribo-ui-react/src/index.ts`; `playground/src/` (the outbox handle, `App.tsx`, the panels,
and the recorder, recovery, live and capture-coordinator handles); and
`packages/ribo-storage-rxdb/src/index.ts`.

**What to do:** Rename `useOutboxItems` to `useCaptures` and follow the type renames through the
hook layer and the playground. The other hooks are unaffected — but note that
`useStoragePersistence` concerns the *browser's* storage-persistence permission and not this
storage; it keeps its name and gets a clarifying docs note in Task 10, not a rename.

Add the batteries-included entry to the RxDB package: a pre-wired `openStorage` with the Dexie
backend already bound, so the common path is one import (§3). It lives in the storage package and
not at `@azx/ribo-core/rxdb` because the latter would make core import the RxDB package, which
imports core — a package cycle.

**Tests that must fail first:** none; mechanical. The playground's browser and e2e suites are the
regression check that the provider wiring still resolves.

## Task 10: Documentation and the changeset

**Files:** `docs/guide/offline-and-the-outbox.md` (renamed), `docs/guide/plugin-storage.md`,
`docs/guide/quick-start.md`, `docs/guide/write-back.md`, `docs/guide/captures-and-sources.md`,
`docs/guide/extraction.md`, `docs/guide/sessions.md`, `docs/guide/index.md`, `AGENTS.md` §1,
`README.md`, and the VitePress sidebar config. Add a changeset.

**What to do:** Rewrite the guide's outbox vocabulary as storage vocabulary, and update the four
guide pages that name `CaptureItem`. `AGENTS.md` §1 is the architecture summary and describes the
subsystem by name throughout; it is the page a future agent reads first, so it must be correct.

**The docs host matches paths exactly with an `index.html` fallback and has no `cleanUrls`
equivalent**, so renaming a guide page breaks direct links and deep links. Either keep the old path
as a redirecting stub or confirm the sidebar and every inbound link is updated. Verify with
`pnpm docs:build`, which is a CI gate and not part of `./check.sh`.

The changeset marks the break and carries the rename map as a migration note — this is the document
a consumer will actually read, so the map should be complete enough to migrate against without
reading the diff.

**Tests that must fail first:** none. Verify with `pnpm docs:build` and
`pnpm changeset status --since=origin/main`.

---

**STAGE 4 REVIEW GATE.** Dispatch a review of the Stage 4 diff before starting Stage 5.

---

# Stage 5 — Key-value scopes

Genuinely new behaviour, deliberately not buried in the rename.

## Task 11: The scoped entry schema and its migration

**Files:** `packages/ribo-core/src/storage/plugin-storage-schema.ts` (the zod document schema and
the entry-id helper), `packages/ribo-storage-rxdb/src/schemas.ts` and `src/migrations.ts`, and the
relocated cross-tab test that hand-rolls `addCollections`.

**What to do:** Generalise the scope (§6.1). The entry becomes scope kind, scope id, owner, key and
value: `scopeKind` is `capture` or `session`, `scopeId` is the id within it, and `owner` replaces
`pluginId` because a host-defined store is not necessarily a plugin. Both scope fields are
required, so both index cleanly — RxDB requires indexed fields to be required, which is why an
optional `sessionId` was rejected.

**The primary key composition does not change.** `id` stays owner, scope id and key joined by null
bytes, and `scopeKind` is an ordinary indexed field rather than part of the key. This leans on
capture and session ids being drawn from disjoint spaces in practice — both are `crypto.randomUUID`,
plus the deterministic migrated-session ids — and that is the right trade against rewriting every
row's primary key, whose failure mode is entries becoming silently unreachable rather than erroring.

**This needs a version bump even though the collection holds no data anyone depends on** (§6.3).
Bump `pluginStorage` from 0 to 1 with a real strategy: set `scopeKind` to `capture`, move
`captureId` into `scopeId`, rename `pluginId` to `owner`. A device that has merely opened the app
since plugin storage landed has the collection at version 0 with the old shape, and a same-version
shape change is a DB6 that takes the capture store down with it. "It has no entries" answers the
data question and never asks the schema one. This repo has shipped that mistake once already.

Update the indexes to the new field names, and apply the bump in the cross-tab test's hand-rolled
`addCollections` as well as in the backend.

**Tests that must fail first:** a test that opens the collection at the old version with an old-shape
entry and asserts it is readable at the new version with the new field names. Then confirm the
DB6 hazard is real rather than theoretical: declare the new shape *without* the version bump, watch
`addCollections` fail, restore the bump, and report the observed error — that is the guard this
whole task exists for.

## Task 12: Capture and session scopes, and the session sweep

**Files:** the key-value store facade from Task 7, the capture store's removal and discard paths,
and the session store's removal path.

**What to do:** Expose both scopes — a store accessor yielding a per-capture handle and a
per-session handle, each with the same get, set, delete and keys surface as today. The plugin-wide
scope's capture enumeration generalises to enumerating scope ids of a given kind for an owner.

This stays a key-value store: no schema, no indexes, no query language, no reactive reads. A store
needing those is a core collection, added deliberately.

Then the sweeps (§6.2), which is where the real risk is, because a missed sweep is a silent leak:

- **Capture scope** sweeps where it already does — removal, bulk removal, clearing, and a patch to
  `discarded`. Four existing call sites; confirm all four still sweep after the Stage 4 split.
- **Session scope** sweeps on session removal, which is **new** — nothing sweeps sessions today. If
  the session store has no removal path, this task adds the sweep to whatever path does remove a
  session and says so explicitly; if there is none, say that rather than inventing one.

The ordered-not-atomic caveat applies to the session sweep exactly as it does to the capture sweep:
sweep after the removal, so a failed removal cannot orphan entries before the owner is gone.

**Tests that must fail first:** for each scope, write an entry, remove its owner, and assert the
entry is gone — and assert the *other* scope's entries survive, so a sweep that is too broad fails
as loudly as one that is too narrow. Break each sweep in turn, watch exactly its test fail, restore,
and report the output.

**Verify:** `./check.sh` plus the three CI-only gates.

---

**STAGE 5 REVIEW GATE.** Dispatch a review, then open the PR.

---

## Self-review notes

Spec coverage was checked section by section. §3 layout is Tasks 1, 3 and 9; §4 port is Tasks 1, 2
and 4; §4.3 sequence allocation is Tasks 1, 2, 4 and 5; §5 public surface is Tasks 7–10; §5.1 the
payload rename is Task 8; §6 key-value scopes is Tasks 11–12; §6.3 the migration is Task 11; §9
testing is distributed across every task's must-fail-first section; §10 sequencing is the stage
structure.

Two spec items are deliberately carried as open questions rather than tasks, and should be settled
during review rather than improvised during implementation: whether the backend handle should be
public at all (§11.3 — Task 4 exports it as the replacement for `Outbox.database`, which is the
permissive answer), and what owns store-name collisions (§11.4 — Task 12 leaves the owner id
unenforced).
