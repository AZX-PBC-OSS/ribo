# Roster Absence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A roster group can carry a verbatim-grounded "the transcript states there are none of these" signal, distinct from both "populated" and "never mentioned" — reaching all the way to the review canvas so it can render a quote instead of a hardcoded "none described."

**Architecture:** A new union value on the roster's per-group schema, threaded as one new field through the extractor's `ExtractionResult`, given its own session field (matching the codebase's existing `extractedBy`/`extractionUsage` pattern), consulted by `buildReviewRequest` to produce a fourth `ReviewGroupState`, and rendered by the one playground component that already switches on group state.

**Tech Stack:** TypeScript, zod, RxDB, React, Vitest.

**Spec:** `docs/roadmap/design/roster-absence-design.md`

## Global Constraints

- The roster stays internal-only in every other respect — `discriminator`, `mentionSpan`, `distinguishedBy` are not touched or persisted. Only the one new "stated none" signal crosses into `ExtractionResult`.
- `statedEmptyGroups` gets its **own** session field, matching `extractedBy`/`extractionUsage` (`session-schema.ts:136-158`) — never folded into the opaque `extracted` blob.
- **This plan's session-schema change (Task 3) rides the same sessions v1→v2 migration `docs/roadmap/design/instance-write-receipts-plan.md`'s Task 3 introduces. Land that plan's Task 3 first.** If, at implementation time, it has not landed yet, bump `sessionRxSchema.version` to `2` here and leave an explicit comment for the sibling plan's Task 3 to extend the same v2 schema/migration rather than claim v3 — but landing receipts' Task 3 first is the default and avoids that coordination entirely.
- `"absent"`, `"empty"` and `"statedEmpty"` are three different claims (never mentioned / present-but-empty with no stated reason / present-but-empty with a stated reason) — no code path should collapse any two of them.
- Tests run from the repo root via Vitest's own path filtering, **not** a per-package `test` script (none of these packages define one — only `typecheck`/`build`). Use `pnpm vitest run packages/<dir>` (whole package) or `pnpm vitest run packages/<dir>/src/<file>.test.ts` (one file), per `AGENTS.md`'s own example. `pnpm --filter @azx/<pkg> typecheck` (and `playground`'s own `typecheck`) remain correct as written — only `test` invocations change.

---

### Task 1: The roster's per-group zod schema gains a "stated none" value

**Files:**
- Modify: `packages/ribo-adapter-snuggpro/src/inventory.ts` (lines 61-78, and the instructions at 84-159)
- Test: `packages/ribo-adapter-snuggpro/src/inventory.test.ts` (create if it does not already exist, following whatever pattern this package's other `*.test.ts` files use for testing a bare zod schema — check `packages/ribo-adapter-snuggpro/src/adapter.test.ts` for the house style first)

**Interfaces:**
- Produces: `rosterGroupSchema` (zod) accepts, per group, either an array of candidates or `{ readonly stated: "none"; readonly span: string }`.

**Scope note:** this task touches only the vendor-specific zod schema and its instructions, not `instance-fill.ts`'s generic `Roster` interface — that change moves to Task 2, alongside the code that actually consumes it, so this task's own typecheck gate isn't broken by a consumer this task doesn't update.

- [x] **Step 1: Write the failing schema tests**

  In a new or existing `inventory.test.ts`, add assertions that `rosterGroupSchema.safeParse([])` still succeeds (an empty array stays a valid "no candidates recorded" value, unchanged), `rosterGroupSchema.safeParse({ stated: "none", span: "there's no attic" }).success` is `true`, `rosterGroupSchema.safeParse({ stated: "none" }).success` is `false` (missing `span`), and `rosterGroupSchema.safeParse({ stated: "none", span: "" }).success` is `false` (empty string is not a real quote — use `.min(1)` on the span, matching the house convention that a grounding span is never blank).

- [x] **Step 2: Run the tests to verify they fail**

  Run: `pnpm vitest run packages/ribo-adapter-snuggpro/src/inventory.test.ts`
  Expected: FAIL — `rosterGroupSchema` has no union branch for `{ stated: "none" }` yet.

- [x] **Step 3: Change `rosterGroupSchema` to a union**

  In `inventory.ts`, change `rosterGroupSchema` (lines 61-69) from `z.array(rosterCandidateSchema).refine(...)` to `z.union([z.array(rosterCandidateSchema).refine(...) /* unchanged, the existing refine */, z.strictObject({ stated: z.literal("none"), span: z.string().min(1) })])`. Keep the existing `.refine` exactly as it is on the array branch.

  Update the roster schema's doc comment (lines 1-19) to mention the new "stated none" value as the fourth grounding mechanism (existence/separation/exclusion/absence), matching the design doc's own framing.

  Update `INVENTORY_PREAMBLE` (the instructions string, lines 84-159): add a new rule (after rule 4, "Exclusion needs a span") explaining that when the auditor explicitly states a component type does not exist in the property (e.g. "there's no attic," "no supplemental heating"), emit `{ "stated": "none", "span": "<verbatim quote>" }` for that group instead of an empty array — and that an empty array still means "the model found nothing to report," used when the transcript never brings the group up at all. Update the "Output" section (lines 151-159) to describe the three possible per-group shapes: a candidate array, an empty array, or the stated-none object.

- [x] **Step 4: Run the tests to verify they pass**

  Run: `pnpm vitest run packages/ribo-adapter-snuggpro/src/inventory.test.ts && pnpm --filter @azx/ribo-adapter-snuggpro typecheck`
  Expected: PASS.

- [x] **Step 5: Commit**

  Commit message: `feat(adapter-snuggpro): roster groups can state there are none of a component`.

---

### Task 2: The generic `Roster` type and `scopedInstanceExtractor` both handle the union

**Files:**
- Modify: `packages/ribo-extractor-openai/src/instance-fill.ts` (`Roster` at lines 54-57; `extract()` at 398-556, specifically lines 409-433 and 549-553)
- Modify: `packages/ribo-core/src/extractor.ts` (lines 61-84)
- Test: `packages/ribo-extractor-openai/src/instance-fill.test.ts` (locate the existing test(s) that construct a fake `inventory` callback and assert on `extract()`'s return value — follow that exact pattern; the fixture there has exactly one collection group today, so this task's new test needs at least a second collection group added to the fixture to exercise "one stated-none, one genuinely empty" side by side)

**Interfaces:**
- Consumes: Task 1's zod union (informs the shape, not a runtime dependency — this task's TS interface and Task 1's zod schema are declared independently, same as `RosterCandidate` already is today).
- Produces: `Roster`'s index-signature value type becomes `readonly RosterCandidate[] | { readonly stated: "none"; readonly span: string }`; `ExtractionResult<F>.statedEmptyGroups?: Readonly<Record<string, string>>`, consumed by Task 3's `toSessionExtractStep`.

- [x] **Step 1: Write the failing test**

  In `instance-fill.test.ts`, extend the fixture (if needed) to have at least two collection groups, then write a test where the fake `inventory` returns, for one collection group, `{ stated: "none", span: "there's no attic access" }` instead of an array, and for the other, a genuinely empty array `[]`. Assert the resolved `ExtractionResult.statedEmptyGroups` equals `{ [thatGroupKey]: "there's no attic access" }` — and that the genuinely-empty group's key is **absent** from `statedEmptyGroups` (not present with an empty string or `null`). Also assert the stated-none group makes zero fill calls (no `ChatClient` request for it) and that its `groupResult`/final `fields[groupKey]` is still `[]`, same as today's empty-array case — a stated-none group is not filled, same as an empty one.

  Also add a test confirming a **singleton** group (non-collection) is unaffected by this change even if a test's fake `inventory` were to (incorrectly) return a stated-none-shaped value for a singleton key — the union only has meaning for collection groups, and the singleton branch (lines 411-426) must run exactly as it does today regardless of what `roster[group.key]` holds for a non-collection key.

- [x] **Step 2: Run the test to verify it fails**

  Run: `pnpm vitest run packages/ribo-extractor-openai/src/instance-fill.test.ts`
  Expected: FAIL — `Roster`'s type doesn't admit the union yet, and `roster[group.key].filter(...)` is currently assumed to always work.

- [x] **Step 3: Update the generic `Roster` interface**

  In `instance-fill.ts`, change `Roster` (lines 54-57) from `{ readonly [groupKey: string]: readonly RosterCandidate[] }` to `{ readonly [groupKey: string]: readonly RosterCandidate[] | { readonly stated: "none"; readonly span: string } }`.

- [x] **Step 4: Handle the union value in `extract()`, inside the collection branch only**

  In `extract()`'s per-group loop, the union check must sit **after** the singleton branch (lines 411-426 unchanged, in full, exactly as today), not before it — a stated-none value is only meaningful for a collection group, and checking before the singleton branch would misroute a (hypothetically) stated-none-shaped value under a singleton key. Immediately after the singleton branch's block (i.e., right before the current `const current = rosterGroup.filter(...)` line, 428), insert: if `rosterGroup` is not an array (i.e., it's the `{ stated: "none", span }` shape), record `statedEmptyGroups[group.key] = rosterGroup.span` (declare `const statedEmptyGroups: Record<string, string> = {};` before the loop, alongside `collectionArrays`/`groupResult`), set `groupResult[group.key] = []`, and `continue` to the next group — skipping the fill-scheduling logic entirely, since there's nothing to fill. Only reach `const current = rosterGroup.filter(...)` once `rosterGroup` is confirmed to be an array by this check.

- [x] **Step 5: Surface it on the returned `ExtractionResult`**

  At the function's final return (lines 549-553), add `...(Object.keys(statedEmptyGroups).length > 0 ? { statedEmptyGroups } : {})` alongside `fields`/`raw`/`usage`.

  In `ribo-core/src/extractor.ts`, add `readonly statedEmptyGroups?: Readonly<Record<string, string>>;` to `ExtractionResult<F>` (after `usage`, line 83), with a doc comment: per-group verbatim spans where the roster recorded an explicit "none of these," surfaced from `scopedInstanceExtractor` — absent for any extractor that does not use a roster.

- [x] **Step 6: Run the tests to verify they pass**

  Run: `pnpm vitest run packages/ribo-extractor-openai/src/instance-fill.test.ts`
  Expected: PASS.

- [x] **Step 7: Run the full suites**

  Run: `pnpm --filter @azx/ribo-extractor-openai typecheck && pnpm vitest run packages/ribo-extractor-openai && pnpm --filter @azx/ribo-core typecheck`
  Expected: PASS.

- [x] **Step 8: Commit**

  Commit message: `feat(extractor-openai): scopedInstanceExtractor surfaces stated-empty groups`.

---

### Task 3: A dedicated session field carries `statedEmptyGroups`, cleared on re-extraction

**Files:**
- Modify: `packages/ribo-core/src/queue/relay.ts` (`ExtractStepResult` at lines 37-50, `#sessionExtract` at 391-411)
- Modify: `packages/ribo-core/src/extractor.ts` (`toSessionExtractStep` at lines 132-140)
- Modify: `packages/ribo-core/src/queue/session-schema.ts` (as an addition to the v2 schema/migration — see Global Constraints)
- Test: `packages/ribo-core/src/queue/session-schema.test.ts`, and wherever `toSessionExtractStep` is currently tested (locate via the existing `engine`/`usage` forwarding test)

**Interfaces:**
- Consumes: `ExtractionResult.statedEmptyGroups` from Task 2.
- Produces: `SessionDocument.statedEmptyGroups?: Readonly<Record<string, string>>`, consumed by Task 4.

- [x] **Step 1: Write the failing tests**

  Wherever `toSessionExtractStep` is tested today (find the test asserting `result.engine`/`result.usage` forwarding), add a case where the fake `Extractor`'s `extract()` resolves with a `statedEmptyGroups` value, and assert the produced `ExtractStepResult` carries it through unchanged.

  In `session-schema.test.ts`: confirm the sibling plan's (`instance-write-receipts-plan.md`) v1→v2 migration tests already exist in this worktree (Global Constraints says that plan's Task 3 lands first) — extend its field-parity pin to also include `statedEmptyGroups`, and add one test: a v1 document with no `statedEmptyGroups` migrates to a v2 document still lacking it (pure addition, no backfill needed — there is no historical roster-absence signal to recover). Add a second test proving staleness doesn't survive a re-extraction: a session that already carries `statedEmptyGroups: { hvac: "..." }` from a prior extraction, when `#sessionExtract` runs again (Step 3 below) with a fresh `ExtractStepResult` carrying no `statedEmptyGroups` at all, ends up with `statedEmptyGroups` cleared (`undefined`), not left stale from the prior run.

- [x] **Step 2: Run the tests to verify they fail**

  Run: `pnpm vitest run packages/ribo-core`
  Expected: FAIL on the new assertions.

- [x] **Step 3: Update `ExtractStepResult` and `#sessionExtract` — always-set, not conditionally spread**

  In `relay.ts`, add `readonly statedEmptyGroups?: Readonly<Record<string, string>>;` to `ExtractStepResult` (lines 37-50), beside `usage`.

  In `#sessionExtract` (lines 391-411), add `statedEmptyGroups: result.statedEmptyGroups` to the session patch as an **unconditional** field (not the `...(x !== undefined ? {...} : {})` conditional-spread pattern `extractedBy`/`extractionUsage` use). This is deliberate, not an inconsistency with the existing style: `extractedBy`/`extractionUsage` are optional *transport metadata* that a later extractor run may simply not report, so leaving a prior run's value in place is harmless; `statedEmptyGroups` is *content about this specific transcript*, exactly like `extracted` itself (which is always overwritten, never conditionally spread). A re-extraction whose new roster no longer states a group is empty must not leave a stale quote from the previous extraction on the session — the same reasoning `lastError: undefined` already uses at line 450 to actively clear a field rather than merely omit setting it.

- [x] **Step 4: Update `toSessionExtractStep`**

  In `extractor.ts` (lines 132-140), add `statedEmptyGroups: result.statedEmptyGroups` to the returned object, alongside `fields`/`engine`/`usage`.

- [x] **Step 5: Add `statedEmptyGroups` to the session schema**

  In `session-schema.ts`: add `statedEmptyGroups: z.record(z.string(), z.string()).optional()` to `sessionDocumentSchema` (after `receipts`, assuming the sibling plan's Task 3 has already added it per this plan's Global Constraints), and `statedEmptyGroups: { type: "object" }` to `sessionRxSchema.properties`. This is a purely additive optional field on the *existing* v2 schema/migration — no change to the migration function itself, and no version bump beyond what the sibling plan's Task 3 already performed.

- [x] **Step 6: Run the tests to verify they pass**

  Run: `pnpm vitest run packages/ribo-core`
  Expected: PASS.

- [x] **Step 7: Commit**

  Commit message: `feat(core): statedEmptyGroups reaches the session document, cleared on re-extraction`.

---

### Task 4: `review.ts` gains the fourth `ReviewGroupState`

**Files:**
- Modify: `packages/ribo-core/src/review.ts` (`ReviewGroupState` at line 186, `ReviewCollectionNode` at 219-226, `collectFields` at 453-546, `emptyCollectionPaths` at 585-593, `buildReviewRequest` at 564-575, `BuildReviewRequestOptions` at 603-618)
- Modify: `packages/ribo-ui-react/src/use-review.ts` (the `buildReviewRequest` call at lines 440-454)
- Test: `packages/ribo-core/src/review.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks directly (this task's tests construct `statedEmptyGroups` by hand; wiring the real session value through happens in this task's `use-review.ts` step).
- Produces: `ReviewCollectionNode.state` can be `"statedEmpty"`; `ReviewCollectionNode.emptyQuote: string | null`; `resolveReview` writes `fields[groupPath] = []` for a `"statedEmpty"` group exactly as it already does for `"empty"`.

- [x] **Step 1: Write the failing tests, including the `resolveReview`-level ones**

  In `review.test.ts`, in the `describe("buildReviewRequest — collections: data counts instances, schema counts leaves", ...)` block (or a new adjacent one), add tests using `collectionRequestFor`-style construction but passing a new `statedEmptyGroups` option:
  - A group with `hvac: []` and `options.statedEmptyGroups: { hvac: "there's no HVAC in this unit" }`: the tree's `hvac` collection node has `state: "statedEmpty"` and `emptyQuote: "there's no HVAC in this unit"`.
  - The same `hvac: []` with no `statedEmptyGroups` entry for `hvac`: `state: "empty"`, `emptyQuote: null` (today's behavior, now with the new field explicitly asserted as `null`).
  - A group absent from the extraction entirely (no key at all) with a `statedEmptyGroups` entry for that group anyway: `state` stays `"absent"`, `emptyQuote: null` — a stated-none signal is only meaningful for a group that was actually walked as an empty array; a group never emitted by extraction at all takes priority as `"absent"`, unaffected by `statedEmptyGroups`.
  - A group whose extracted value is present but malformed (not an array — e.g. `null` or an object) with a `statedEmptyGroups` entry for it anyway: `state` stays `"absent"`, exactly as today's malformed-data handling, unaffected by `statedEmptyGroups` — this is the regression case for accidentally narrowing today's `arrayNode === undefined || !Array.isArray(arrayNode)` condition down to only `=== undefined`.
  - A populated group is unaffected regardless of `statedEmptyGroups`.

  In the same file's `resolveReview` tests (near the existing "a present-but-empty collection resolves to an empty array" test, using `collectionRequestFor` with `{ requiredOnCreate: undefined /* or however statedEmptyGroups reaches collectionRequestFor's underlying buildReviewRequest call */, statedEmptyGroups: { hvac: "there's no HVAC" } }` and `hvac: []`): assert `resolveReview(...)`'s outcome has `outcome.fields.hvac` equal to `[]` — proving `emptyCollectionPaths` treats a `"statedEmpty"` group the same as an `"empty"` one for write purposes, not "absent from fields," which would silently mean "touch nothing" for the *strongest* form of "none" the auditor can assert.

- [x] **Step 2: Run the tests to verify they fail**

  Run: `pnpm vitest run packages/ribo-core/src/review.test.ts`
  Expected: FAIL — `buildReviewRequest` has no `statedEmptyGroups` option yet, `ReviewCollectionNode` has no `emptyQuote`, and `emptyCollectionPaths` doesn't know about `"statedEmpty"` yet.

- [x] **Step 3: Add the type members**

  In `review.ts`: change `ReviewGroupState` (line 186) to `"absent" | "empty" | "statedEmpty" | "populated"`, with an added doc-comment sentence distinguishing the new value from `"empty"` — "never mentioned," "present but empty, no reason given," and "present but empty, and the auditor said so" are three different claims. Add `readonly emptyQuote: string | null;` to `ReviewCollectionNode` (after `state`, before `instances`, line ~224).

- [x] **Step 4: Thread `statedEmptyGroups` through `collectFields` and `buildReviewRequest`, preserving the existing malformed-data guard**

  Add `statedEmptyGroups?: Readonly<Record<string, string>>` to `BuildReviewRequestOptions` (lines 603-618), with a doc comment matching `requiredOnCreate`'s style: per-group verbatim spans surfaced by the extractor's roster, keyed by the group's own top-level key.

  In `buildReviewRequest` (lines 564-575), extract `const statedEmptyGroups = options.statedEmptyGroups ?? {};` alongside the existing `requiredOnCreate` extraction, and pass it as a new parameter to `collectFields`.

  In `collectFields`'s signature (lines 453-461), add a `statedEmptyGroups: Readonly<Record<string, string>>` parameter (matching where `requiredOnCreate` already sits), and thread it through both recursive calls (the object branch, and the array branch's per-instance recursion) exactly as `requiredOnCreate` already is.

  In the array branch's state computation (lines 497-504): the `"absent"` condition **stays exactly as it is today** — `arrayNode === undefined || !Array.isArray(arrayNode)` — do not narrow it to `arrayNode === undefined` alone; a malformed present-but-non-array value must remain `"absent"`, unaffected by `statedEmptyGroups`. Only when the existing condition resolves to "not absent" and `elements.length === 0` does the new logic apply: look up `statedEmptyGroups[key]` (the CURRENT level's own key, e.g. `"hvac"` — not the full `path`, since roster groups are always top-level) — if present and non-empty, `state = "statedEmpty"` and `emptyQuote = statedEmptyGroups[key]`; otherwise `state = "empty"` and `emptyQuote = null`. When `state` is `"absent"` or `"populated"`, `emptyQuote` is always `null`. Add `emptyQuote` to the pushed `ReviewCollectionNode` object (alongside `state`).

- [x] **Step 5: Fix `emptyCollectionPaths` to treat `"statedEmpty"` as empty for write purposes**

  In `emptyCollectionPaths` (lines 585-593), change `node.state === "empty" ? [node.path] : []` to `node.state === "empty" || node.state === "statedEmpty" ? [node.path] : []`. This is the fix the failing `resolveReview` test from Step 1 exercises: without it, a `"statedEmpty"` group (which by definition has zero leaves, since `elements.length === 0` is required for that state) would never get `fields[groupPath] = []` written by `resolveReview`'s loop at lines 1029-1033, meaning the persisted outcome would omit the group entirely — "touch nothing" — which is the *weaker* write instruction, backwards from what an explicitly-stated absence should produce.

- [x] **Step 6: Run the tests to verify they pass**

  Run: `pnpm vitest run packages/ribo-core/src/review.test.ts`
  Expected: PASS.

- [x] **Step 7: Wire the real session value through `use-review.ts`**

  In `use-review.ts` (lines 440-454), add `statedEmptyGroups: session?.statedEmptyGroups` to the options object passed to `buildReviewRequest` (alongside `requiredOnCreate`, `existingRecords`), and add `session?.statedEmptyGroups` to the `useMemo`'s dependency array.

- [x] **Step 8: Run the full suites**

  Run: `pnpm --filter @azx/ribo-core typecheck && pnpm vitest run packages/ribo-core && pnpm --filter @azx/ribo-ui-react typecheck && pnpm vitest run packages/ribo-ui-react`
  Expected: PASS.

- [x] **Step 9: Commit**

  Commit message: `feat(core): buildReviewRequest surfaces a grounded "stated empty" group state, and resolveReview writes it as an empty array`.

---

### Task 5: The canvas renders the quote

**Files:**
- Modify: `playground/src/ReviewPanel.tsx` (`ResourceGroup` at lines 121-125, `groupFields` at 148-180, the render at 533-550)
- Test: `playground/src/ReviewPanel.browser.test.tsx` (or whatever this component's existing test file is named — locate via the tests referenced in earlier research, e.g. the ones exercising `collectionParkedItem`/`collectionProbe`)

**Interfaces:**
- Consumes: `ReviewCollectionNode.emptyQuote` from Task 4.

- [x] **Step 1: Write the failing test**

  In the `ReviewPanel` test file, add a test that parks a session whose extraction has an empty `hvac` array and a `statedEmptyGroups` (or equivalent seeded session field, matching however other tests in this file seed `session.extracted`/related fields) entry for `hvac` with a specific quote. Render the panel and assert the quote text appears in the group's section (via its `data-testid`, `review-group-hvac`), and that the "Add one" button is still present (an auditor can still add an instance if the stated-none turns out to be wrong) — matching the existing `isEmpty` branch's behavior, just with different copy.

- [x] **Step 2: Run the test to verify it fails**

  Run: `pnpm vitest run playground/src/ReviewPanel.browser.test.tsx`
  Expected: FAIL — nothing renders the quote yet.

- [x] **Step 3: Thread `emptyQuote` through `ResourceGroup`**

  In `ReviewPanel.tsx`, add `readonly emptyQuote: string | null;` to `ResourceGroup` (lines 121-125). In `groupFields` (line 176, the collection-node push), add `emptyQuote: node.emptyQuote,` alongside `isEmpty: node.state === "empty"`. Change `isEmpty`'s computation to `node.state === "empty" || node.state === "statedEmpty"` — a stated-empty group still renders as the "empty, with an add affordance" case, just with different copy inside it.

- [x] **Step 4: Render the quote**

  In the render function (lines 533-550), destructure `emptyQuote` alongside `name, instances, isEmpty`. Inside the `isEmpty` branch (lines 539-550), replace the hardcoded `<p style={muted}>none described</p>` with a conditional: when `emptyQuote` is non-null, render "None in this house" copy followed by the quote (e.g. a `<p>` for the label and a `<blockquote>` or styled `<p>` for the verbatim span — match this file's existing typographic conventions for quoted transcript text, if any exist elsewhere in the file; otherwise a simple styled paragraph is sufficient); when `emptyQuote` is `null`, keep today's `<p style={muted}>none described</p>` unchanged. The "Add one" button stays outside this conditional, present in both cases.

- [x] **Step 5: Run the test to verify it passes**

  Run: `pnpm vitest run playground/src/ReviewPanel.browser.test.tsx`
  Expected: PASS.

- [ ] **Step 6: Manually verify in the browser**

  Start the playground dev server (see this repo's `run` skill or its own README for the exact command) and drive a session through extraction with a transcript containing an explicit "there's no attic" style statement, confirming the review card renders the quote instead of "none described." Report this step's result honestly — if the playground cannot be exercised end-to-end (e.g. no live extractor configured), say so rather than claiming it was checked.

  > **Note:** Not performed — no display or browser interaction available in this environment. The automated browser test (Step 5) is the part that passes; this manual step is a bonus that could not be exercised.

- [x] **Step 7: Commit**

  Commit message: `feat(playground): review canvas renders the stated-empty quote`.

---

## Out of scope (confirmed against the design doc)

The roster's other internal fields (`discriminator`, `mentionSpan`, `distinguishedBy`) stay internal — nothing in this plan persists them or exposes them past `scopedInstanceExtractor`. No retroactive backfill is attempted for sessions already extracted before this ships — `buildReviewRequest` treats a missing `statedEmptyGroups` entry exactly like today's `"empty"` case, so there's nothing to migrate for correctness, only the additive schema field from Task 3.

## Reviewed

This plan was reviewed by OpenCode (`kimi-k3`, run 4926) before implementation. Findings applied: moved the `Roster` interface change and its typecheck dependency from Task 1 into Task 2 (Task 1 no longer breaks its own gate); corrected the union-value check's placement to inside the collection branch, after the singleton branch (Task 2 Step 4); preserved the existing `!Array.isArray(arrayNode)` disjunct in the absent-condition (Task 4 Step 4), with a regression test; changed `statedEmptyGroups` persistence from a conditional spread to an unconditional, clearing set so a re-extraction can't leave a stale quote (Task 3 Step 3); added the `emptyCollectionPaths` fix and its `resolveReview`-level test (Task 4 Step 5) — a real design-doc gap, not only a plan gap, corrected in `roster-absence-design.md` §2.3 as well; fixed every `pnpm --filter <pkg> test` command to the actual `pnpm vitest run <path>` form (no package here defines a `test` script); and made the migration-ordering dependency on the sibling plan's Task 3 unconditional (land it first) rather than offering two branches.
