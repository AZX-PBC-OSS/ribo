# Instance Write Receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ToolAdapter.write` returns the vendor's created-record id, and that id is durably captured on the session, keyed by the reviewed instance's own key (not its array position) — the raw material a future "safe amend" write step needs, without yet building that consuming logic.

**Architecture:** A type change to `ToolAdapter.write`'s return value flows through `toWriteStep`/`toInstanceWriteStep` into a new `SessionWriteResult` shape that `relay.ts` already has a channel to persist. Getting real per-instance keys to the write step requires `resolveReview` to stop discarding the instance keys it already computes internally, exposing them as a new `instanceKeys` field on `ReviewOutcome`, enforced (via a schema refine, not a blanket type requirement) wherever collection-group data exists.

**Tech Stack:** TypeScript, zod, RxDB, Vitest.

**Spec:** `docs/roadmap/design/instance-write-receipts-design.md`

## Global Constraints

- `write` stays a function **property**, never a method — required for strict contravariance on the context type parameter `C` (`adapter.ts:168-171`).
- The returned id is named `uuid`, matching `ExistingRecord.uuid`'s existing convention (`instance-identity.ts:18`) — never a second name for the same concept.
- `linkTargets` (`instance-identity.ts`, `review.ts`) is **not** touched by this plan. It stays array-positional exactly as it is today.
- Every schema change to the sessions collection needs a version bump and an exercised migration strategy — this repo shares one RxDB database between `outbox` and `sessions`, and a schema mismatch on either collection makes the whole database (including captured audio) unreachable on open (`session-schema.ts:226-239`).
- `deriveInstanceIdempotencyKey` (`instance-write-step.ts:50-56`) stays positional and unchanged — its job (stable across retries of the same queue item) is a different concern from instance identity.
- **This plan's Task 3 is the one that bumps the sessions schema to v2 and lands first.** `docs/roadmap/design/roster-absence-plan.md`'s own Task 3 adds a further field (`statedEmptyGroups`) to the same v2 schema/migration this plan introduces, and assumes this plan's Task 3 has already landed — implement this plan's Task 3 before that one.
- Tests run from the repo root via Vitest's own path filtering, **not** a per-package `test` script (none of these packages define one — only `typecheck`/`build`). Use `pnpm vitest run packages/<dir>` (whole package) or `pnpm vitest run packages/<dir>/src/<file>.test.ts` (one file), per `AGENTS.md`'s own example. `pnpm --filter @azx/<pkg> typecheck` remains correct as written — only `test` invocations change.

---

### Task 1: `ToolAdapter.write` returns the vendor's uuid

**Files:**
- Modify: `packages/ribo-core/src/adapter.ts:229-238`
- Modify: `packages/ribo-adapter-snuggpro/src/adapter.ts:76-85` (and its stale doc comment at line 71)
- Modify: `packages/ribo-core/src/adapter.test.ts` (lines 45-48, 139, 206, 224, 264, 292, 317)
- Modify: `packages/ribo-core/src/write-step.test.ts` (lines 64-67, and no change needed at line 267)
- Modify: `packages/ribo-core/src/instance-write-step.test.ts` (lines 69-72, 258-267, and no change needed at lines 406, 450-458 beyond what's below)
- Modify: `packages/ribo-adapter-snuggpro/src/round-trip.test.ts` and `packages/ribo-core/src/contracts.test.ts` (each has one more `write` stub not listed above — see Step 3)

**Interfaces:**
- Produces: `ToolAdapter<V, C>.write: (fields: V, ctx: C, meta: WriteMetadata) => Promise<{ readonly uuid: string }>` — every later task's write-step code depends on this return shape.

- [x] **Step 1: Update the `ToolAdapter.write` signature and its doc comment**

  In `adapter.ts`, change the `write` member's return type from `Promise<void>` to `Promise<{ readonly uuid: string }>`. Extend the doc comment immediately above it (currently ending at line 237, "and merging them would let a host persist an idempotency key into a recording's context") with one sentence: the promise resolves with the vendor's own identifier for the record it just created, which is what a future amend pass needs in order to update rather than duplicate it.

- [x] **Step 2: Update `snuggProAdapter`'s stub to match the new type**

  In `ribo-adapter-snuggpro/src/adapter.ts`, the `write` property (lines 76-85) throws unconditionally — its inferred return type (`Promise<never>`) is already assignable to the new signature, so no logic changes. Confirm this compiles as-is; if the arrow function has an explicit `: Promise<void>` return-type annotation anywhere, remove it so the type is inferred (or update it to the new signature) rather than leaving a stale annotation. Also update the doc comment at line 71 ("The SIGNATURE is honest now — `(fields, ctx, meta) => Promise<void>`") — it describes the pre-this-plan signature and goes stale the moment Step 1 lands; rephrase it to describe the new `Promise<{ uuid }>` signature.

- [x] **Step 3: Update every test-fixture adapter's `write` stub**

  In `adapter.test.ts`:
  - The `makeAdapter` helper (lines 29-48) pushes `{ fields, ctx, meta }` into `sink` inside `write` and returns nothing. Change it to also `return { uuid: `uuid-${meta.idempotencyKey}` }` after the push — deterministic and distinct per call, which later tasks' tests rely on to distinguish receipts from different writes.
  - The six trivial `write: async () => {}` stubs at lines 139, 206, 224, 264, 292, 317 (each inside a `@ts-expect-error` type-level test, unrelated to `write`'s runtime behavior) each become `write: async () => ({ uuid: "unused" })`.

  In `write-step.test.ts`, the `makeAdapter` helper (lines 58-67) gets the identical treatment as `adapter.test.ts`'s: push to `sink`, then `return { uuid: `uuid-${meta.idempotencyKey}` }`. The rejection-only stub at line 267 (`write: () => Promise.reject(failure)`) needs no change — a rejected promise is assignable to any resolved-value type.

  In `instance-write-step.test.ts`:
  - The `makeAdapter` helper (lines 63-72) gets the same treatment: push to `sink`, `return { uuid: `uuid-${meta.idempotencyKey}` }`.
  - The wrapping adapter at lines 256-268 (`failingAdapter`, used by the "failing on the second of three instances" test) currently does `await base.write(fields, ctx, meta);` with no return; change to `return await base.write(fields, ctx, meta);` so the wrapped uuid propagates instead of being silently dropped.
  - The rejection-only stub at line 406 needs no change.
  - The wrapping adapter at lines 448-459 (the reopen-bug regression test) currently does `await base.write(fields, ctx, meta);` with no return; change to `return await base.write(fields, ctx, meta);`, same reasoning as above.

  Two more trivial `write: async () => {}`-shaped stubs exist outside the files above and need the same `write: async () => ({ uuid: "unused" })` treatment: `ribo-adapter-snuggpro/src/round-trip.test.ts:78` and `ribo-core/src/contracts.test.ts:102`. Neither exercises `write`'s runtime behavior (both are structural/round-trip pins), so a fixed placeholder uuid is sufficient.

- [x] **Step 4: Verify nothing else broke**

  Run: `pnpm --filter @azx/ribo-core typecheck && pnpm vitest run packages/ribo-core && pnpm --filter @azx/ribo-adapter-snuggpro typecheck && pnpm vitest run packages/ribo-adapter-snuggpro`
  Expected: every test passes unchanged — this task changes a type and updates stubs to satisfy it, with no behavior change anywhere yet (nothing reads the returned `uuid`).

- [x] **Step 5: Commit**

  Stage `adapter.ts`, `ribo-adapter-snuggpro/src/adapter.ts`, `adapter.test.ts`, `write-step.test.ts`, `instance-write-step.test.ts`, `round-trip.test.ts`, `contracts.test.ts`. Commit message: `feat(core): ToolAdapter.write returns the vendor's created-record uuid`.

---

### Task 2: `resolveReview` computes and exposes `instanceKeys`

**Files:**
- Modify: `packages/ribo-core/src/review.ts` (types at lines 328-354, `resolveReview` at 931-1049, `reviewOutcomeSchema` at 1070-1087)
- Modify: `packages/ribo-ui-react/src/use-review.ts` (`toPersisted` at lines 209-242)
- Modify: `packages/ribo-core/src/review.test.ts` (extending `describe` blocks at lines 947 and 1162; two new tests)
- Modify: `packages/ribo-ui-react/src/use-review.browser.test.tsx` (extending the test at line 809)
- Modify: `packages/ribo-core/src/instance-write-step.test.ts` (every `submitSessionReview`/`seedSession` call that supplies collection-group data — see Step 6; moved here from a later task because this task's own `reviewOutcomeSchema` refine, added in Step 4, is what makes these calls fail their parse in the first place, and a task's own changes should not leave the suite it just touched failing for a later task to fix)

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `ReviewOutcome`'s `accepted`/`edited` variants gain `instanceKeys?: Readonly<Record<string, readonly string[]>>`. Task 3's migration and Task 4's write step both read this field by name.

- [x] **Step 1: Write the failing tests in `review.test.ts`**

  In the `describe("resolveReview — keyed instance paths reassemble into positional arrays", ...)` block (starting line 947), extend four existing tests with one additional assertion each, right beside their existing `linkTargets` assertion:
  - "a keyed path rebuilds as an array..." (line 948): after `expect(outcome.linkTargets).toEqual({ hvac: [null] });`, add `expect(outcome.instanceKeys).toEqual({ hvac: ["k1"] });`.
  - "a present-but-empty collection resolves to an empty array" (line 1016): after its `linkTargets` assertion, add `expect(outcome.instanceKeys).toEqual({ dhw: ["k1"] });` (note: `hvac` is present-but-empty, so it must NOT appear in `instanceKeys` either — add `expect("hvac" in (outcome.instanceKeys ?? {})).toBe(false);`).
  - "removing the first instance does not reattach the remaining decisions to shifted positions" (line 1054): after its `linkTargets` assertion, add `expect(outcome.instanceKeys).toEqual({ hvac: ["k2", "k3"] });` — the direct proof that surviving instances keep their own keys rather than being renumbered `k1, k2`.
  - "two instances resolve to array positions in first-mention order" (line 1103): after its `linkTargets` assertion, add `expect(outcome.instanceKeys).toEqual({ hvac: ["k1", "k2"] });`.

  In the `describe("resolveReview — instance identity: link only when the human decides", ...)` block (starting line 1162), extend "a link decision survives resolveReview..." (line 1192): after its `linkTargets` assertion, add `expect(outcome.instanceKeys).toEqual({ hvac: ["k1"] });` — proving `instanceKeys` is populated independently of whether a link decision exists.

  Add one new test in the first `describe` block, after "an instance whose every leaf was rejected is absent from the patch, not an empty record" (ends line 1014): a test named `"instanceKeys and fields stay in lockstep when one instance of several is fully rejected"`, reusing that same two-instance fixture (first instance `hvac[k1]` fully rejected, second `hvac[k2]` accepted). Assert `outcome.status === "edited"`, then `expect(outcome.instanceKeys).toEqual({ hvac: ["k2"] })` — the surviving instance keeps its real key `k2`, not a renumbered `k1`.

  Add a second new test in the same `describe` block: a fixture with **two** instances where only *some* leaves of the first are accepted and the rest rejected (a partial rejection within one surviving instance, not a full rejection of it) alongside a second, fully-accepted instance. Assert `outcome.instanceKeys` still equals `{ hvac: ["k1", "k2"] }` — a partially-edited instance keeps its key and its place, only a *fully* rejected one is dropped (this is the design's §5 test bullet that a whole-instance-rejection test alone doesn't cover).

  Add a third new test, in a new `describe("reviewOutcomeSchema — instanceKeys length must match fields", ...)` block placed after the "instance identity" describe block (after line 1270): construct a plain object literal (not via `resolveReview`) shaped like `{ status: "accepted", fields: { hvac: [{}, {}] }, instanceKeys: { hvac: ["k1"] } }` (two instances, one key) and assert `reviewOutcomeSchema.safeParse(that).success === false` — the length-mismatch case the refine exists to catch. Add a second assertion in the same test that the identical object with `instanceKeys: { hvac: ["k1", "k2"] }` (matching length) parses successfully.

- [x] **Step 2: Run the new tests to verify they fail**

  Run: `pnpm vitest run packages/ribo-core/src/review.test.ts`
  Expected: FAIL — `outcome.instanceKeys` is `undefined` everywhere, and `reviewOutcomeSchema` has no `instanceKeys` field or refine yet so the schema-mismatch test's `safeParse` calls don't behave as asserted.

- [x] **Step 3: Add `instanceKeys` to the `ReviewOutcome` type and compute it in `resolveReview`**

  In `review.ts`, add `readonly instanceKeys?: Readonly<Record<string, readonly string[]>>;` to both the `accepted` and `edited` branches of the `ReviewOutcome` type (lines 328-354), immediately after each branch's existing `linkTargets` member, with a doc comment: real per-instance keys (`k1`, `k2`, ...), aligned by position with the same group's array in `fields` — see `buildInstanceKeys`.

  Add a new function `buildInstanceKeys`, directly above `buildLinkTargets` (before line 799), following the same shape as `buildLinkTargets` (lines 799-817) but simpler — it takes only `positions: Map<string, Map<string, number>>` (no `instanceLinks` parameter) and returns `Readonly<Record<string, readonly string[]>>`: for each `[groupPath, indexMap]` in `positions`, build an array of length `indexMap.size`, and for each `[key, index]` in `indexMap`, set `array[index] = key`. Return the per-group arrays keyed by `groupPath`.

  In `resolveReview` (around lines 1038-1048, right where `linkTargets`/`hasLinkTargets` are computed), add `const instanceKeys = buildInstanceKeys(positions);` and `const hasInstanceKeys = Object.keys(instanceKeys).length > 0;`. Extend the four return branches (accepted-with-links, accepted-without, edited-with-links, edited-without) to also spread in `...(hasInstanceKeys ? { instanceKeys } : {})` — matching the existing conditional-spread pattern already used there for `linkTargets`.

- [x] **Step 4: Add `instanceKeys` to `reviewOutcomeSchema`, with the length-parity refine**

  In `reviewOutcomeSchema` (lines 1070-1087), add `instanceKeys: z.record(z.string(), z.array(z.string())).optional()` to both the `accepted` and `edited` `z.strictObject(...)` branches, alongside the existing `linkTargets` line.

  Wrap the whole `z.discriminatedUnion(...)` in a `.superRefine(...)` (this repo's zod version, pinned in `pnpm-workspace.yaml`, supports `.superRefine`/`.refine` composed with a discriminated union and with the `.optional()` wrapper `session-schema.ts:172` applies around the whole thing) that, for `accepted`/`edited` values only, checks every key `g` of `value.fields` where `Array.isArray(value.fields[g])` and `value.fields[g].length > 0`: `value.instanceKeys?.[g]` must exist and have the same length as `value.fields[g]`. On failure, call `ctx.addIssue(...)` with a message naming the offending group path and both lengths, in the style of this file's other validation messages (see `invalidValueMessage`, lines 686-697, for the tone to match). Note for later tasks: a refine failure surfaces to a caller of `submitSessionReview` as a thrown `ZodError` (from `reviewOutcomeSchema.parse` at `outbox.ts:730`), not a `ReviewValidationError` — the two are different failure types from different layers, and Step 1's `safeParse` test above is deliberately written against the schema directly rather than through `submitSessionReview`, so it doesn't need to distinguish them.

- [x] **Step 5: Run the tests again to verify they pass**

  Run: `pnpm vitest run packages/ribo-core/src/review.test.ts`
  Expected: PASS.

- [x] **Step 6: Add `instanceKeys` to every hand-built collection-group review outcome in `instance-write-step.test.ts`**

  This step exists because Step 4's refine, once merged, makes every one of these calls fail `reviewOutcomeSchema.parse` inside `Outbox.submitSessionReview` — this file never calls `buildReviewRequest`/`resolveReview`, so nothing computes `instanceKeys` for it automatically. Add a matching `instanceKeys` entry (one string per array element, sequential `"k1"`, `"k2"`, ... unless noted otherwise) to every `submitSessionReview` call in the file that supplies collection-group array data:
  - `seedSession`'s own `submitSessionReview` call (around line 131) — parameterize it to accept and pass through an `instanceKeys` value matching whatever `fields` its caller supplies, since `seedSession` is reused by many tests with different `hvac` array shapes.
  - The inline `submitSessionReview` call in "a write failing on the second of three instances, then retrying, re-attempts the first" (lines 292-301, a 3-instance `hvac` array): `instanceKeys: { hvac: ["k1", "k2", "k3"] }`.
  - The reopen-bug test's two `submitSessionReview` calls (lines 483-488 and 511-516): the first (2 instances, Furnace + AC) gets `instanceKeys: { hvac: ["k1", "k2"] }`. The second, post-removal call (1 surviving instance, AC) gets `instanceKeys: { hvac: ["k2"] }` — **deliberately not `["k1"]`**, and this is worth a one-line comment in the test explaining why: the point of this fixture is to prove the write step keys receipts by whatever key the reviewed outcome actually declares, not by array position. Choosing a key that *matches* what position-based keying would produce (`"k1"` at index 0) would let a broken, position-based implementation pass this test by coincidence. (Note, for whoever reads this later: a *real* reopen via the actual review UI would, per `use-review.ts`'s `remapAfterInstanceRemove`, renumber the survivor to `k1` when the first of two instances is removed client-side before submit — this hand-built fixture bypasses that UI path entirely, on purpose, to isolate and stress-test the write step's own keying behavior independent of what any particular UI flow would produce.)

- [x] **Step 7: Thread `instanceKeys` through `use-review.ts`'s `toPersisted`**

  In `use-review.ts`, `toPersisted` (lines 209-242) currently builds `mutable` and then, only if `outcome.linkTargets` is present, returns a copy with `linkTargets` converted from readonly arrays to plain mutable arrays via one early return. Restructure so both `linkTargets` and the new `instanceKeys` can be added independently without one clobbering the other: build a `let result: PersistedReviewOutcome = mutable;` after the existing `mutable` construction, then `if (outcome.linkTargets) result = { ...result, linkTargets: Object.fromEntries(Object.entries(outcome.linkTargets).map(([group, targets]) => [group, [...targets]])) };` (unchanged conversion, just reassigned instead of returned), then a parallel `if (outcome.instanceKeys) result = { ...result, instanceKeys: Object.fromEntries(Object.entries(outcome.instanceKeys).map(([group, keys]) => [group, [...keys]])) };`, then `return result;` at the end (replacing the old two-branch `if`/`return`).

- [x] **Step 8: Extend the end-to-end hook test**

  In `use-review.browser.test.tsx`, extend "linking an instance survives submit and reaches the outcome as an update target" (line 809): add `instanceKeys: { hvac: ["k1"] }` to both `toMatchObject` calls (the in-memory `outcome` at line 822 and the `persisted?.reviewOutcome` at line 831) — proving the real hook path (not a hand-built literal) produces and persists real keys end to end.

- [x] **Step 9: Run the full test suites**

  Run: `pnpm vitest run packages/ribo-core && pnpm vitest run packages/ribo-ui-react`
  Expected: PASS, including every test touched in Steps 1, 6 and 8.

- [x] **Step 10: Commit**

  Stage `review.ts`, `review.test.ts`, `use-review.ts`, `use-review.browser.test.tsx`, `instance-write-step.test.ts`. Commit message: `feat(core): resolveReview exposes real per-instance keys via instanceKeys`.

---

### Task 3: Sessions schema v1 → v2 — add `receipts`, backfill `instanceKeys`

**Files:**
- Modify: `packages/ribo-core/src/queue/session-schema.ts` (schema at lines 94-181, migration strategies at 241-243, RxDB schema at 245-291)
- Modify: `packages/ribo-core/src/queue/session-schema.test.ts` (the field-parity pin around lines 37-48, and the version pin near line 68-75 — see Step 1)

**Interfaces:**
- Consumes: `instanceKeys` field name and shape from Task 2.
- Produces: `SessionDocument.receipts?: { singleton?: string; instances?: Readonly<Record<string, Readonly<Record<string, string>>>> }`, consumed by Task 4's write-step changes and `relay.ts`.

- [x] **Step 1: Write the failing migration tests**

  No test today actually *executes* a session-collection migration (`session-schema.test.ts` pins the schema's shape and version; strategy *registration* is separately touched by `outbox-reopen-cross-tab.browser.test.ts:122`) — this task adds the first one(s). In `session-schema.test.ts`, add:
  - A test asserting that a v1 document with `reviewOutcome: { status: "accepted", fields: { hvac: [{ hvacSystemEquipmentType: "Boiler" }, { hvacSystemEquipmentType: "Furnace" }] } }` (no `instanceKeys`) migrates, via `SESSION_MIGRATION_STRATEGIES[2]`, to a document whose `reviewOutcome.instanceKeys` equals `{ hvac: ["k1", "k2"] }`.
  - A test asserting that a v1 document with no `reviewOutcome` at all migrates to an unchanged document (no `receipts`, no `reviewOutcome` added) — the identity half.
  - A test asserting that a v1 document whose `reviewOutcome.status` is `"discarded"` migrates unchanged (no `fields` to derive keys from, and none needed).
  - A test asserting that a v2 document already carrying both `receipts` and a fully-populated `reviewOutcome.instanceKeys` round-trips through the migration function unchanged (idempotence for a document that's already current).

  Also extend the hardcoded `optionalKeys` list at `session-schema.test.ts:37-48` (the field-parity pin between the zod schema and the RxDB schema) to include `receipts`, and bump whatever test currently asserts `sessionRxSchema.version === 1` (near lines 68-75) to expect `2`.

- [x] **Step 2: Run the tests to verify they fail**

  Run: `pnpm vitest run packages/ribo-core/src/queue/session-schema.test.ts`
  Expected: FAIL — `SESSION_MIGRATION_STRATEGIES` has no `2` entry yet, and the schema has no `receipts` property.

- [x] **Step 3: Add `receipts` to `sessionDocumentSchema` and `sessionRxSchema`**

  In `session-schema.ts`, add to `sessionDocumentSchema` (after the `writeResult` field, line 174): `receipts: z.object({ singleton: z.string().optional(), instances: z.record(z.string(), z.record(z.string(), z.string())).optional() }).optional()`, with a doc comment: the vendor uuid(s) returned by `write`, keyed by instance key — the durable channel a future amend reads, not cleared on reopen (contrast with `reviewOutcome`, which is).

  In `sessionRxSchema`'s `properties` (after `writeResult`, line 270): `receipts: { type: "object" }` (loose, same reasoning as `extracted`/`writeResult` — one document schema across every host tool's field set).

- [x] **Step 4: Write the v1→v2 migration function**

  Change `SESSION_MIGRATION_STRATEGIES` (lines 241-243) from `{ 1: (doc) => doc }` to also include a `2` entry. The `2` function: given `doc: SessionDocument` (the v1 shape), if `doc.reviewOutcome` is undefined or its `status` is `"discarded"`, return `doc` unchanged. Otherwise, for each key `g` in `doc.reviewOutcome.fields` where `Array.isArray(doc.reviewOutcome.fields[g])` and the array is non-empty, and `doc.reviewOutcome.instanceKeys?.[g]` is missing: synthesize `["k1", "k2", ..., "kN"]` where `N` is that array's length, and merge it into a new `instanceKeys` object alongside any that were already present (there shouldn't be any, since this is a v1→v2 migration of documents that never had the field, but preserve them defensively rather than assuming). Return a new document with `reviewOutcome` replaced by `{ ...doc.reviewOutcome, instanceKeys: <the merged object> }`, leaving `receipts` absent (v1 documents never had writes with returned uuids).

  Update the doc comment above `SESSION_MIGRATION_STRATEGIES` (lines 217-240) to describe this v1→v2 step alongside the existing v0→v1 description, following the same "declared and exercised rather than skipped" reasoning already there. Note in that comment that this is the schema version the sibling `roster-absence` plan's Task 3 also extends (adding `statedEmptyGroups`) — a reader who lands there first should know this v2 schema isn't "finished" the moment this task's commit lands.

- [x] **Step 5: Bump `sessionRxSchema.version` to `2`**

  Change `version: 1` to `version: 2` (line 246).

- [x] **Step 6: Run the tests to verify they pass**

  Run: `pnpm vitest run packages/ribo-core/src/queue/session-schema.test.ts`
  Expected: PASS.

- [x] **Step 7: Run the full `ribo-core` suite**

  Run: `pnpm --filter @azx/ribo-core typecheck && pnpm vitest run packages/ribo-core`
  Expected: PASS — this step catches any other test in the package that constructs a `SessionDocument`/`SessionItem` literal and pins its schema version or field set (e.g. `queue/outbox-memory.test.ts`, `queue/session-outbox.test.ts`) needing a matching update.

- [x] **Step 8: Commit**

  Stage `session-schema.ts`, `session-schema.test.ts`, and any other files Step 7 required touching. Commit message: `feat(core): sessions schema v2 adds receipts and backfills instanceKeys`.

---

### Task 4: The write step captures uuids and persists them as receipts

**Files:**
- Modify: `packages/ribo-core/src/queue/relay.ts` (`SessionWriteInput`/`SessionWriteStep` types at lines 55-75, `#sessionWrite` at 413-453, and its stale doc comment at line 74)
- Modify: `packages/ribo-core/src/write-step.ts` (lines 66-92)
- Modify: `packages/ribo-core/src/instance-write-step.ts` (lines 62-115, and its stale doc comment at lines 17-24)
- Modify: `packages/ribo-core/src/write-step.test.ts` (extend the happy-path test at line 90)
- Modify: `packages/ribo-core/src/instance-write-step.test.ts` (extend the happy-path tests and the reopen-bug test — the `instanceKeys` fixture additions themselves were already made in Task 2 Step 6)
- Modify: `packages/ribo-core/src/queue/relay.browser.test.ts` (three `SessionWriteStep` doubles that return a bare object instead of `{ fields: {...} }} — see Step 8)

**Interfaces:**
- Consumes: `ToolAdapter.write`'s new return shape (Task 1), `ReviewOutcome.instanceKeys` (Task 2), `SessionDocument.receipts` (Task 3).
- Produces: `SessionWriteResult { fields?: ExtractedFieldMap; receipts?: { singleton?: string; instances?: Readonly<Record<string, Readonly<Record<string, string>>>> } }`, and `relay.ts` persists it onto `session.receipts` (merged, additive) and `session.writeResult` (as today).

- [x] **Step 1: Write the failing tests**

  Extend "each instance's derived key is stable across retries and distinct between instances" (line 147): after the existing assertions, assert that calling `step(input)` returns a `SessionWriteResult` whose `receipts.instances.hvac` equals `{ k1: "uuid-<the derived key for instance 0>", k2: "uuid-<the derived key for instance 1>" }` (using the fixture adapter's `uuid-${idempotencyKey}` convention from Task 1) after the first call, and that calling it again returns the same values (idempotent re-derivation, not accumulation of duplicates).

  Extend "singleton groups are written once..." (line 182): assert the returned `SessionWriteResult.receipts.singleton` equals the derived uuid for the singleton write, and `receipts.instances.hvac` equals `{ k1: "<uuid>" }`.

  Extend the reopen-bug test ("after reopening from dead and removing the first instance...", line 436): after the final assertions (lines 538-547), assert that the second drain's resolved `SessionWriteResult.receipts.instances.hvac` is `{ k2: "<the AC instance's uuid>" }` — keyed by the survivor's real key `k2` (per Task 2 Step 6's fixture, which deliberately supplies `k2` rather than a renumbered `k1` — see that step's note on why), proving receipts are keyed by whatever the reviewed outcome declares rather than by array position. (`toInstanceWriteStep`'s produced function needs to be captured from the relay's `sessionWrite` option and its return value inspected directly — the relay itself doesn't expose the resolved `SessionWriteResult`, so this assertion should call the produced step function directly with the same `session`/`reviewed`/`ctx` inputs used to seed the second `submitSessionReview`, in addition to running it through the relay for the status/side-effect assertions already there.)

  In `write-step.test.ts`, extend "the reviewed patch and the session's ctx reach write, both parsed" (line 90): assert the step's resolved value equals `{ receipts: { singleton: "uuid-key-session-1" } }` (matching the fixture's `uuid-${meta.idempotencyKey}` convention).

- [x] **Step 2: Run the tests to verify they fail**

  Run: `pnpm vitest run packages/ribo-core/src/write-step.test.ts packages/ribo-core/src/instance-write-step.test.ts`
  Expected: FAIL — `toWriteStep`/`toInstanceWriteStep` still resolve `void`.

- [x] **Step 3: Define `SessionWriteResult` and update `SessionWriteStep`**

  In `relay.ts`, add a new exported interface directly above `SessionWriteStep` (before line 75): `SessionWriteResult { readonly fields?: ExtractedFieldMap; readonly receipts?: { readonly singleton?: string; readonly instances?: Readonly<Record<string, Readonly<Record<string, string>>>> } }`, with a doc comment: `fields` is unchanged from today's bare return value (persisted as `writeResult`); `receipts` is new and persisted onto `session.receipts`, additively.

  Change `SessionWriteStep`'s type (line 75) from `(input: SessionWriteInput) => Promise<ExtractedFieldMap | void>` to `(input: SessionWriteInput) => Promise<SessionWriteResult | void>`. Update the doc comment at line 74 ("Anything returned is persisted as `writeResult`") — after this task, only `result.fields` is; `result.receipts` is persisted onto a different field. Rephrase to describe both channels.

- [x] **Step 4: Update `toWriteStep` to capture the uuid**

  In `write-step.ts`, change line 90 from `await adapter.write(fields.data, parsedCtx.data, { idempotencyKey });` to capture the result: `const { uuid } = await adapter.write(fields.data, parsedCtx.data, { idempotencyKey });`, then `return { receipts: { singleton: uuid } };` as the function's final statement. Update the function's declared return type from `Promise<void>` to `Promise<SessionWriteResult>` and import `SessionWriteResult` from `./queue/relay.js`.

- [x] **Step 5: Update `toInstanceWriteStep` to accumulate receipts keyed by real instance key**

  In `instance-write-step.ts`:
  - Update the stale doc comment at lines 17-24 ("The receipts work will need a durable channel again...") — this task *is* that work; rephrase to describe what actually landed (the `SessionWriteResult.receipts` return channel) rather than describing it as still-future.
  - Change the function's declared return type from `Promise<void>` to `Promise<SessionWriteResult>`, importing `SessionWriteResult` from `./queue/relay.js`.
  - Before the singleton-write block (line 98), declare `const receipts: { singleton?: string; instances: Record<string, Record<string, string>> } = { instances: {} };`.
  - At the singleton-write call (lines 98-102), capture the result: `const { uuid } = await adapter.write(...)`, then `receipts.singleton = uuid;`.
  - Inside the per-instance loop (lines 104-113), capture the per-instance key from the session's persisted review outcome: read `session.reviewOutcome` (already destructured or accessible via the `session` in `SessionWriteInput`), check its `status !== "discarded"`, and read `instanceKey = session.reviewOutcome.instanceKeys?.[group]?.[index]`. Since Task 2's refine guarantees this is present whenever `instances.length > 0` for a real submission, this read should always succeed for correctly-migrated data; if it's somehow missing (defense in depth for a caller that bypassed the schema, e.g. via a lower-level RxDB write), throw a `TerminalQueueError` naming the session, the group and the index, since receipts cannot be safely recorded without a real key — do not fall back to the index itself, which would silently reintroduce the exact bug this design exists to avoid.
  - Capture each `adapter.write(...)` call's result: `const { uuid } = await adapter.write(...)`, then set `receipts.instances[group] ??= {}; receipts.instances[group][instanceKey] = uuid;`.
  - At the end of the function, `return { receipts: { ...(receipts.singleton !== undefined ? { singleton: receipts.singleton } : {}), ...(Object.keys(receipts.instances).length > 0 ? { instances: receipts.instances } : {}) } };`.

- [x] **Step 6: Update `relay.ts`'s `#sessionWrite` to persist `receipts`**

  In `relay.ts`, `#sessionWrite` (lines 413-453): the current code binds `writeResult` directly to `sessionWrite(...)`'s resolved value and spreads `...(writeResult ? { writeResult } : {})` into the session patch. Change the binding name to `result` and update the patch: `...(result?.fields ? { writeResult: result.fields } : {})` (renamed field access, same meaning as before), plus a new merge for receipts. Write a small local helper (above `#sessionWrite` or as a module-level function) `mergeReceipts(previous: SessionDocument["receipts"], next: SessionWriteResult["receipts"]): SessionDocument["receipts"] | undefined` that: returns `previous` unchanged if `next` is undefined; otherwise builds `instances` by starting from `{ ...previous?.instances }` and, for each `[group, byKey]` in `next.instances ?? {}`, sets `instances[group] = { ...instances[group], ...byKey }` (per-group merge, not replace); returns `undefined` only if there is nothing at all to persist (no `next.singleton`, no `previous?.singleton`, and no instance entries), otherwise an object with `singleton` (next's if present, else previous's) and `instances` (only included if non-empty). In `#sessionWrite`, compute `const receipts = mergeReceipts(session.receipts, result?.receipts);` and add `...(receipts ? { receipts } : {})` to the patch alongside the existing fields.

- [x] **Step 7: Run the tests to verify they pass**

  Run: `pnpm vitest run packages/ribo-core/src/write-step.test.ts packages/ribo-core/src/instance-write-step.test.ts`
  Expected: PASS.

- [x] **Step 8: Fix the `relay.browser.test.ts` write-stub doubles**

  `relay.browser.test.ts` defines `SessionWriteStep` doubles that return `{ remoteId: "snugg-1" }` directly (not wrapped in `{ fields: ... }`) at three sites: lines 172-176, 806-810 and 1935-1938. Under `SessionWriteResult`'s new shape these still compile (structural typing admits the extra key sitting where `fields`/`receipts` would go, since the object satisfies `SessionWriteResult | void`'s optional members trivially by having neither), but `result.fields` is now `undefined` for all three, so `writeResult` stops being persisted — silently breaking the assertions at lines 339 and 1318 that check `session.writeResult` equals `{ remoteId: "snugg-1" }`. Change all three doubles to `return { fields: { remoteId: "snugg-1" } };`.

- [x] **Step 9: Run the full suite**

  Run: `pnpm --filter @azx/ribo-core typecheck && pnpm vitest run packages/ribo-core`
  Expected: PASS.

- [x] **Step 10: Commit**

  Stage `relay.ts`, `write-step.ts`, `instance-write-step.ts`, `write-step.test.ts`, `instance-write-step.test.ts`, `relay.browser.test.ts`. Commit message: `feat(core): the write step captures vendor uuids and persists them as receipts`.

---

## Out of scope (confirmed against the design doc)

Nothing in this plan makes the write step *read* `session.receipts` back to decide "update, don't create." That is separate, future work, gated on Snugg Pro egress landing (Asana task 1218075751169739 stays open until it ships).

## Reviewed

This plan was reviewed by OpenCode (`kimi-k3`, run 4926) before implementation. Findings applied: moved the `instance-write-step.test.ts` fixture updates (adding `instanceKeys` to every hand-built collection-group review outcome) from Task 4 into Task 2, since Task 2's own refine is what breaks those fixtures — Task 2's exit gate was previously unreachable; corrected the reopen-bug test's rationale for choosing `instanceKeys: { hvac: ["k2"] }` over `["k1"]` (it's a deliberate choice to distinguish real-key-based keying from position-based keying, not a claim about what the real review UI would produce for that scenario — a real UI-driven removal actually renumbers the survivor to `k1`, per `use-review.ts`'s `remapAfterInstanceRemove`); enumerated the two additional void-returning `write` stubs (`round-trip.test.ts:78`, `contracts.test.ts:102`) and the three `relay.browser.test.ts` write-stub doubles that silently stop persisting `writeResult` under the new shape (Task 4 Step 8); fixed every `pnpm --filter <pkg> test` command to the actual `pnpm vitest run <path>` form; corrected Task 3 Step 1's instruction, which implied an existing executed-migration test pattern that doesn't exist yet; added a partial-rejection-within-one-instance test and a v2 round-trip test (both named as design §5 gaps); and flagged three doc comments that go stale as part of this plan's changes (`ribo-adapter-snuggpro/src/adapter.ts:71`, `instance-write-step.ts:17-24`, `relay.ts:74`), now updated in Tasks 1 and 4 rather than left describing pre-change behavior.
