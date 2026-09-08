# Roster Absence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A roster group can carry a verbatim-grounded "the transcript states there are none of these" signal, distinct from both "populated" and "never mentioned" — reaching all the way to the review canvas so it can render a quote instead of a hardcoded "none described."

**Architecture:** A new union value on the roster's per-group schema, threaded as one new field through the extractor's `ExtractionResult`, given its own session field (matching the codebase's existing `extractedBy`/`extractionUsage` pattern), consulted by `buildReviewRequest` to produce a fourth `ReviewGroupState`, and rendered by the one playground component that already switches on group state.

**Tech Stack:** TypeScript, zod, RxDB, React, Vitest.

**Spec:** `docs/roadmap/design/roster-absence-design.md`

## Global Constraints

- The roster stays internal-only in every other respect — `discriminator`, `mentionSpan`, `distinguishedBy` are not touched or persisted. Only the one new "stated none" signal crosses into `ExtractionResult`.
- `statedEmptyGroups` gets its **own** session field, matching `extractedBy`/`extractionUsage` (`session-schema.ts:136-158`) — never folded into the opaque `extracted` blob.
- **This plan's session-schema change (Task 3) rides the same sessions v1→v2 migration `docs/superpowers/plans/2026-09-08-instance-write-receipts.md`'s Task 3 introduces.** If that plan's Task 3 has already landed in this worktree, this plan adds `statedEmptyGroups` to the existing v2 schema and its (already-non-identity) migration function rather than bumping to v3. If it has not landed yet, implement that plan's Task 3 first, or bump `sessionRxSchema.version` to `2` here and let the sibling plan's Task 3 land second, whichever is actually true at implementation time — the two must not each independently claim v2.
- `"absent"`, `"empty"` and `"statedEmpty"` are three different claims (never mentioned / present-but-empty with no stated reason / present-but-empty with a stated reason) — no code path should collapse any two of them.

---

### Task 1: The roster's per-group schema gains a "stated none" value

**Files:**
- Modify: `packages/ribo-adapter-snuggpro/src/inventory.ts` (lines 61-78, and the instructions at 84-159)
- Modify: `packages/ribo-extractor-openai/src/instance-fill.ts` (lines 46-57)
- Test: `packages/ribo-adapter-snuggpro/src/inventory.test.ts` (create if it does not already exist, following whatever pattern this package's other `*.test.ts` files use for testing a bare zod schema — check `packages/ribo-adapter-snuggpro/src/adapter.test.ts` for the house style first)

**Interfaces:**
- Produces: `rosterGroupSchema` (zod) and `Roster`'s TS interface both accept, per group, either an array of candidates or `{ readonly stated: "none"; readonly span: string }`.

- [ ] **Step 1: Write the failing schema tests**

  In a new or existing `inventory.test.ts`, add assertions that `rosterGroupSchema.safeParse([])` still succeeds (an empty array stays a valid "no candidates recorded" value, unchanged), `rosterGroupSchema.safeParse({ stated: "none", span: "there's no attic" }).success` is `true`, `rosterGroupSchema.safeParse({ stated: "none" }).success` is `false` (missing `span`), and `rosterGroupSchema.safeParse({ stated: "none", span: "" }).success` is `false` (empty string is not a real quote — use `.min(1)` on the span, matching the house convention that a grounding span is never blank).

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `pnpm --filter @azx/ribo-adapter-snuggpro test inventory.test.ts`
  Expected: FAIL — `rosterGroupSchema` has no union branch for `{ stated: "none" }` yet.

- [ ] **Step 3: Change `rosterGroupSchema` to a union**

  In `inventory.ts`, change `rosterGroupSchema` (lines 61-69) from `z.array(rosterCandidateSchema).refine(...)` to `z.union([z.array(rosterCandidateSchema).refine(...) /* unchanged, the existing refine */, z.strictObject({ stated: z.literal("none"), span: z.string().min(1) })])`. Keep the existing `.refine` exactly as it is on the array branch.

  Update the roster schema's doc comment (lines 1-19) to mention the new "stated none" value as the fourth grounding mechanism (existence/separation/exclusion/absence), matching the design doc's own framing.

  Update `INVENTORY_PREAMBLE` (the instructions string, lines 84-159): add a new rule (after rule 4, "Exclusion needs a span") explaining that when the auditor explicitly states a component type does not exist in the property (e.g. "there's no attic," "no supplemental heating"), emit `{ "stated": "none", "span": "<verbatim quote>" }` for that group instead of an empty array — and that an empty array still means "the model found nothing to report," used when the transcript never brings the group up at all. Update the "Output" section (lines 151-159) to describe the three possible per-group shapes: a candidate array, an empty array, or the stated-none object.

- [ ] **Step 4: Update the generic `Roster` interface**

  In `instance-fill.ts`, change `Roster` (lines 54-57) from `{ readonly [groupKey: string]: readonly RosterCandidate[] }` to `{ readonly [groupKey: string]: readonly RosterCandidate[] | { readonly stated: "none"; readonly span: string } }`.

- [ ] **Step 5: Run the tests to verify they pass**

  Run: `pnpm --filter @azx/ribo-adapter-snuggpro test inventory.test.ts && pnpm --filter @azx/ribo-adapter-snuggpro typecheck && pnpm --filter @azx/ribo-extractor-openai typecheck`
  Expected: PASS.

- [ ] **Step 6: Commit**

  Commit message: `feat(adapter-snuggpro): roster groups can state there are none of a component`.

---

### Task 2: `scopedInstanceExtractor` surfaces `statedEmptyGroups`

**Files:**
- Modify: `packages/ribo-extractor-openai/src/instance-fill.ts` (lines 409, 428-433, 549-553)
- Modify: `packages/ribo-core/src/extractor.ts` (lines 61-84)
- Test: `packages/ribo-extractor-openai/src/instance-fill.test.ts` (locate the existing test(s) that construct a fake `inventory` callback and assert on `extract()`'s return value — follow that exact pattern)

**Interfaces:**
- Consumes: `Roster`'s union value from Task 1.
- Produces: `ExtractionResult<F>.statedEmptyGroups?: Readonly<Record<string, string>>`, consumed by Task 3's `toSessionExtractStep`.

- [ ] **Step 1: Write the failing test**

  In `instance-fill.test.ts`, find the existing test(s) exercising `scopedInstanceExtractor` with a multi-group roster (search for where the fake `inventory` callback is constructed). Add a new test where the fake `inventory` returns, for one collection group, `{ stated: "none", span: "there's no attic access" }` instead of an array, and for another group, a genuinely empty array `[]`. Assert the resolved `ExtractionResult.statedEmptyGroups` equals `{ [thatGroupKey]: "there's no attic access" }` — and that the genuinely-empty group's key is **absent** from `statedEmptyGroups` (not present with an empty string or `null`). Also assert the stated-none group makes zero fill calls (no `ChatClient` request for it) and that its `groupResult`/final `fields[groupKey]` is still `[]`, same as today's empty-array case — a stated-none group is not filled, same as an empty one.

- [ ] **Step 2: Run the test to verify it fails**

  Run: `pnpm --filter @azx/ribo-extractor-openai test instance-fill.test.ts`
  Expected: FAIL — `roster[group.key]` is currently assumed to always be an array (`.filter(...)` at line 428 throws or misbehaves on a plain object), and `statedEmptyGroups` does not exist on the result.

- [ ] **Step 3: Handle the union value in `extract()`**

  In `instance-fill.ts`'s `extract()` (inside the `for (const group of prepared)` loop, replacing lines 409-433): after `const rosterGroup = roster[group.key] ?? [];`, add a check: if `rosterGroup` is not an array (i.e., it's the `{ stated: "none", span }` shape), record `statedEmptyGroups[group.key] = rosterGroup.span` (declare `const statedEmptyGroups: Record<string, string> = {};` before the loop, alongside `collectionArrays`/`groupResult`), set `groupResult[group.key] = []`, and `continue` to the next group — skipping the `current.length === 0` / fill-scheduling logic entirely for that group, since there's nothing to fill. Only reach the existing `const current = rosterGroup.filter(...)` line when `rosterGroup` is confirmed to be an array.

- [ ] **Step 4: Surface it on the returned `ExtractionResult`**

  At the function's final return (lines 549-553), add `...(Object.keys(statedEmptyGroups).length > 0 ? { statedEmptyGroups } : {})` alongside `fields`/`raw`/`usage`.

  In `ribo-core/src/extractor.ts`, add `readonly statedEmptyGroups?: Readonly<Record<string, string>>;` to `ExtractionResult<F>` (after `usage`, line 83), with a doc comment: per-group verbatim spans where the roster recorded an explicit "none of these," surfaced from `scopedInstanceExtractor` — absent for any extractor that does not use a roster.

- [ ] **Step 5: Run the test to verify it passes**

  Run: `pnpm --filter @azx/ribo-extractor-openai test instance-fill.test.ts`
  Expected: PASS.

- [ ] **Step 6: Run the full suites**

  Run: `pnpm --filter @azx/ribo-extractor-openai typecheck && pnpm --filter @azx/ribo-extractor-openai test && pnpm --filter @azx/ribo-core typecheck`
  Expected: PASS.

- [ ] **Step 7: Commit**

  Commit message: `feat(extractor-openai): scopedInstanceExtractor surfaces stated-empty groups`.

---

### Task 3: A dedicated session field carries `statedEmptyGroups`

**Files:**
- Modify: `packages/ribo-core/src/queue/relay.ts` (`ExtractStepResult` at lines 37-50, `#sessionExtract` at 391-411)
- Modify: `packages/ribo-core/src/extractor.ts` (`toSessionExtractStep` at lines 132-140)
- Modify: `packages/ribo-core/src/queue/session-schema.ts` (as an addition to the v2 schema/migration — see Global Constraints)
- Test: `packages/ribo-core/src/queue/session-schema.test.ts`, `packages/ribo-core/src/extractor.test.ts` (or wherever `toSessionExtractStep` is currently tested — locate via the existing `engine`/`usage` forwarding test)

**Interfaces:**
- Consumes: `ExtractionResult.statedEmptyGroups` from Task 2.
- Produces: `SessionDocument.statedEmptyGroups?: Readonly<Record<string, string>>`, consumed by Task 4.

- [ ] **Step 1: Write the failing tests**

  Wherever `toSessionExtractStep` is tested today (find the test asserting `result.engine`/`result.usage` forwarding), add a case where the fake `Extractor`'s `extract()` resolves with a `statedEmptyGroups` value, and assert the produced `ExtractStepResult` carries it through unchanged.

  In `session-schema.test.ts`, add to the same v1→v2 migration test(s) from the sibling plan's Task 3 (or, if that task has not landed yet in this worktree, add a new v1→v2 identity test for this field alone): a v1 document has no `statedEmptyGroups`; after migration, it's still absent (pure addition, no backfill). Also extend the schema field-parity pin (the same one the sibling plan's Task 3 touches) to include `statedEmptyGroups`.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `pnpm --filter @azx/ribo-core test`
  Expected: FAIL on the new assertions.

- [ ] **Step 3: Update `ExtractStepResult` and `#sessionExtract`**

  In `relay.ts`, add `readonly statedEmptyGroups?: Readonly<Record<string, string>>;` to `ExtractStepResult` (lines 37-50), beside `usage`.

  In `#sessionExtract` (lines 391-411), add `...(result.statedEmptyGroups !== undefined ? { statedEmptyGroups: result.statedEmptyGroups } : {})` to the session patch, alongside the existing conditional spreads for `extractedBy`/`extractionUsage`.

- [ ] **Step 4: Update `toSessionExtractStep`**

  In `extractor.ts` (lines 132-140), add `statedEmptyGroups: result.statedEmptyGroups` to the returned object, alongside `fields`/`engine`/`usage`.

- [ ] **Step 5: Add `statedEmptyGroups` to the session schema**

  In `session-schema.ts`: add `statedEmptyGroups: z.record(z.string(), z.string()).optional()` to `sessionDocumentSchema` (after `writeResult`, or after `receipts` if the sibling plan's Task 3 has already added it), and `statedEmptyGroups: { type: "object" }` to `sessionRxSchema.properties`. If the sibling plan's v1→v2 migration function already exists, this field needs no change to it — a purely additive optional field needs no per-document transformation. If it does not exist yet, add the minimal `SESSION_MIGRATION_STRATEGIES[2] = (doc) => doc` entry and bump `sessionRxSchema.version` to `2` (coordinate with the sibling plan so only one of the two plans actually performs the version bump).

- [ ] **Step 6: Run the tests to verify they pass**

  Run: `pnpm --filter @azx/ribo-core test`
  Expected: PASS.

- [ ] **Step 7: Commit**

  Commit message: `feat(core): statedEmptyGroups reaches the session document`.

---

### Task 4: `review.ts` gains the fourth `ReviewGroupState`

**Files:**
- Modify: `packages/ribo-core/src/review.ts` (`ReviewGroupState` at line 186, `ReviewCollectionNode` at 219-226, `collectFields` at 453-546, `buildReviewRequest` at 564-575, `BuildReviewRequestOptions` at 603-618)
- Modify: `packages/ribo-ui-react/src/use-review.ts` (the `buildReviewRequest` call at lines 440-454)
- Test: `packages/ribo-core/src/review.test.ts`

**Interfaces:**
- Consumes: nothing new from earlier tasks directly (this task's tests construct `statedEmptyGroups` by hand; wiring the real session value through happens in this task's `use-review.ts` step).
- Produces: `ReviewCollectionNode.state` can be `"statedEmpty"`; `ReviewCollectionNode.emptyQuote: string | null`.

- [ ] **Step 1: Write the failing tests**

  In `review.test.ts`, in the `describe("buildReviewRequest — collections: data counts instances, schema counts leaves", ...)` block (or a new adjacent one), add tests using `collectionRequestFor`-style construction but passing a new `statedEmptyGroups` option:
  - A group with `hvac: []` and `options.statedEmptyGroups: { hvac: "there's no HVAC in this unit" }`: the tree's `hvac` collection node has `state: "statedEmpty"` and `emptyQuote: "there's no HVAC in this unit"`.
  - The same `hvac: []` with no `statedEmptyGroups` entry for `hvac`: `state: "empty"`, `emptyQuote: null` (today's behavior, now with the new field explicitly asserted as `null`).
  - A group absent from the extraction entirely (no key at all) with a `statedEmptyGroups` entry for that group anyway: `state` stays `"absent"`, `emptyQuote: null` — a stated-none signal is only meaningful for a group that was actually walked as an empty array; a group never emitted by extraction at all takes priority as `"absent"`, unaffected by `statedEmptyGroups`.
  - A populated group is unaffected regardless of `statedEmptyGroups`.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `pnpm --filter @azx/ribo-core test review.test.ts`
  Expected: FAIL — `buildReviewRequest` has no `statedEmptyGroups` option yet, and `ReviewCollectionNode` has no `emptyQuote`.

- [ ] **Step 3: Add the type members**

  In `review.ts`: change `ReviewGroupState` (line 186) to `"absent" | "empty" | "statedEmpty" | "populated"`, with an added doc-comment sentence distinguishing the new value from `"empty"` — "never mentioned," "present but empty, no reason given," and "present but empty, and the auditor said so" are three different claims. Add `readonly emptyQuote: string | null;` to `ReviewCollectionNode` (after `state`, before `instances`, line ~224).

- [ ] **Step 4: Thread `statedEmptyGroups` through `collectFields` and `buildReviewRequest`**

  Add `statedEmptyGroups?: Readonly<Record<string, string>>` to `BuildReviewRequestOptions` (lines 603-618), with a doc comment matching `requiredOnCreate`'s style: per-group verbatim spans surfaced by the extractor's roster, keyed by the group's own top-level key.

  In `buildReviewRequest` (lines 564-575), extract `const statedEmptyGroups = options.statedEmptyGroups ?? {};` alongside the existing `requiredOnCreate` extraction, and pass it as a new parameter to `collectFields`.

  In `collectFields`'s signature (lines 453-461), add a `statedEmptyGroups: Readonly<Record<string, string>>` parameter (matching where `requiredOnCreate` already sits), and thread it through both recursive calls (the object branch, and the array branch's per-instance recursion) exactly as `requiredOnCreate` already is.

  In the array branch's state computation (lines 497-504): change to compute `state` as today when `arrayNode === undefined` (`"absent"`) or `elements.length > 0` (`"populated"`); when `elements.length === 0`, look up `statedEmptyGroups[key]` (the CURRENT level's own key, e.g. `"hvac"` — not the full `path`, since roster groups are always top-level) — if present and non-empty, `state = "statedEmpty"` and `emptyQuote = statedEmptyGroups[key]`; otherwise `state = "empty"` and `emptyQuote = null`. When `state` is `"absent"` or `"populated"`, `emptyQuote` is always `null`. Add `emptyQuote` to the pushed `ReviewCollectionNode` object (alongside `state`).

- [ ] **Step 5: Run the tests to verify they pass**

  Run: `pnpm --filter @azx/ribo-core test review.test.ts`
  Expected: PASS.

- [ ] **Step 6: Wire the real session value through `use-review.ts`**

  In `use-review.ts` (lines 440-454), add `statedEmptyGroups: session?.statedEmptyGroups` to the options object passed to `buildReviewRequest` (alongside `requiredOnCreate`, `existingRecords`), and add `session?.statedEmptyGroups` to the `useMemo`'s dependency array.

- [ ] **Step 7: Run the full suites**

  Run: `pnpm --filter @azx/ribo-core typecheck && pnpm --filter @azx/ribo-core test && pnpm --filter @azx/ribo-ui-react typecheck && pnpm --filter @azx/ribo-ui-react test`
  Expected: PASS.

- [ ] **Step 8: Commit**

  Commit message: `feat(core): buildReviewRequest surfaces a grounded "stated empty" group state`.

---

### Task 5: The canvas renders the quote

**Files:**
- Modify: `playground/src/ReviewPanel.tsx` (`ResourceGroup` at lines 121-125, `groupFields` at 148-180, the render at 533-550)
- Test: `playground/src/ReviewPanel.browser.test.tsx` (or whatever this component's existing test file is named — locate via the tests referenced in earlier research, e.g. the ones exercising `collectionParkedItem`/`collectionProbe`)

**Interfaces:**
- Consumes: `ReviewCollectionNode.emptyQuote` from Task 4.

- [ ] **Step 1: Write the failing test**

  In the `ReviewPanel` test file, add a test that parks a session whose extraction has an empty `hvac` array and a `statedEmptyGroups` (or equivalent seeded session field, matching however other tests in this file seed `session.extracted`/related fields) entry for `hvac` with a specific quote. Render the panel and assert the quote text appears in the group's section (via its `data-testid`, `review-group-hvac`), and that the "Add one" button is still present (an auditor can still add an instance if the stated-none turns out to be wrong) — matching the existing `isEmpty` branch's behavior, just with different copy.

- [ ] **Step 2: Run the test to verify it fails**

  Run: `pnpm --filter playground test ReviewPanel`
  Expected: FAIL — nothing renders the quote yet.

- [ ] **Step 3: Thread `emptyQuote` through `ResourceGroup`**

  In `ReviewPanel.tsx`, add `readonly emptyQuote: string | null;` to `ResourceGroup` (lines 121-125). In `groupFields` (line 176, the collection-node push), add `emptyQuote: node.emptyQuote,` alongside `isEmpty: node.state === "empty"`. Change `isEmpty`'s computation to `node.state === "empty" || node.state === "statedEmpty"` — a stated-empty group still renders as the "empty, with an add affordance" case, just with different copy inside it.

- [ ] **Step 4: Render the quote**

  In the render function (lines 533-550), destructure `emptyQuote` alongside `name, instances, isEmpty`. Inside the `isEmpty` branch (lines 539-550), replace the hardcoded `<p style={muted}>none described</p>` with a conditional: when `emptyQuote` is non-null, render "None in this house" copy followed by the quote (e.g. a `<p>` for the label and a `<blockquote>` or styled `<p>` for the verbatim span — match this file's existing typographic conventions for quoted transcript text, if any exist elsewhere in the file; otherwise a simple styled paragraph is sufficient); when `emptyQuote` is `null`, keep today's `<p style={muted}>none described</p>` unchanged. The "Add one" button stays outside this conditional, present in both cases.

- [ ] **Step 5: Run the test to verify it passes**

  Run: `pnpm --filter playground test ReviewPanel`
  Expected: PASS.

- [ ] **Step 6: Manually verify in the browser**

  Start the playground dev server (see this repo's `run` skill or its own README for the exact command) and drive a session through extraction with a transcript containing an explicit "there's no attic" style statement, confirming the review card renders the quote instead of "none described." Report this step's result honestly — if the playground cannot be exercised end-to-end (e.g. no live extractor configured), say so rather than claiming it was checked.

- [ ] **Step 7: Commit**

  Commit message: `feat(playground): review canvas renders the stated-empty quote`.

---

## Out of scope (confirmed against the design doc)

The roster's other internal fields (`discriminator`, `mentionSpan`, `distinguishedBy`) stay internal — nothing in this plan persists them or exposes them past `scopedInstanceExtractor`. No retroactive backfill is attempted for sessions already extracted before this ships — `buildReviewRequest` treats a missing `statedEmptyGroups` entry exactly like today's `"empty"` case, so there's nothing to migrate for correctness, only the additive schema field from Task 3.
