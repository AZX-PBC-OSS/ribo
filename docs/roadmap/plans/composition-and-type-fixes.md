# Per-group composition and type-story fixes — Implementation Plan

> **For anyone implementing this, human or agent:** work task-by-task. Tasks in Phase A are
> independent and may land in any order. Phase B must precede Phase C. Phase D is sequential
> within itself and depends on Phases C. Phase E is independent of everything else. If a task's
> premise turns out to be wrong against the actual code, stop and say so rather than improvising
> around it.

**Goal:** Make each top-level schema group its own composable `Extractor`, and fix the type-story
defects the review found — threading `P` through two wrappers that lost it, constraining a
contract that accepted anything, deleting casts the type system already proves redundant, exporting
symbols the designs tell consumers to use, and making the method-to-property convention mechanical.

**Architecture:** A `groupedExtractor` combinator in `ribo-core` runs a per-key map of `Extractor`s
and owns the cross-group work (pool, retry budget, merge, second trust-boundary parse, usage). A
pure `projectTarget` in `ribo-extractor-openai` narrows an `ExtractionTarget` to one group.
`perGroupExtractor` becomes a preset over the two. Per-group heterogeneity — a different model,
strategy, wrapper or transport per group — falls out of composition instead of options. One contract
change rides along: `Extractor.extract` gains an optional `options` bag carrying `signal`, declared
as a function-typed property.

**Tech Stack:** TypeScript 6.0.3, zod 4.4.3, Vitest 4 (node `unit` + real-Chromium `browser`), tsdown,
pnpm 10.34.5 catalog.

**Design:** [`../design/per-group-composition-design.md`](../design/per-group-composition-design.md)
— read §1–§4 before Task 9. [`../design/type-story-findings.md`](../design/type-story-findings.md)
— read B1–B6 and P1–P8 before Task 1.

## Global Constraints

- **Node >= 24, pnpm 10.34.5.** Every command from the repo root. `./check.sh` is the definition
  of done (AGENTS.md §7): typecheck then lint then format:check then build:packages then resolve then
  build:app then pkg:gates then snugg:drift then skips:tracked then score:mutations then test. Paste
  its summary line; never assert success without it.
- **CI additionally runs** `pnpm docs:build`, `pnpm changeset status --since=origin/main`, and
  `pnpm test:pack-and-consume`. A task that adds or renames a publishable package must account for
  all four. No task in this plan adds or renames a package.
- **Nothing is published.** Breaking changes are acceptable; `@azx/ribo-core`,
  `@azx/ribo-extractor-openai`, `@azx/ribo-extractor-ondevice` and `@azx/ribo-ui-react` are all set
  to bump major on the current branch.
- **ESM-only.** `import type` for type-only imports (`verbatimModuleSyntax` + an ESLint rule enforce
  it). zod at trust boundaries, plain types inside.
- **Public entry points only across packages** — import `@azx/ribo-core`, never
  `@azx/ribo-core/src/...`. `ribo-core` and `ribo-adapter-snuggpro` are headless: no `react`, no
  `document`, no `window` — enforced by `eslint.config.mjs`.
- **Small, focused files.** One responsibility per file; prefer adding a file over growing one.
- **Every guard you add must be proven to discriminate.** Break the thing it guards, observe the
  failure, restore, and report the observed output. A test that passes either way advertises coverage
  that does not exist.
- **`@ts-expect-error` + Prettier + added parameters is a live hazard.** `pnpm format` can wrap a
  multi-argument call and detach the directive onto a line where nothing is wrong. Hoist arguments so
  the directive stays attached, and make each pin fail for the reason it names.
- **A green Vitest run is not evidence a type-level change is complete.** esbuild strips types without
  checking them, so a red `tsc` does not turn Vitest red. Run typecheck before believing the failure
  list is complete.
- **Catalog versions are exact, no carets.** Do not invent version numbers. Do not bump `typescript`
  (held at 6.0.3) or `@types/node` (held at 24.13.3).

## P2 (plugin storage) sequencing decision

The design's §4.4 proposes widening `Extractor.extract` with an `options` bag carrying `signal`, and
notes that `post-docs-findings.md` P2 (plugin-scoped storage delivery) wants the same slot. **These
do NOT land together.** The signal has a known shape (`AbortSignal`) and an immediate consumer (the
`groupedExtractor` combinator's sibling-abort). The storage handle does not have a known shape — no
`PluginStorage` type exists — and its delivery also needs to widen `Transcriber.transcribe`, not just
`Extractor.extract`. Defining `ExtractOptions` with `signal?` now and extending it with `storage?`
later is non-breaking for the options type, while adding the options parameter itself is the one
breaking change. The parameter is added once; the type grows as needed. Task 9 adds `signal?` only.

---

# Phase A — Independent type fixes

> These seven tasks have no dependencies on each other or on any later phase. They may land in any
> order. Each is a separate changeset.

## Task 1: Thread `P` through `GapFillOptions` (type-story B1)

**Files:** `packages/ribo-extractor-openai/src/gap-fill.ts`

**Problem:** `GapFillOptions<V>` has no `P` parameter. `base` is typed `Extractor<Enveloped<V>>` and
`target` is `ExtractionTarget<V>`, so `gapFillExtractor` cannot accept an extractor whose target
declares a `"row"` group — a compile error on any target using the granularity option. Every other
strategy in the package (`SingleShotOptions`, `PerGroupOptions`, `ScopedFillOptions`,
`SchemaRetryOptions`) carries `P`. This one was written before the option existed and never widened.

**What to do:** Add `P = NoProvenance` as a second type parameter on `GapFillOptions`, thread it
through `base` (now `Extractor<Enveloped<V, P>>`), `target` (now `ExtractionTarget<V, P>`), the
return type of `gapFillExtractor` (now `Extractor<Enveloped<V, P>>`), and the `normalize` option
(now `(fields: Enveloped<V, P>) => Enveloped<V, P>`). The `findAbstainedLeaves` and
`findUngroundedLeaves` helpers are already generic over `V` only; their `Enveloped<V>` parameter
type widens to `Enveloped<V, P>` at the call site without touching their signatures. The
`mergeGapFilledLeaves` return type widens the same way. No runtime change — the leaf walker
`isExtractedLeaf` already requires a numeric `confidence`, so a row group's plain leaves are already
"no candidates" at runtime.

**Test that must fail first:** A `@ts-expect-error` probe: `gapFillExtractor` called with
`base: Extractor<Enveloped<V, { rooms: "row" }>>` and `target: ExtractionTarget<V, { rooms: "row" }>`
is a type error today. After the fix, that call compiles and the `@ts-expect-error` directive becomes
"unused" — which is itself the confirmation. Add a type-level test (in the style of the existing
`@ts-expect-error` probes in `chat-client.test.ts`) that pins the fix: the call compiles without a
directive, and a wrong-key probe (`gapFillExtractor` with `base: Extractor<Enveloped<WrongV>>`)
still fails.

## Task 2: Thread `P` through `InstanceLadderOptions` (type-story B2)

**Files:** `packages/ribo-extractor-openai/src/instance-ladder.ts`

**Problem:** `InstanceLadderOptions<V>` types the arbiter as `ExtractionArbiter<Enveloped<V>>` and
each tier's options without `P`, although all three tier option types (`ScopedFillOptions`,
`PerGroupOptions`) accept one. Passing an `ExtractionTarget<V, P>` to any tier fails.

**What to do:** Add `P = NoProvenance` as a second type parameter on `InstanceLadderOptions`. Thread
it through `arbiter` (now `ExtractionArbiter<Enveloped<V, P>>`), `tier1` (now
`ScopedFillOptions<V, P>`), `tier2` and `tier3` (now `PerGroupOptions<V, P>`), and the return type of
`instanceLadder` (now `Extractor<Enveloped<V, P>>`). No runtime change — the tiers already pass the
target through to their respective extractors.

**Test that must fail first:** Same probe shape as Task 1: `instanceLadder` called with tier options
carrying `P = { rooms: "row" }` is a type error today. After the fix, it compiles.

## Task 3: Constrain `toSessionExtractStep<F>` (type-story B3)

**Files:** `packages/ribo-core/src/extractor.ts`

**Problem:** `toSessionExtractStep<F>` has an unconstrained `F`, and line 152 casts
`result.fields as ExtractedFieldMap` (which is `Record<string, unknown>`). So
`toSessionExtractStep(new FakeExtractor(42))` compiles, and the relay would persist `42` as
`session.extracted`.

**What to do:** Change the signature to `toSessionExtractStep<F extends Record<string, unknown>>`
and delete the `as ExtractedFieldMap` cast on line 152. `Enveloped<V, P>` is a mapped type over
`keyof V`, so it satisfies `Record<string, unknown>` and no real caller changes. Check
`FakeExtractor` test usages: any test that seeds a primitive (like `new FakeExtractor(42)`) will
become a compile error — fix those by seeding an object.

**Test that must fail first:** A `@ts-expect-error` probe: `toSessionExtractStep(new
FakeExtractor(42))` compiles today (the `@ts-expect-error` directive is unused, which tsc reports as
an error). After the fix, the directive is consumed by a real type error. Then remove the directive
and replace with a positive test that `toSessionExtractStep(new FakeExtractor({ key: "val" }))`
compiles.

## Task 4: Delete three redundant casts (type-story B6)

**Files:** `packages/ribo-core/src/instance-write-step.ts` (lines 122 and 144),
`packages/ribo-extractor-ondevice/src/three-phase-extractor.ts` (line 253)

**Problem:** Three `as` casts are redundant — the type system already proves the target type. In
`instance-write-step.ts`, `adapter.schema.parse(...)` already returns `V` because `ValuesSchema<V>`
binds `parse` to `V` through its `_zod.output` member (`adapter.ts:98–101`). In
`three-phase-extractor.ts`, `target.extractionSchema.parse(result)` already returns
`Enveloped<V, P>` because `extractionSchema` is typed `ZodType<Enveloped<V, P>>` (`adapter.ts:199`).

**What to do:** Delete the `as V` from lines 122 and 144 of `instance-write-step.ts` and the `as
Enveloped<V, P>` from line 253 of `three-phase-extractor.ts`. Run `pnpm typecheck` on both packages
to confirm the casts were redundant.

**Test that must fail first:** None — the typecheck is the test. If `pnpm --filter @azx/ribo-core
typecheck` or `pnpm --filter @azx/ribo-extractor-ondevice typecheck` fails after the deletion, the
cast was not redundant and the finding was wrong; report it. A redundant assertion is not harmless —
it is the one that keeps compiling after the type it asserts has drifted.

## Task 5: Export missing symbols from barrels (type-story B5)

**Files:** `packages/ribo-extractor-ondevice/src/index.ts`,
`packages/ribo-extractor-openai/src/index.ts`

**Problem:** Two barrels omit symbols the designs tell a consumer to use.
`ribo-extractor-ondevice/src/index.ts` does not export `SessionCapabilityError` (defined in
`session.ts:37`, thrown at `:111`). A host arbiter cannot `instanceof` a class it cannot import.
`ribo-extractor-openai/src/index.ts` does not export `assertStopFinishReason`, `completeOrClassify`,
`parseWithSchema`, `parseJsonContent` or `buildMessages` (all in `extraction-common.ts`). R3's plan
names `assertStopFinishReason` and `completeOrClassify` as "hard-won and must not be reimplemented",
and the arbitration design exports the engine so a consumer can write a combinator — but a consumer
writing a strategy cannot reach the trust-boundary gates that make one correct.

**What to do:** Add `export { SessionCapabilityError } from "./session.js"` to
`ribo-extractor-ondevice/src/index.ts`. Add `export { assertStopFinishReason, completeOrClassify,
parseWithSchema, parseJsonContent, buildMessages } from "./extraction-common.js"` to
`ribo-extractor-openai/src/index.ts`. These are value exports (functions and a class), not type
exports. No runtime change.

**Test that must fail first:** A test in each package that imports the newly exported symbol by name
from the barrel and uses it — `instanceof SessionCapabilityError` in ondevice, a call to
`assertStopFinishReason` in extractor-openai. The import fails today (not exported); after the fix it
resolves. Add these to the existing colocated test files.

## Task 6: Move `Roster`, `RosterCandidate`, `FillScope` to `ribo-core` (type-story P7)

**Files:** `packages/ribo-core/src/index.ts` (add exports), new file
`packages/ribo-core/src/inventory-types.ts`, `packages/ribo-extractor-openai/src/instance-fill.ts`
(re-export from core), `packages/ribo-extractor-openai/src/index.ts` (re-export unchanged),
`packages/ribo-adapter-snuggpro/src/instructions.ts` (delete duplicate `FillScope`, import from
core via extractor-openai)

**Problem:** `Roster`, `RosterCandidate` and `FillScope` are declared three times: as generic
hand-written interfaces in `ribo-extractor-openai/src/instance-fill.ts:57–86`, as zod-inferred types
in `ribo-adapter-snuggpro/src/inventory.ts:54,98`, and as a second hand-written `FillScope` in
`ribo-adapter-snuggpro/src/instructions.ts:639` with the comment "duplicated here so the adapter
does not depend on the extractor package". The adapter cannot import the extractor package, but both
can depend on `ribo-core`.

**What to do:** Create `packages/ribo-core/src/inventory-types.ts` with the three generic interfaces
(`RosterCandidate`, `Roster`, `FillScope`) exactly as they appear in `instance-fill.ts:57–86`. Export
them from `packages/ribo-core/src/index.ts`. In `instance-fill.ts`, replace the local declarations
with imports from `@azx/ribo-core` and re-export them (the barrel `index.ts` already re-exports from
`instance-fill.ts`, so the public surface of `ribo-extractor-openai` does not change). In
`instructions.ts:639`, delete the duplicate `FillScope` interface and import it from
`@azx/ribo-extractor-openai` instead (the adapter already depends on that package for
`buildFillMessages`). The adapter's zod-inferred `RosterCandidate`/`Roster` in `inventory.ts` are
correctly narrower (an enum eligibility, the two-branch candidate) and stay as they are — they
satisfy the generic interfaces structurally.

**Test that must fail first:** `pnpm typecheck` must pass on all three packages after the move. The
adapter's `Roster` type must still be assignable to the core `Roster` interface — verify with a
type-level assertion in `adapter.test.ts` or `instance-fill.test.ts` that
`satisfies Roster` compiles for the adapter's inferred type. If it does not, the generic interface
and the inferred type have diverged; report it.

## Task 7: Type review's `provenance` against the values schema (type-story P4)

**Files:** `packages/ribo-core/src/review.ts` (line 760, the `BuildReviewRequestOptions.provenance`
field; line 545, the `provenance[key] ?? "leaf"` read), `packages/ribo-ui-react/src/use-review.ts`
(line 88, the same field)

**Problem:** `BuildReviewRequestOptions.provenance` is `Readonly<Record<string,
ProvenanceGranularity>>` — keyed by `string`, so a typo is silent. `enveloped()` validates the same
map and throws on an unknown group; `buildReviewRequest` does not. An unknown key is ignored and the
group renders as a table of blanks.

**What to do:** Make `buildReviewRequest` generic over the values schema it already takes. The
`provenance` field becomes `ProvenanceMap<T>` where `T extends z.ZodObject` — a mapped type over
`keyof z.infer<T> & string` that requires every group key to be a real key of the values schema. For
a JS caller who has no schema, add a runtime validation using the same `validateProvenance` function
`enveloped()` uses (export it from `enveloped.ts` if it is not already exported). `useReview` follows
by passing the schema through. The runtime read at line 545 (`provenance[key] ?? "leaf"`) is
unchanged — the type change makes the wrong key a compile error, and the runtime validation makes it
a throw for a JS caller.

**Test that must fail first:** A type-level test: `buildReviewRequest` called with a `provenance`
keying a group that does not exist in `valuesSchema` is a type error after the fix. A runtime test:
`buildReviewRequest` called (from JS, or via `as any`) with an unknown group key throws with the key
named, matching `enveloped()`'s behaviour. No test covers this case today (grep of `review.test.ts`
for unknown-key cases returns nothing).

---

# Phase B — Method-to-property lint rule (type-story P1)

> Depends on: nothing. Should land before Phase C because Phase C changes `Extractor.extract` to
> property syntax, and this rule makes that the default rather than a one-off.

## Task 8: Enable `@typescript-eslint/method-signature-style` (type-story P1)

**Files:** `eslint.config.mjs`, all interface files with method signatures (51 members across 15
files)

**Problem:** The repo chose property syntax twice for a stated reason (`Transcriber.transcribe`,
`ToolAdapter.write`), and the next contract with a generic parameter will be written by someone who
does not remember why. None of the 51 current method signatures is a bug today — every one has
either no parameters or parameters that do not vary with a type parameter, so bivariance has nothing
to widen (type-story D1 is the demonstration). But the convention is prose, not mechanical.

**What to do:** Add `"@typescript-eslint/method-signature-style": ["error", "property"]` to
`eslint.config.mjs` in the rules block. Run `pnpm lint:fix` to autofix the 51 sites. The
`LanguageModel` and `LanguageModelSession` interfaces in
`packages/ribo-extractor-ondevice/src/capability.ts` mirror a browser API and are never implemented
by this repo — add a file-level `/* eslint-disable @typescript-eslint/method-signature-style */`
comment to that file (or to the specific interfaces) so they keep method syntax. Verify the autofix
does not change any runtime behaviour: method-to-property is a type-level rewrite, and the
implementations are objects with function properties already.

**Test that must fail first:** `pnpm lint` reports 51 errors before the autofix. After the autofix,
`pnpm lint` is clean and `pnpm typecheck` is green. Run `./check.sh` — the format:check stage may
flag formatting changes from the autofix; run `pnpm format` if so.

---

# Phase C — Extractor contract widening (design §4.4)

> Depends on: Task 8 (property syntax is now the default, so `extract` is already property syntax;
> this task only adds the options parameter).

## Task 9: Add `ExtractOptions` with `signal` to the `Extractor` contract

**Files:** `packages/ribo-core/src/extractor.ts` (the `Extractor` interface, `FakeExtractor`,
`toSessionExtractStep`), `packages/ribo-core/src/arbitration.ts` (two call sites:
`candidate.extractor.extract(transcript)` at lines 368 and 434),
`packages/ribo-extractor-openai/src/single-shot.ts`,
`packages/ribo-extractor-openai/src/per-group.ts`,
`packages/ribo-extractor-openai/src/gap-fill.ts`,
`packages/ribo-extractor-openai/src/schema-retry.ts`,
`packages/ribo-extractor-openai/src/instance-fill.ts`,
`packages/ribo-extractor-ondevice/src/three-phase-extractor.ts`

**Problem:** Once a group is an opaque `Extractor`, the shared `AbortController` in
`per-group.ts`'s closure has no way to reach the group's chat call. The signal must cross the
contract. `raceExtractor` and the relay's `withTimeout` have the same gap — losers and timed-out
calls keep running.

**What to do:** Define `ExtractOptions` in `extractor.ts` as an interface with one optional member:
`signal?: AbortSignal`. Change `Extractor<F>.extract` from a method to a function-typed property
(Task 8 already did this via lint autofix) and add the second parameter: `extract: (transcript:
AnnotatedTranscript, options?: ExtractOptions) => Promise<ExtractionResult<F>>`. Thread `options`
through every implementation:

- `FakeExtractor.extract`: accept `options?`, ignore it (a fake makes no calls).
- `toSessionExtractStep`: pass `options` through to `extractor.extract(transcript, options)`. The
  relay's `SessionExtractStep` does not currently carry options; leave that wiring for when the relay
  threads a signal — this task widens the contract, not the relay.
- `singleShotExtractor`: pass `options?.signal` to `chat.complete` via `ChatCallOptions`.
- `perGroupExtractor`: replace the closure-captured `abort.signal` with `options?.signal ??`
  a new `AbortController` (when no signal is passed, create one as today). Pass the signal to
  `completeOrClassify` via `ChatCallOptions`.
- `gapFillExtractor`: pass `options?.signal` to the follow-up `chat.complete`.
- `schemaRetryExtractor`: pass `options?.signal` to each retry's `chat.complete`.
- `scopedInstanceExtractor`: pass `options?.signal` to each call.
- `threePhaseExtractor`: pass `options?.signal` to each `chat.complete`.
- `arbitration.ts` lines 368 and 434: pass `options` through to `candidate.extractor.extract`.

Do NOT add a `storage` field to `ExtractOptions` — see the P2 sequencing decision above.

**Test that must fail first:** A test that passes an `AbortSignal` to `extractor.extract(transcript,
{ signal: controller.signal })` and asserts the signal reaches `chat.complete`'s `ChatCallOptions`.
For `perGroupExtractor`, assert that aborting the signal while one group is in flight causes the
in-flight call to reject with `ChatError.aborted` and no further group starts — the existing
sibling-abort test in `per-group.test.ts` can be adapted to use the signal from the options bag
instead of the internal controller. For `FakeExtractor`, assert the options bag is accepted without
error. The existing per-group suite (44 tests) must pass unchanged.

---

# Phase D — Per-group composition (design §4.1–4.3)

> Depends on: Task 9 (the `signal` in `ExtractOptions` is needed for sibling-abort inside
> `groupedExtractor`). Tasks 10–12 are sequential within this phase.

## Task 10: `projectTarget` — narrow a target to one group, purely

**Files:** new file `packages/ribo-extractor-openai/src/project-target.ts`,
`packages/ribo-extractor-openai/src/index.ts` (export),
`packages/ribo-extractor-openai/src/extraction-common.ts` (re-express `buildGroupMessages` over
`projectTarget`)

**What to do:** Create a pure function `projectTarget` that takes an `ExtractionTarget<V, P>` and a
top-level key `K`, and returns an `ExtractionTarget<Pick<V, K>, Pick<P, K>>` whose
`extractionSchema` is the one-key strict object R3 already sends (`{ [key]: groupSchema }`), whose
`examples` are projected to that key with the existing `projectExample` /
`projectSingletonExample` / `narrowToLeaves`, and whose `instructions` are the supplied per-group
text or the target's own. Options carry `leafKeys` for a partitioned piece and `singleton` for the
tier-3 shape. This is `buildGroupMessages` with the message assembly taken back out: today the
projection and the assembly are fused, which is why a projected target cannot be handed to anything
but the per-group loop. Re-express `buildGroupMessages` to call `projectTarget` internally and then
assemble messages from the projected target — the messages it emits must be byte-identical.

**Test that must fail first:** Assert that `buildGroupMessages` re-expressed over `projectTarget`
emits byte-identical messages to today's implementation across partitioned pieces, singleton mode,
and the non-grouped fallback. The existing per-group message tests (in
`instructions.test.ts` and `per-group.test.ts`) are the regression gate. Add new tests for
`projectTarget` itself: the projected target's `extractionSchema` is a one-key strict object, the
key matches the argument, the examples are projected, and a wrong key is a compile error
(`Pick<V, K>` narrows at the type level).

## Task 11: `groupedExtractor` — the combinator in `ribo-core`

**Files:** new file `packages/ribo-core/src/grouped-extractor.ts`,
`packages/ribo-core/src/index.ts` (export)

**What to do:** Create `groupedExtractor` in `ribo-core` beside `fallbackExtractor` and
`raceExtractor`. It is a combinator over `Extractor`s and knows nothing about chat, prompts or
providers. Its options: the `target` (for the full-schema parse and the coverage check), a `groups`
map from top-level key to either one `Extractor<Pick<Enveloped<V, P>, K>>` or an ordered list of
them (the pieces of a partitioned group, recombined with `mergeGroupPieces` from `per-group.ts`,
which needs to move to core or be re-exported), the existing `concurrency` / `maxRetries` /
`stepTimeoutMs` / `perCallCeilingMs` / `BackoffOptions` / `RetryBudgetObserver` /
`ExtractionObserver<GroupUnit>` mixins, and `normalize`. Behaviour, all specified by R3 and the
observability design: coverage checked at construction (every top-level key named, no extras),
bounded pool, retry budget derived from entry count, `GroupUnit` events around each entry's
`extract()`, merge by key, second trust-boundary parse, normalize once, usage summed,
`statedEmptyGroups` unioned. The `mapWithPool` function and `mergeGroupPieces` already exist in
`per-group.ts`; move `mapWithPool` to core (it is byte-identical in `instance-fill.ts` too) or
extract it to a shared internal. The sibling-abort signal comes from `ExtractOptions.signal` (Task 9) — the combinator creates an `AbortController` and passes its signal to each group entry's
`extract()`.

**Test that must fail first:** The design's §9 must-fail tests, applied to `groupedExtractor`
directly: a `groups` map missing a top-level key throws at construction with the key named; a group
entry returning a one-key object of the wrong shape is rejected by the merged parse with a
`SchemaParseError` naming the merge context; when one group entry fails terminally, a sibling in
flight observes an aborted signal (needs Task 9); the derived `RetryBudget` for a known group count
equals today's. Two groups wired to two different fake chats each receive exactly their own group's
request.

## Task 12: `perGroupPlan`, `overrideGroups`, and presets over the combinator

**Files:** `packages/ribo-extractor-openai/src/per-group.ts` (rewrite as preset),
`packages/ribo-extractor-openai/src/index.ts` (new exports)

**What to do:** Create `perGroupPlan` that takes the same `PerGroupOptions` as today and returns
`{ groups, targets }`: `groups` is the exhaustive per-key map of default entries (a
`singleShotExtractor` per piece, built from `projectTarget(target, key, { leafKeys, singleton,
instructions: groupInstructions?.(key) })`), and `targets` is the index-aligned map of the projected
`ExtractionTarget`s. Create `overrideGroups` that takes a plan and an overrides object whose keys
are a subset of the group keys, and whose values are functions applied per piece — handing each
piece's default extractor and its projected target to the override function, and returning the full
map with untouched keys reference-equal to the plan's. Rewrite `perGroupExtractor` as
`groupedExtractor({ target, groups: perGroupPlan(options).groups, ...timing })` and nothing more.
`perGroupArrayExtractor` and `perGroupSingletonExtractor` remain names for the two `singleton`
settings.

**Test that must fail first:** The existing per-group suite (44 tests, including partitioning and
progress units) must pass against the preset unchanged: same requests recorded by the fake chat,
same partition boundaries, same `GroupUnit` events, same derived retry budget. The adapter's
`per-group-cap.test.ts` and the frozen fixture must pass. New tests for `overrideGroups`: every
non-overridden entry is reference-equal to `plan.groups`'s; an override is invoked once per piece
with that piece's projected target; an unknown key in the overrides object is a type error.

---

# Phase E — Remaining items

> These four tasks are independent of each other and of Phases B–D. They may land in any order.

## Task 13: Enable type-aware linting (type-story P6)

**Files:** `eslint.config.mjs`

**Problem:** The comment at `eslint.config.mjs:25–28` says "Syntactic rules only for now. Type-aware
linting lands once packages have real source to point at." The repo is no longer empty. B6's three
redundant casts are exactly what `no-unnecessary-type-assertion` exists for.

**What to do:** Replace `...tseslint.configs.recommended` with
`...tseslint.configs.recommendedTypeChecked` and add `projectService` to the `languageOptions` (the
`typescript-eslint` project-service configuration that discovers each package's `tsconfig.json`).
Run `pnpm lint` and triage the findings. Most will be in test files (`no-unsafe-assignment`,
`no-unsafe-member-access`). Suppress with inline comments or file-level disables where the unsafe
access is deliberate (test fixtures, `as unknown as` type-narrowing probes). The goal is a clean
`pnpm lint`, not zero suppressions. This task may produce a large diff; review it separately from
any logic change.

**Test that must fail first:** `pnpm lint` reports type-aware findings before the triage. After
triage, `pnpm lint` is clean and `./check.sh` is green. Note: enabling type-aware linting increases
lint time (type information per package). If the increase makes `./check.sh` impractically slow,
record the time and discuss before committing.

## Task 14: Fix docs links to unexported symbols (type-story B4)

**Files:** `typedoc.json` (register `@file` in `blockTags`), JSDoc comments across packages (demote
links to unexported symbols to plain code formatting, or export the symbol if a consumer needs it —
Task 5 covers the ones the designs name)

**Problem:** `pnpm docs:api` reports 48 warnings. 25 are "resolved but not included in the
documentation": `{@link}` targets that exist in source but are not on any barrel. 16 are
relative-path links TypeDoc cannot resolve. 7 are the `@file` block tag it does not know. This is a
CI gate, not a `./check.sh` gate.

**What to do:** Register `@file` in `typedoc.json`'s `blockTags` so the seven stop. For each of the
25 unexported-symbol links: if Task 5 exported the symbol, the link resolves; otherwise, demote the
`{@link SymbolName}` to backtick code formatting. For the 16 relative-path links, replace
`./transcribe.ts` with the barrel path or the symbol name. Mechanical; run `pnpm docs:api` to verify
zero warnings.

**Test that must fail first:** `pnpm docs:api` reports 48 warnings before the fix. After, zero. This
is a CI gate; `./check.sh` does not run it.

## Task 15: Type `RequiredOnCreate` against `V` (type-story P8)

**Files:** `packages/ribo-core/src/adapter.ts` (line 19, the `RequiredOnCreate` type),
`packages/ribo-core/src/review.ts` (reads it by string)

**Problem:** `RequiredOnCreate` is `Readonly<Record<string, readonly string[]>>` — group and leaf
names are untyped against `V`. A typo in an adapter's `requiredOnCreate` declaration is silent; the
adapter pins it with a runtime walk (`adapter-snuggpro/src/adapter.test.ts:176`) and `ToolAdapter`'s
doc comment tells every adapter author to write that test.

**What to do:** Create a type-level helper alongside `Enveloped` that maps `RequiredOnCreate` over
`V`: `{ [K in keyof V & string]?: readonly (keyof NonNullable<V[K]> & string)[] }`, unwrapping an
array group's element for the leaf keys. The runtime in `review.ts` reads `requiredOnCreate` by
string key, so the runtime does not change — the type change makes the typo a compile error. The
adapter's existing runtime test (`adapter.test.ts:176`) becomes a redundant check; keep it as
defense-in-depth, or remove it if the type check is sufficient (prefer keeping it — the runtime test
catches a JS caller).

**Test that must fail first:** A type-level test in `adapter.test.ts`: an adapter declared with a
`requiredOnCreate` that names a group not in `V` or a leaf not in that group's element is a type
error. The existing runtime test must still pass.

## Task 16: Try `exactOptionalPropertyTypes` on a branch (type-story P2)

**Files:** `packages/tsconfig/base.json` (add `"exactOptionalPropertyTypes": true`)

**Problem:** The repo keeps "absent" and "explicitly `undefined`" apart on purpose (documented at
`ExtractionUsage.cachedPromptTokens`, `GroupUnit.usage`, `FakeExtractor`'s `raw`, the relay's
conditional spreads). The compiler is not enforcing this: `{ ..., usage: undefined } satisfies
ExtractionUnit` compiles because `exactOptionalPropertyTypes` is not set.

**What to do:** This is a branch-trial task, not a commit-to-main task. On a throwaway branch, add
`"exactOptionalPropertyTypes": true` to `packages/tsconfig/base.json` and run `pnpm typecheck`.
Count the errors. If the count is small (under ~20), fix them and commit to main. If the count is
large, record the number and the categories (test fixtures, `?: T` members assigned from
`T | undefined` expressions, etc.) and leave the flag off — the convention stays as prose. The
finding itself says: "if the count is large, the alternative is to accept that the convention is
prose."

**Test that must fail first:** `pnpm typecheck` on the branch. The error count is the output.
Report the number and the decision.

---

# Deferred — not planned, with reasons

- **P3 (derivation invariant, type-story P3):** The finding offers two options. Option (a) types
  `extractionSchema` as `ReturnType<typeof enveloped<T, P>>` and makes the adapter generic over the
  schema type — a large signature change through `ToolAdapter`, `ExtractionTarget`, every strategy
  and `ribo-ui-react`. Option (b) is the `defineToolAdapter` factory, which only catches declaration
  sites that use it. `ValuesSchema<V>` already binds `schema.parse` to `V`, and `adapter.test.ts`
  pins the derivation for Snugg Pro. The blast radius of (a) is disproportionate to the marginal
  improvement, and (b) constrains less than the existing `ValuesSchema` type already does. Deferred
  until a second adapter makes the invariant worth the cost.

- **P5 (`ArbiterVerdict.accept` takes `ResultOutcome<F>`, type-story P5):** Reasoned, not verified.
  It removes a runtime identity check (`applyVerdict` at `arbitration.ts:240–250`) by having the
  arbiter return the outcome object instead of a fresh result. It touches three arbiters in core,
  `instanceLadder`'s consumers, and the guide. The design's §0.8 already declined retagging the
  verdict; this is narrower (one arm's payload), but it is still a contract change to the arbiter
  surface for a runtime check that has not been observed to fail. Deferred to a separate proposal
  with its own evidence.

- **Plugin storage delivery (post-docs-findings P2):** The substrate is built and unreachable. The
  delivery needs to widen both `Extractor.extract` and `Transcriber.transcribe` with a storage
  handle, and no `PluginStorage` type exists yet. Task 9 widens `extract`'s parameter list so the
  future addition is non-breaking, but the handle itself needs a design doc before it can be
  planned. This plan records the dependency; a future design doc should close it.

- **Inventory/ladder re-expression (design §4.6):** The design itself defers this. The
  `scopedInstanceExtractor` stays whole-schema and composes as a `groups` entry or the top of a
  `fallbackExtractor`. The roster-as-annotation re-expression needs a typed annotation channel first
  (P4's `AnnotatedTranscript.annotations` bag is open but untyped).

- **R3 §8 corpus comparison:** The design makes this easier to run per group but does not depend on
  it. Deferred by the design itself.

- **O1–O6 (observations):** No action proposed by the findings document itself.
