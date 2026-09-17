# Migrations belong to the document — Implementation Plan

> **For anyone implementing this, human or agent:** work task-by-task, in order. Stage 2 depends on
> Stage 1 having moved the domain helpers, and the RxDB adapter in Task 6 cannot be written until
> the ladders it adapts exist. If a task's premise turns out to be wrong against the actual code,
> **stop and say so rather than improvising around it** — this plan's first draft contained three
> factual errors about where code lives, all caught by review, and the lesson is that a premise is
> worth re-checking before building on it.

**Goal:** Move every migration transformation out of `@azx/ribo-storage-rxdb` and into
`@azx/ribo-core` as versioned, tested, exported data — so a second backend inherits the
transformations, the guards and the archaeology instead of reinventing them.

**Architecture:** Core exports, per collection, a version constant and an ordered ladder of rungs. A
rung either carries a pure `upgrade` or declares `rewrite: "none"` explicitly. The cross-collection
half of the v5→v6 migration moves to core too, rewritten against `StorageBackend`, because it needs
only four port operations. The RxDB package keeps its schemas and open-time behaviour and becomes a
thin adapter that converts a ladder into `migrationStrategies`.

**Tech Stack:** TypeScript, zod 4, rxjs, Vitest 4 (node `unit` + real-Chromium `browser`), tsdown,
pnpm 10.34.5 catalog, RxDB + Dexie.

**Spec:** `docs/roadmap/design/storage-migrations-design.md`. The plan argues from it; read both.
Section references below (§5, §13.2, and so on) are to that document.

---

## Global Constraints

- **Node >= 24, pnpm 10.34.5.** Every command from the repo root. `./check.sh` is the definition of
  done — typecheck, lint, format:check, build:packages, resolve, build:app, pkg:gates, snugg:drift,
  skips:tracked, score:mutations, test. Paste its summary line; never assert success without it.
- **CI runs three gates `./check.sh` does not:** `pnpm docs:build`,
  `pnpm changeset status --since=origin/main`, and `pnpm test:pack-and-consume`. Task 6 and Task 8
  change published surfaces, so all three are part of the bar from Task 6 onward.
- **No persisted identifier changes in this plan.** The database stays `ribo-outbox`; the
  collections stay `outbox`, `sessions`, `pluginStorage`. Task 7 _adds_ pins; it changes no values.
  If you find yourself editing one of those strings, you have misread the plan.
- **No schema version changes in this plan either.** Captures stay at 7, sessions at 2, plugin
  storage at 1. This work rehomes existing migrations; it introduces none. Any diff that moves a
  version number is wrong.
- **Every rung must be pure and idempotent.** A backend may resume a partially applied migration
  from a checkpoint and run a rung twice. This is tested, not assumed — see Task 2.
- **Write no code fences into design or plan documents.** This repo's docs describe intent,
  interfaces and must-fail tests in prose. Source files carry the code.

---

## File Structure

**New, in `packages/ribo-core/src/storage/upgrades/`:**

- `rung.ts` — the `ShapeUpgrade` union (Task 2) and the `shapeSignature` helper (Task 4). One
  responsibility: what a rung is, and how a document's shape is described so a version can be
  pinned to it.
- `captures.ts` — `CAPTURE_DOCUMENT_VERSION` and `CAPTURE_DOCUMENT_UPGRADES`.
- `sessions.ts` — `SESSION_DOCUMENT_VERSION` and `SESSION_DOCUMENT_UPGRADES`.
- `plugin-storage.ts` — `PLUGIN_STORAGE_DOCUMENT_VERSION` and `PLUGIN_STORAGE_DOCUMENT_UPGRADES`.
  Named for the schema it describes (`plugin-storage-schema.ts`), not for the port's `entries`
  collection, so each ladder module sits one directory away from its schema under the same name.
  There is already a `storage/plugin-storage.ts` — the key-value facade. This is its ladder, in the
  `upgrades/` directory; the parallel naming is deliberate.
- `v5-to-v6.ts` — the capture ladder's heaviest rung, `captureV5ToV6Upgrade`, plus the two helpers
  only it uses (`migratedSessionId`, `V5_SESSION_OWNED_STATUSES`) and the `LegacySessionFields`
  type. **Only the upgrade function is exported from the package root.**
- `backfill.ts` — `backfillSessions` rewritten against `StorageBackend`, plus the four helpers only
  it uses: `legacyOf`, `migratedCtx`, `migratedSessionRef`, `sessionDocumentFromMigratedGroup`.
  **Only `backfillSessions` is exported from the package root.**

**One public name per task, and the barrel test is what enforces it.**
`packages/ribo-core/src/index.test.ts` pins the package's entire public runtime surface as a sorted
literal, so every added export is a deliberate, reviewed edit. An earlier draft of this plan had
Task 1 root-export all six helpers; the barrel test rejected it, correctly — four of those six are
implementation details of one rung or one backfill, and publishing them would commit us to them
forever, then require un-publishing them two tasks later. The helpers are split by consumer instead:
the rung's two go with the rung in Task 1, the backfill's four go with the backfill in Task 5, and
each task grows the public surface by exactly one well-chosen name.

**A deliberate departure from spec §5**, which says a ladder lives "beside the zod schema each
describes". The v5→v6 rung and its helpers are roughly 150 lines and `capture-schema.ts` is already
long; folding them in would make the file harder to hold in context, which is the thing the repo's
file-size convention exists to avoid. The version constant lives with its ladder rather than with
its schema, because those two must move together and Task 4's guard is what couples them to the
shape. Each schema file gains a one-line pointer comment naming its ladder module, and everything is
re-exported from the package root (spec §13.1), so discoverability — the intent behind §5 — is
preserved.

**Modified:**

- `packages/ribo-core/src/storage/index.ts` — re-export the new surface.
- `packages/ribo-core/src/storage/capture-schema.ts`, `session-schema.ts`,
  `plugin-storage-schema.ts` — a pointer comment each; no behavioural change.
- `packages/ribo-storage-rxdb/src/database.ts` — loses the helpers, the strategies and the backfill;
  gains the adapter call.
- `packages/ribo-storage-rxdb/src/schemas.ts` — `version` derived from core's constants; strategies
  become adapter output.
- `packages/ribo-storage-rxdb/src/index.ts` — stops exporting `backfillSessions`.
- `packages/ribo-core/src/storage/persisted-names.test.ts` — attachment name pins (Task 7).
- `AGENTS.md` §5.5, and a new `docs/guide/` page (Task 8).

---

## Task 1: Move the v5→v6 upgrade into core

The heaviest rung moves, and the two helpers only it uses move with it. **The helpers stay
module-private in core**; exactly one new runtime name reaches the package root.

**Files:**

- Create: `packages/ribo-core/src/storage/upgrades/v5-to-v6.ts`
- Create: `packages/ribo-core/src/storage/upgrades/v5-to-v6.test.ts`
- Modify: `packages/ribo-storage-rxdb/src/database.ts` — delete the moved definitions; strategy 6
  becomes a reference to core's function
- Modify: `packages/ribo-core/src/storage/index.ts`
- Modify: `packages/ribo-core/src/index.test.ts` — add the one new name to the pinned surface

**Interfaces produced:**
`captureV5ToV6Upgrade(document: Record<string, unknown>): Record<string, unknown>` — the only
export. Module-private inside `v5-to-v6.ts`: `migratedSessionId(ctx: unknown): string`,
`V5_SESSION_OWNED_STATUSES: ReadonlySet<string>`, and the `LegacySessionFields` type.

**Do not move `legacyOf`, `migratedCtx`, `migratedSessionRef` or
`sessionDocumentFromMigratedGroup`.** Those four serve the backfill, not the rung, and they move in
Task 5. Splitting the helpers by consumer is what keeps each task's public-surface growth to one
name.

- [ ] **Step 1: Write the failing test.** In `v5-to-v6.test.ts`, assert three things about
      `captureV5ToV6Upgrade`. It lifts the six session-owned fields (`extracted`, `extractedBy`,
      `reviewOutcome`, `writeResult`, `writtenInstances`, `idempotencyKey`) off the document and
      into a `legacy` bag, leaving none of them at the top level. It narrows a status the session now
      owns — feed it `awaiting-review` and expect `transcribed`. And it derives `sessionId` from
      **`recording.ctx.assessmentId`**, not from `recording` — build a document whose `recording` has
      an `assessmentId` nested under `ctx` and assert the id comes back. That third case is the
      regression test for the bug the function's own comment describes.
- [ ] **Step 2: Run it and watch it fail** with a module-resolution error, because the file does not
      exist yet. Run only this file's suite, not the whole tree.
- [ ] **Step 3: Write `v5-to-v6.ts`.** Move `CAPTURE_MIGRATION_STRATEGIES[6]`'s body verbatim as
      `captureV5ToV6Upgrade`, and move `migratedSessionId` and `V5_SESSION_OWNED_STATUSES` with it as
      module-private definitions. Take the doc comments — particularly the one recording that passing
      the recording rather than its `ctx` made the `"assessmentId" in ctx` test always false and let
      one session swallow every job. That comment is the most expensive sentence in the file.
- [ ] **Step 4: Re-point `database.ts`.** Strategy 6 becomes a reference to the imported
      `captureV5ToV6Upgrade`; delete the three local definitions. Strategies 1 through 5 and 7 are
      untouched, and so is everything else in the file — `legacyOf` and the backfill stay exactly
      where they are.
- [ ] **Step 5: Export from `storage/index.ts`**, then add `captureV5ToV6Upgrade` to the sorted list
      in `packages/ribo-core/src/index.test.ts`. That test pins the package's whole public runtime
      surface on purpose; adding the name is the deliberate act it exists to require. **One name
      only** — if you find yourself adding several, re-read Step 3.
- [ ] **Step 6: Run the node test project.** The new test passes and every existing test still
      passes — that is the whole claim of this task.
- [ ] **Step 7: Report.** State what moved, confirm strategy 6 is now a reference, and paste the gate
      output. The RxDB browser suites are run separately, after integration; they need real Chromium
      and are outside this task's gate.

---

## Task 2: The rung union, and the capture ladder

**Files:**

- Create: `packages/ribo-core/src/storage/upgrades/rung.ts`
- Create: `packages/ribo-core/src/storage/upgrades/captures.ts`
- Create: `packages/ribo-core/src/storage/upgrades/captures.test.ts`
- Modify: `packages/ribo-core/src/storage/index.ts`, `capture-schema.ts` (pointer comment only)

**Interfaces consumed:** everything Task 1 produced.

**Interfaces produced:** `ShapeUpgrade`, a two-branch union. Both branches carry
`readonly reason: string`. One carries `readonly upgrade: (document: Record<string, unknown>) => Record<string, unknown>`;
the other carries `readonly rewrite: "none"`. Also `CAPTURE_DOCUMENT_VERSION: number` and
`CAPTURE_DOCUMENT_UPGRADES: readonly ShapeUpgrade[]`.

**The union, not an optional field.** Spec §5 argues this at length and it reverses an earlier
draft: `{ reason }` with an omitted `upgrade` is exactly what a half-finished rung looks like, and
an adapter that synthesises identity from absence converts today's loud open-time failure into a
silent pass-through. Do not "simplify" this to an optional property.

**The version constant is written by hand, never derived.** `CAPTURE_DOCUMENT_VERSION` must not be
`CAPTURE_DOCUMENT_UPGRADES.length`. Deriving it makes Guard A assert a value against itself, so the
test passes forever and checks nothing — and it is exactly the tidying an implementer reaches for on
seeing two things that always agree. They always agree _because the test makes them_; that is the
whole mechanism.

- [ ] **Step 1: Write the failing tests** in `captures.test.ts`. Three of them. First, the ladder has
      exactly `CAPTURE_DOCUMENT_VERSION` rungs — Guard A from spec §7. Second, every rung's `reason`
      is a non-empty string. Third, the version constant is the literal 7, pinned the way
      `persisted-names.test.ts` pins collection names, so a bump is a deliberate edit.
- [ ] **Step 2: Run them and watch them fail** on the missing module.
- [ ] **Step 3: Write `rung.ts`** — the union only. No ladder logic yet.
- [ ] **Step 4: Write `captures.ts`** with all seven rungs. Rungs 0→1 through 4→5 are
      `rewrite: "none"`; their reasons come from the doc comment at `database.ts:144-232` and are
      listed in spec §10 — `reviewOutcome`/the review gate, `capture` (noting revision 9 removed
      `canonicalAttachmentId` and `step`), `preview`/live transcription, `extractedBy`/on-device
      provenance, and R1.6 instance modeling. Rung 5→6 carries `captureV5ToV6Upgrade` as its
      `upgrade` — Task 1 already moved that function into core, so this rung references it rather
      than redefining it. Rung 6→7 is `rewrite: "none"` and its reason must say what
      `database.ts:189` says: the bump is not needed to read `transcript.annotations` and buys a
      clean failure on **downgrade**, because `transcriptSchema` is a `strictObject`. Do not write
      that this rung is about `recording.kind` — that change deliberately did not bump, and
      `schema.test.ts:157` pins it saying so.
- [ ] **Step 5: Run the three tests** and watch them pass.
- [ ] **Step 6: Write the behavioural tests** — spec §5's three kinds. Apply each `upgrade` twice and
      assert the second application changes nothing. Add a golden fixture for rung 5→6: a realistic
      v5 capture document in, the expected v6 document out, including that `sessionId` is derived
      from `recording.ctx` and not from the recording. Apply the whole ladder to a v0 fixture and
      assert the result parses under `captureDocumentSchema`.
- [ ] **Step 7: Run them.** The golden fixture is the one that matters: nothing pins rung behaviour
      today, and this is where the ctx-versus-recording bug class gets caught.
- [ ] **Step 8: Add the pointer comment** to `capture-schema.ts` naming `upgrades/captures.ts`, and
      export the new surface from `storage/index.ts`.
- [ ] **Step 9: Run `./check.sh`**, paste the summary, and commit.

---

## Task 3: The session and plugin-storage ladders

Same shape as Task 2, different collections. Split from it because a reviewer can meaningfully
approve the capture ladder and reject one of these — the session ladder's second rung has real
behaviour and the plugin-storage rung rewrites a document into a different shape entirely.

**Files:**

- Create: `packages/ribo-core/src/storage/upgrades/sessions.ts`, `sessions.test.ts`,
  `plugin-storage.ts`, `plugin-storage.test.ts`
- Modify: `storage/index.ts`, `session-schema.ts`, `plugin-storage-schema.ts` (pointer comments)

**Interfaces produced:** `SESSION_DOCUMENT_VERSION` (2), `SESSION_DOCUMENT_UPGRADES`,
`PLUGIN_STORAGE_DOCUMENT_VERSION` (1), `PLUGIN_STORAGE_DOCUMENT_UPGRADES`.

- [ ] **Step 1: Write the failing tests** for both ladders — the same three structural assertions as
      Task 2 (length equals version, every reason non-empty, version pinned as a literal), plus
      idempotence and a golden fixture for each rung that carries an `upgrade`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Write `sessions.ts`.** Rung 0→1 is `rewrite: "none"`, and its reason must name what
      this repository learned: `extractionUsage` was added at v0 and the missing bump was #38, fixed
      in `cec0c87`, and the failure was a DB6 at `addCollections` that took the capture store down
      with it because all three collections are added in one call. Rung 1→2 carries the real
      `upgrade` from `SESSION_MIGRATION_STRATEGIES[2]` — review outcomes gain explicit per-instance
      keys, derived from the length of each group's field array.
- [ ] **Step 4: Write `plugin-storage.ts`.** One rung, 0→1, carrying the `upgrade` from
      `PLUGIN_STORAGE_MIGRATION_STRATEGIES[1]`: the scope becomes a `kind` and an id, and the owner
      stops being a plugin. Its reason must keep the argument from the existing comment — the
      strategy is required _even though no user depends on a v0 entry_, because RxDB validates
      against the schema the collection was created with, so a same-version reshape is a DB6 on any
      device that merely opened the app. The primary key's composition is deliberately unchanged.
- [ ] **Step 5: Run every test in both files** and watch them pass.
- [ ] **Step 6: Add pointer comments and exports**, then run `./check.sh`, paste the summary, and
      commit.

---

## Task 4: Guard B — the version-to-signature tables

Guard A only relates the ladder to the version. This is the guard that catches the bug the repo
actually shipped: a shape change at an unchanged version. Read spec §7 before starting; it explains
why the obvious single invariant is insufficient and what this one does and does not promise.

**Files:**

- Modify: `packages/ribo-core/src/storage/upgrades/rung.ts` — add `shapeSignature`
- Create: `packages/ribo-core/src/storage/upgrades/signatures.test.ts`

**Interfaces produced:** `shapeSignature(schema): string` — takes a zod object schema and returns a
sorted, comma-joined `field:optionality` string, for example `annotations?,createdAt,id,seq`. A
readable string, deliberately not a hash, so a failing assertion's diff names the field that changed.

- [ ] **Step 1: Write the failing test.** A table per collection mapping each version to the
      signature the document had at that version, and an assertion that
      `shapeSignature(captureDocumentSchema)` equals the entry for `CAPTURE_DOCUMENT_VERSION` — and
      the same for sessions and entries. Only the current version's entry can be checked
      mechanically; the earlier entries are the recorded history a future rung author reads.
- [ ] **Step 2: Run it and watch it fail** on the missing `shapeSignature`.
- [ ] **Step 3: Implement `shapeSignature`.** Read the schema's top-level shape, mark a field
      optional when parsing `undefined` against it succeeds — the mechanism `schema.test.ts:30-35`
      already uses — sort, and join.
- [ ] **Step 4: Fill in the current-version entries** by running the test and copying the actual
      signature from the failure message. Earlier versions' entries are reconstructed from the
      ladder: a rung that adds a field tells you what the previous signature was.
- [ ] **Step 5: Prove the guard fires.** Temporarily add an optional field to `sessionDocumentSchema`
      and confirm the test fails naming it. **Revert the field.** This is the #38 replay and it is
      the only evidence that this task did anything — a guard nobody has seen fail is a guard nobody
      knows works.
- [ ] **Step 6: Write the comment that makes the guard legible.** Above the tables, in the style of
      `persisted-names.test.ts`: changing an entry is not an edit to this file, it is a version bump
      plus a rung, and the failure mode for getting it wrong is a DB6 that strands every recording
      on every existing device. State the limit too — this signature is top-level only and will not
      see a change inside `recording` or `transcript`, which is spec §13.2 and unresolved.
- [ ] **Step 7: Run `./check.sh`**, paste the summary, and commit.

---

## Task 5: The backfill, over the port

**Files:**

- Create: `packages/ribo-core/src/storage/upgrades/backfill.ts`, `backfill.test.ts`
- Modify: `packages/ribo-storage-rxdb/src/database.ts`, `src/index.ts`
- Modify: `packages/ribo-core/src/index.test.ts` — add `backfillSessions` to the pinned surface
- Create: `.changeset/` entry — this removes a published export

**Interfaces consumed:** `StorageBackend` from `storage/port.ts`.

**Interfaces produced:** `backfillSessions(backend: StorageBackend): Promise<void>` — the only new
export. This task also moves the four helpers Task 1 deliberately left behind, because they serve
the backfill rather than the rung: `legacyOf`, `migratedCtx`, `migratedSessionRef` and
`sessionDocumentFromMigratedGroup`. **All four stay module-private in `backfill.ts`**; only
`backfillSessions` reaches the package root, and it goes into the pinned list in
`packages/ribo-core/src/index.test.ts`.

Spec §6 is the argument for this task and is worth reading in full. The short version: the ladder
carries only the per-document half of v5→v6, and a backend that applied rungs alone would leave
`legacy`-carrying documents pointing at sessions that never get created — silently.

- [ ] **Step 1: Write the failing test** against `createMemoryBackend`. Insert two v6-shaped capture
      documents that share a derived `sessionId` and both carry a `legacy` bag, run the backfill,
      and assert one session document exists, its status is derived from the pair rather than from
      either row alone, and both captures have had their `legacy` bag cleared.
- [ ] **Step 2: Add the idempotency test** in the same file: run the backfill twice and assert the
      second run neither throws nor creates a second session. This pins the hinge documented at
      `database.ts:449` — a crash between the insert and the clear must leave the next open able to
      finish rather than collide on a primary key.
- [ ] **Step 3: Run both and watch them fail.**
- [ ] **Step 4: Write `backfill.ts`.** Translate the four RxDB calls to port calls:
      `collections.outbox.find().exec()` becomes `backend.find("captures", {})`;
      `collections.sessions.findOne(id).exec()` becomes `backend.get("sessions", id)`;
      `sessions.insert(doc)` becomes `backend.insert("sessions", doc)`; `doc.incrementalModify(fn)`
      becomes `backend.modify("captures", id, fn)`. The grouping, the status derivation and the
      ordering are unchanged — only the I/O is.
- [ ] **Step 5: Run the tests** and watch them pass. The memory backend is a legitimate subject here,
      unlike for the durability suites: this task tests transformation and ordering, not that bytes
      reach disk.
- [ ] **Step 6: Delete the RxDB copy** and have `openOutboxDatabase` call core's version at the same
      point in the sequence (`database.ts:392`). Remove `backfillSessions` from the RxDB package's
      `index.ts`.
- [ ] **Step 7: Run the RxDB browser suites.** These exercise the real migration against real
      IndexedDB and are the check that the port translation preserved behaviour.
- [ ] **Step 8: Write the changeset.** `@azx/ribo-storage-rxdb` loses a published export and
      `@azx/ribo-core` gains one. Say plainly that a host calling `backfillSessions` from the RxDB
      package must now import it from core and pass a backend rather than a database.
- [ ] **Step 9: Run `./check.sh`, `pnpm docs:build`, `pnpm changeset status --since=origin/main` and
      `pnpm test:pack-and-consume`.** Paste each summary. Commit.

---

## Task 6: The RxDB package becomes an adapter

**Files:**

- Modify: `packages/ribo-storage-rxdb/src/schemas.ts`, `src/database.ts`
- Create: `packages/ribo-storage-rxdb/src/migration-strategies.test.ts`
- Create: `.changeset/` entry

**Interfaces produced:** `toMigrationStrategies(ladder: readonly ShapeUpgrade[])`, returning RxDB's
`migrationStrategies` object.

- [ ] **Step 1: Write the failing test.** Assert `toMigrationStrategies` keys by **target** version —
      a ladder of length 7 produces keys 1 through 7, not 0 through 6 — and that a `rewrite: "none"`
      rung becomes an identity function rather than a missing key. The second assertion is the one
      that matters: RxDB fails to _open_ when a version above 0 has no strategy (`database.ts:229`),
      so a gap here is an un-bootable app.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement the adapter** in `schemas.ts`. Map each rung at index `i` to key `i + 1`,
      using its `upgrade` or a synthesised identity for `rewrite: "none"`.
- [ ] **Step 4: Derive each `RxJsonSchema`'s `version`** from core's constant instead of the literal.
      The existing version-pin tests stay and now pin the adapter's output, which is a different and
      still useful property — they catch a wrong constant reaching the schema.
- [ ] **Step 5: Delete the three strategy objects** from `database.ts` and `schemas.ts` and point
      `addCollections` at `toMigrationStrategies` over core's ladders.
- [ ] **Step 6: Run the full browser suite**, including
      `plugin-storage-migration.browser.test.ts` and `outbox-reopen-cross-tab.browser.test.ts`.
      These are the real-IndexedDB proof that the adapter produces what RxDB expects. If any fails,
      stop — do not adjust the test.
- [ ] **Step 7: Write the changeset** describing the move for backend authors: transformations now
      come from core, the RxDB package adapts them, and the version numbers are unchanged.
- [ ] **Step 8: Run all four gates**, paste each summary, and commit.

---

## Task 7: Pin the attachment names

Small, self-contained, and worth its own commit because it guards a different failure from
everything above. Spec §9 is the argument.

**Files:**

- Modify: `packages/ribo-core/src/storage/persisted-names.test.ts`

- [ ] **Step 1: Add the failing assertions.** `AUDIO_ATTACHMENT_ID` is exactly `"audio"`, and
      `chunkName("s1", 0, 0)` is exactly `"audio-s1-000000-00"`. Write them before checking the
      source, then run them — if a value differs, the source is right and the assertion is wrong.
- [ ] **Step 2: Extend the file's header comment.** It currently says the three collection names are
      "what an auditor's recordings are actually filed under". That is incomplete: the attachment
      ids are the keys the audio bytes themselves live at, and `capture-schema.ts:172` already says
      `sourceId` must never change because it names chunks. Say that a document-only migration rung
      cannot rename these and would orphan the bytes with no error at all.
- [ ] **Step 3: Run the unit suite**, run `./check.sh`, paste the summary, and commit.

---

## Task 8: Write it down

The refusals in spec §11 mean the guide page is the **only** thing a third-party backend author will
actually meet. It has to carry what the code cannot enforce.

**Files:**

- Modify: `AGENTS.md` §5.5 (lines 386-425)
- Create: `docs/guide/migrations.md`
- Modify: `docs/.vitepress/config.ts` — add the page to the sidebar
- Create: `.changeset/` entry

- [ ] **Step 1: Add the contributor rule to AGENTS.md §5.5.** Changing a persisted zod schema means a
      version bump, a rung in the matching ladder, and a new signature-table entry — and the failure
      for getting it wrong is a DB6 that strands every recording on every existing device, which
      this repository shipped once. Name the two guards and where they live. While in that section,
      correct "~14 mechanical operations" to fifteen: `StorageBackend` has fifteen operations plus
      the readonly `name`.
- [ ] **Step 2: Write `docs/guide/migrations.md`** for two audiences. For hosts: what happens on
      upgrade, that it is automatic, and that a downgrade fails at open by design. For backend
      authors: the ladder and how to apply it, **the rung's expressiveness bound** (per-document,
      synchronous, JSON-only — spec §5), **the backfill requirement** (apply rungs, then call it, or
      produce orphans — spec §6), and **the attachment limit** (rungs cannot touch bytes — spec §9).
      State plainly that nothing obliges a backend to do any of this and the conformance kit does not
      check it.
- [ ] **Step 3: Add the page to the VitePress sidebar** and run `pnpm docs:build`. The roadmap
      directory is excluded from the site (`srcExclude`), but `docs/guide/` is not — a page with no
      sidebar entry builds but is unreachable.
- [ ] **Step 4: Write the changeset** for the new core exports, covering the ladders, the rung type,
      `shapeSignature` and `backfillSessions`.
- [ ] **Step 5: Run all four gates**, paste each summary, and commit.

---

## Check bar

Every task ends green on `./check.sh`. From Task 5 onward, also `pnpm docs:build`,
`pnpm changeset status --since=origin/main` and `pnpm test:pack-and-consume`. Paste the summary
lines; a task is not done because it looks done.

Two failures worth recognising rather than debugging from scratch. A **DB6** at `addCollections`
means a declared schema disagrees with the one a collection was created with — in this plan that
almost certainly means a version constant got edited, which no task asks for. A **COL12** means a
declared version has no strategy, which in this plan means the Task 6 adapter produced a gap: check
whether it is keying by source index instead of target version.
