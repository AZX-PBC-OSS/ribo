# Phased Extraction — Wave 4: port `gapFillExtractor` onto the engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `gapFillExtractor` becomes two phases over `phasedExtractor` — a base extractor phase followed by one focused follow-up — keeping every behaviour a host depends on except the six changes this plan names. This is the first port, and the thing it proves is `extractorPhase`.

**Architecture:** The preset rebuilds its body as `phasedExtractor({ target, phases: [base phase, gapFillPhase(…)] })`. Everything pure in `gap-fill.ts` — the two candidate finders, the leaf-path formatter, the merge, the message assembly, the two directives — moves into the phase's `plan`, `run` and `merge` unchanged. The candidate collection becomes `plan`; the no-candidates passthrough becomes the engine's empty-plan case. One small engine change rides along, because the engine's usage accumulation is currently lossy in a way this port would expose as a regression.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/phased-extraction-design.md` (§4.7)

## Global Constraints

- **The acceptance bar is that gap-fill still works.** Requests may move. Anything a _host_ depends on may not, **except** the six changes named in Task 4, each of which requires a test amendment with a comment saying why.
- **`gapFillExtractor`'s signature is unchanged except its observer's unit type** (Task 4, change 4). Every other `GapFillOptions` member keeps its meaning. The pure exports — `findAbstainedLeaves`, `findUngroundedLeaves`, `formatLeafPath`, `mergeGapFilledLeaves`, `AbstainedLeaf`, `GapFillTarget` — stay exported with unchanged behaviour.
- **One follow-up call, as today.** Both candidate kinds travel in a single call; `gap-fill.ts` explains why. `plan` therefore yields at most **one** item carrying the whole candidate list.
- **Neither phase retries.** Today the wrapper calls `base.extract` exactly once and the follow-up has no retry loop. Both phases pin `maxRetries: 0` — see Task 2 and Task 3.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`.

---

### Task 1: The engine's usage accumulation carries `engine` and `strategy`

**Files:**

- Modify: `packages/ribo-core/src/phased-extractor.ts` (the usage accumulator and the result assembly)
- Modify: `packages/ribo-core/src/phased-extractor.test.ts`

**Why this is a prerequisite and not a nicety.** `phasedExtractor` accumulates `calls` and the four token totals, and nothing else. But `ExtractionUsage` also carries `engine` and `strategy`, and both are host-visible: `toSessionExtractStep` lifts `usage.engine` onto the session so a review card can say which engine produced a draft, and `strategy` is the provenance channel the arbitration work added. Today `gapFillExtractor` preserves them by spreading the base usage. Ported onto an engine that drops them, gap-fill would silently stop reporting either — and the existing suite pins `engine: "fake"`, so the failure would surface as an unclassifiable test break mid-port rather than as a decision.

**The rule: first writer wins.** The accumulator takes `engine` from the first phase output that reports one, and `strategy` likewise, independently. A run whose phases span two transports has no single engine, and reporting the first is both defensible and what gap-fill does today (the base phase runs first, and `combinedUsage` spreads the base's usage). Document that in the accumulator.

- [ ] **Step 1: Write the failing tests**

  A run whose first phase reports `engine: "a"` and whose second reports `engine: "b"` yields `engine: "a"`; a run where only the _second_ phase reports one yields that one; a run where none does omits the member entirely rather than emitting `undefined`; and the same three for `strategy`, including a run where `engine` comes from one phase and `strategy` from another.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the accumulator drops both members.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the core suite** — Expected: PASS, nothing else modified.

- [ ] **Step 5: Commit**

---

### Task 2: The gap-fill phase

**Files:**

- Create: `packages/ribo-extractor-openai/src/gap-fill-phase.ts`
- Create: `packages/ribo-extractor-openai/src/gap-fill-phase.test.ts`

**Interfaces:**

- Produces: `gapFillPhase<V, P>(options): Phase<V, P>` — `target`, `chat`, `model`, `maxTokens`, `targets`, `normalize`. No `base` (that is the other phase) and no observer (the engine owns it).

**The three functions, mapped from today's body.**

`plan(draft, ctx)` collects candidates from `draft.fields` with the existing `findAbstainedLeaves` and `findUngroundedLeaves`, gated by `targets` exactly as the current code gates them, reading the transcript text from `ctx.transcript.text`. Returns `[]` when there are none — the whole passthrough behaviour — else a **single** item carrying the candidate list.

`run(item, draft, ctx)` builds messages with the existing `buildGapFillMessages`, including the conditional `UNGROUNDED_DIRECTIVE` when the item holds an ungrounded candidate, makes the one chat call, parses as today, and reports the call on `PhaseOutput.usage`.

`merge(draft, outcomes)` applies `acceptImprovements` and `mergeGapFilledLeaves`, then sets **both** `fields` and `raw`, then applies `normalize` to `fields`.

**`raw` must be written here or it regresses invisibly.** Today the follow-up path sets `raw` to the _merged_ fields — the base's answers with the follow-up's accepted ones spliced in — so both calls' contributions stay visible in one place, and it does so whether or not the base carried a raw of its own. Under the port, the result's `raw` comes from `draft.raw`, which only the base phase writes and only when the base result had one. If this `merge` does not set it, a follow-up run either loses `raw` entirely or reports the base's raw model output instead of the merged fields. Nothing in the existing suite asserts `raw` on the follow-up path, so this would ship silently. Set `raw` to the merged fields **before** `normalize` runs, matching today.

**`normalize` runs here, not as the engine's option.** `GapFillOptions.normalize` is documented as never running on the passthrough path, and the engine normalizes unconditionally before the closing parse. The engine skips `merge` entirely on an empty plan, so putting it here reproduces today's semantics exactly: once on the follow-up path, never on passthrough.

**`maxRetries` is 0**, and `describeItem` returns `{ key: "" }` — one call over the whole document, which is what the `""` convention is for.

**The one cast, and why it is sound.** The three pure helpers take `Enveloped<V, P>`; `draft.fields` is `DeepPartial<Enveloped<V, P>>`, which is deliberately not assignable to it. A cast is required. It is sound _in this composition_ because the base phase populates complete fields before this phase runs — but nothing enforces that for a `gapFillPhase` used standalone, which Task 5's composition test explicitly invites. Document the assumption at the cast rather than leaving it implicit.

There is no absent-versus-null hazard here, which is worth stating because it looks like one: `isExtractedLeaf` requires `"value" in record`, so a partially-present leaf is skipped rather than collected, and the finders' `=== null` checks keep `undefined` and `null` apart. Task 2's tests pin it.

- [ ] **Step 1: Write the failing tests**

  Against a fake chat with hand-built drafts: `plan` returns one item when abstained candidates exist and `[]` when none do; `plan` respects `targets` — the default yields `[]` for an ungrounded-only draft, and `["abstained","ungrounded"]` yields one item carrying both; **a leaf whose `value` key is absent entirely is not collected** (the absent-versus-null pin); the messages carry `UNGROUNDED_DIRECTIVE` only when the item holds an ungrounded candidate; `run` makes exactly one chat call and reports it on `PhaseOutput.usage`; `merge` installs only improved leaves and leaves the others untouched; **`merge` sets `raw` to the merged fields**; and `merge` applies `normalize` to `fields` but **not** to `raw`.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** — import the pure helpers from `gap-fill.ts`; export one if needed rather than duplicating it.

- [ ] **Step 4: Run to verify they pass, typecheck**

- [ ] **Step 5: Commit**

---

### Task 3: `gapFillExtractor` becomes the preset

**Files:**

- Modify: `packages/ribo-extractor-openai/src/gap-fill.ts` (the `gapFillExtractor` body and `GapFillOptions`' observer type)

**The new body.** `phasedExtractor({ target, phases: [basePhase, gapFillPhase({ target, chat, model, maxTokens, targets, normalize })], onUnit })`, where `basePhase` is `extractorPhase("base", base)` **with `maxRetries: 0`**. Delete the hand-rolled orchestration: the candidate collection, the passthrough branch, the usage combination, the event emission. Keep every pure helper and every doc comment explaining _why_ — the directives, the finders, the merge, the measurement notes on `targets`. Those are the valuable part of the file.

**Pin the base phase at zero retries.** Today the wrapper calls `base.extract` exactly once. `extractorPhase` declares no `maxRetries`, so it would inherit the run default of 2 and attempt a transiently-failing base up to three times with real backoff — stacking on whatever retry policy the base already has, and emitting per-attempt error events. `validatePhases` accepts 0. `FakeExtractor` never fails, so no existing test would catch this.

**Widen the observer's unit type.** `GapFillOptions.onUnit` is declared over `GapFillUnit`. After the port the engine emits `PhaseUnit`s to it, so the declared type would be a lie — a host's handler would receive events its type says cannot exist. Change the option to `ExtractionObserver<PhaseUnit>`. This is a breaking signature change and is named in Task 4.

- [ ] **Step 1: Rewrite the body and widen the observer type**

- [ ] **Step 2: Typecheck, then commit**

  Do not run the suite yet — Task 4 is where its failures get classified, and running it here invites amending assertions before the inventory is in front of you.

---

### Task 4: Classify and amend every failing test

**Files:**

- Modify: `packages/ribo-extractor-openai/src/gap-fill.test.ts`

**Run the suite and read every failure before changing anything.** Each must fall into one of the six categories below. **A failure fitting none of them is a real regression — stop and report rather than amending it.**

1. **Events change from `GapFillUnit` to `PhaseUnit`.** Assertions on `unit: "gapfill"` and its `candidates` count become assertions on `phaseId` and `pass`. The candidate count is no longer on the event; restoring it would be a `PhaseUnit` change and is not this port.
2. **The passthrough now emits.** Today it emits nothing at all; the base phase always plans one item, so every run — passthrough included — emits a base `start`/`done` pair. Rewrite the "zero candidates emit nothing" test to assert the exact new sequence, and update the ordering test, which now sees base-phase events on the wrapper's observer.
3. **Reference identity is lost, on both paths.** Not just the passthrough's top-level `fields`: the closing parse rebuilds every object, so the merge test's assertion that untouched leaves are reference-equal to the base's also fails. Amend all of them to deep equality. The identity-preservation property still holds inside `mergeGapFilledLeaves` and is still pinned by the pure-helper tests, which call it directly — say so in a comment so a reader knows where the guarantee lives now.
4. **The observer's unit type widened** (Task 3). Any test constructing a `GapFillUnit`-typed handler needs its type updated.
5. **`usage.engine` and `usage.strategy` now come from the first reporting phase** rather than from spreading the base's usage. With the base phase first, the observable result is unchanged — the existing `engine: "fake"` assertion should still pass. If it does not, that is a Task 1 bug, not an amendment.
6. **The closing parse now runs on the passthrough path.** A base extractor returning fields that do not satisfy `extractionSchema` now rejects where it previously resolved.

- [ ] **Step 1: Run the suite and write down every failure and its category**

- [ ] **Step 2: Amend, with a comment on each amended assertion naming its category**

- [ ] **Step 3: Fix the passthrough normalize test, which the amendment would otherwise hollow**

  That test proves `normalize` does not run on the passthrough path _by identity_ — it passes a spread-identity normalize and asserts the result is the same object. Amending `toBe` to `toEqual` makes it pass whether or not normalize ran, because a spread-identity normalize is value-preserving. Replace the normalize with an **observable** one (the clamp used elsewhere in this suite works) and assert the clamp did **not** apply. Without this, the only test guarding "never on the passthrough path" silently stops guarding anything.

- [ ] **Step 4: Add the two assertions nothing currently covers**

  `result.raw` deep-equals the merged fields after a follow-up (the regression Task 2's `merge` exists to prevent). And a transiently-failing base extractor is attempted exactly **once** (the regression Task 3's `maxRetries: 0` exists to prevent).

- [ ] **Step 5: Run the whole package suite** — `pnpm vitest run packages/ribo-extractor-openai`. Expected: PASS.

- [ ] **Step 6: Commit**

---

### Task 5: Prove the composition claim

**Files:**

- Modify: `packages/ribo-extractor-openai/src/gap-fill.test.ts`

**Why.** The design's argument for `extractorPhase` is that any `Extractor` becomes a phase, so a host can put an existing combinator and a custom phase in one list. This port is the first evidence, and the claim deserves an explicit test rather than being implicit in the preset's wiring.

- [ ] **Step 1: Write the test**

  Assemble a `phasedExtractor` by hand — `extractorPhase("base", aFakeExtractor)` with `maxRetries: 0`, then `gapFillPhase(…)` — and assert it produces the same fields as `gapFillExtractor` given the same inputs and the same fake chat.

- [ ] **Step 2: Run it** — Expected: PASS. This is a claim-pinning test, not a red-green cycle.

- [ ] **Step 3: Commit**

---

### Task 6: Changeset and the full gate

- [ ] **Step 1: Add a changeset**

  `@azx/ribo-extractor-openai` **major**, `@azx/ribo-core` **minor** (Task 1 is additive). The summary must name the host-visible changes: the observer's unit type widens and it now receives phase events including on the passthrough path; returned objects are no longer reference-equal to the base's; and a base extractor producing an invalid shape is now caught by the closing parse. Plus what a consumer gains: gap-fill is a phase list a host can extend rather than a closed wrapper.

- [ ] **Step 2: Run the full gate** — `./check.sh`, `pnpm docs:build`, `pnpm changeset status --since=origin/main`.

- [ ] **Step 3: Commit**

---

## Out of scope

- Porting `scopedInstanceExtractor` (Wave 5) or `threePhaseExtractor` (Wave 6).
- Removing `GapFillUnit` from the `ExtractionUnit` union — Wave 6, once nothing emits any of the three retiring types.
- Restoring the candidate count to the progress event.
- Retrofitting `groupedExtractor` or `instance-fill.ts` onto `retryAsync`.
- The acceptance-gate run — once, after every port has landed.

## Reviewed

Reviewed by OpenCode (`glm-5p3-flash`, run 6b4f) before implementation. All seven findings applied; the plan grew from four tasks to six.

The inventory of deliberate changes was incomplete — three named, six real — and Task 4's own "stop if it fits no category" rule would therefore have stalled the port on its first run. Two regressions would have shipped invisibly, because nothing in the suite asserts them: `raw` on the follow-up path (today the _merged_ fields, under the naive port either absent or the base's raw model output), and the base extractor gaining engine-level retries where today it is called exactly once.

Two more were host-visible and unnamed: the engine's usage accumulator drops `engine` and `strategy`, which reach the session through `toSessionExtractStep`, so Task 1 now fixes the engine before the port touches it; and `GapFillOptions.onUnit` is typed over `GapFillUnit` while the engine emits `PhaseUnit`, which would have handed hosts events their declared type forbids.

The sharpest finding was that one of my own amendments hollowed a test: changing the passthrough's `toBe` to `toEqual` makes it pass whether or not `normalize` ran, because the normalize it uses is spread-identity. The only guard on "never runs on the passthrough path" would have stopped guarding while still appearing to.

The review also confirmed what I asked it to check: `normalize`-in-`merge` reproduces today's semantics exactly (the engine skips `merge` on an empty plan), `plan` can reach the transcript through `ctx`, the one-item decision loses nothing given `maxRetries: 0`, and — the question I was most unsure of — there is **no** absent-versus-null conflation in the finders, because `isExtractedLeaf` requires the `value` key to be present.
