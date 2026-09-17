# Phased Extraction — Wave 4: port `gapFillExtractor` onto the engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `gapFillExtractor` becomes two phases over `phasedExtractor` — a base extractor phase followed by one focused follow-up — with its public signature unchanged. This is the first port, and the thing it proves is `extractorPhase`: that any existing `Extractor` drops into a phase list.

**Architecture:** The preset keeps `GapFillOptions` exactly as it is and rebuilds its body as `phasedExtractor({ target, phases: [extractorPhase("base", base), gapFillPhase(…)] })`. Everything pure in `gap-fill.ts` — the two candidate finders, the leaf-path formatter, the merge, the message assembly, the two directives — moves into the phase's `plan`, `run` and `merge` unchanged. The candidate collection becomes `plan`; the no-candidates passthrough becomes the empty-plan case the engine already implements.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/phased-extraction-design.md` (§4.7)

## Global Constraints

- **`gapFillExtractor`'s exported signature does not change.** `GapFillOptions` keeps every member, with the same meanings. A host that calls it today must not have to change anything. The pure exports (`findAbstainedLeaves`, `findUngroundedLeaves`, `formatLeafPath`, `mergeGapFilledLeaves`, `AbstainedLeaf`, `GapFillTarget`) also stay exported with unchanged behaviour — they are part of the package's surface and other code may use them.
- **The acceptance bar is that gap-fill still works, not that requests are unchanged.** Requests may move. Events will. Behaviour that a _host_ depends on may not, except where this plan names the change explicitly.
- **One follow-up call, as today.** Both candidate kinds travel in a single call — the design note in `gap-fill.ts` explains why (they share the instructions, the transcript and the round trip). The phase's `plan` therefore yields at most **one** item carrying the whole candidate list, not one item per candidate.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`.

---

### Task 1: The gap-fill phase

**Files:**

- Create: `packages/ribo-extractor-openai/src/gap-fill-phase.ts`
- Create: `packages/ribo-extractor-openai/src/gap-fill-phase.test.ts`

**Interfaces:**

- Produces: `gapFillPhase<V, P>(options): Phase<V, P>` where `options` carries `target`, `chat`, `model`, `maxTokens`, `targets` and `normalize` — the follow-up half of `GapFillOptions`, minus `base` (which becomes the other phase) and minus the observer (which the engine owns).

**The three functions, mapped from today's body.**

`plan(draft)` collects candidates from `draft.fields` using the existing `findAbstainedLeaves` and `findUngroundedLeaves`, gated by the `targets` set exactly as the current code gates them. It returns `[]` when there are none — which is the whole passthrough behaviour — and otherwise a **single** item carrying the candidate list. `plan` is synchronous and pure, which these finders already are.

There is one wrinkle worth stating: `findUngroundedLeaves` needs the transcript text, and `plan` receives it on the `PhaseContext`, not the draft. Read it from the context.

`run(item, draft, ctx)` builds the messages with the existing `buildGapFillMessages` — including the conditional `UNGROUNDED_DIRECTIVE`, which depends on whether any _ungrounded_ candidates are present in this item — makes the one chat call, and parses the response as today. It reports the call on `PhaseOutput.usage`.

`merge(draft, outcomes)` applies the existing `acceptImprovements` and `mergeGapFilledLeaves` to install only the leaves that improved, then applies `normalize` to the merged fields.

**`normalize` runs in the phase's `merge`, not as the engine's option, and that is deliberate.** `GapFillOptions.normalize` is documented as "never runs on the passthrough path" — the base extractor's own normalize already ran inside `base`, so running it again when no follow-up happened would run it twice on that path. Handing it to `phasedExtractor` as the run-level `normalize` would do exactly that, because the engine normalizes unconditionally before the closing parse. Putting it in `merge` preserves today's semantics precisely: it runs when and only when the phase did work.

`describeItem` returns `{ key: "" }` — the follow-up is one call over the whole document, which is the case the `""` convention exists for.

`maxRetries` is **0**. `gap-fill.ts` states it outright: "attempt always 1 — there is no retry loop", and failures propagate to the arbiter or relay. The engine would otherwise retry it at the run default, which is a behaviour change nobody asked for.

- [ ] **Step 1: Write the failing tests**

  Against a fake chat, with hand-built drafts rather than a real base extractor: `plan` returns one item when abstained candidates exist and `[]` when none do; `plan` respects `targets` — with the default (`["abstained"]`) an ungrounded-only draft yields `[]`, and with `["abstained","ungrounded"]` it yields one item carrying both kinds; the messages carry the `UNGROUNDED_DIRECTIVE` only when the item holds an ungrounded candidate; `run` makes exactly one chat call and reports it on `PhaseOutput.usage`; `merge` installs only improved leaves and leaves the others exactly as they were; and `merge` applies `normalize` to the merged fields.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement**

  Import the pure helpers from `gap-fill.ts` rather than copying them. If one is not exported and needs to be, export it — do not duplicate it.

- [ ] **Step 4: Run to verify they pass, typecheck**

- [ ] **Step 5: Commit**

---

### Task 2: `gapFillExtractor` becomes the preset

**Files:**

- Modify: `packages/ribo-extractor-openai/src/gap-fill.ts` (the `gapFillExtractor` body only)
- Modify: `packages/ribo-extractor-openai/src/gap-fill.test.ts`

**Interfaces:**

- Unchanged: `gapFillExtractor<V, P>(options: GapFillOptions<V, P>): Extractor<Enveloped<V, P>>`.

**The new body.** `phasedExtractor({ target, phases: [extractorPhase("base", base), gapFillPhase({ target, chat, model, maxTokens, targets, normalize })], onUnit })` and nothing else. Delete the hand-rolled orchestration: the candidate collection, the passthrough branch, the usage combination, the event emission. Keep every pure helper and every doc comment explaining _why_ — the directives, the finders, the merge, and the measurement notes on `targets`. Those are the valuable part of this file and none of them move.

**Three behaviour changes this port makes, all deliberate, all requiring a test amendment.** Name each in the commit message.

1. **Events change from `GapFillUnit` to `PhaseUnit`.** The engine owns the unit stream. The existing assertions on `unit: "gapfill"` and its `candidates` count must be rewritten against `PhaseUnit` — `phaseId` of `"gap-fill"`, `pass: 1`. The candidate count is no longer on the event; if it is worth keeping, that is a follow-up, not this port. `GapFillUnit` stays in the `ExtractionUnit` union until Wave 6 removes it, and is simply unused after this.
2. **`fields` identity on the passthrough path is lost.** Today the no-candidates path returns the base result object itself, and the suite pins `expect(result.fields).toBe(committedFields)`. The engine rebuilds the result from the draft and re-parses it, so the returned `fields` is an equal object rather than the same one. Change that assertion to a deep equality and note in the test why. `raw` still passes through.
3. **The closing parse now runs on the passthrough path.** Today a no-candidates run returns the base result without re-parsing. Under the engine, the merged draft is parsed against `extractionSchema` on every run. This is a strict improvement — a base extractor returning something invalid no longer slips through the gap-fill wrapper untouched — but it is a new failure mode for a broken base, so it gets its own test rather than being discovered later.

- [ ] **Step 1: Rewrite the body**

  Then run the existing suite and **read every failure before changing anything**. Each failure is either one of the three changes above, in which case amend the test and note why in a comment, or it is a real regression, in which case fix the code. Do not amend an assertion you cannot place in one of the three named categories — stop and report instead.

- [ ] **Step 2: Amend the three categories of assertion**

- [ ] **Step 3: Add the new-failure-mode test**

  A base extractor returning fields that do not satisfy `extractionSchema`, with no gap-fill candidates, now rejects with a `SchemaParseError` where it previously resolved.

- [ ] **Step 4: Run the whole package suite**

  Run `pnpm vitest run packages/ribo-extractor-openai`. Expected: PASS, with only the amendments above.

- [ ] **Step 5: Commit**

---

### Task 3: Prove the composition claim

**Files:**

- Modify: `packages/ribo-extractor-openai/src/gap-fill.test.ts`

**Why this task exists.** The design's argument for `extractorPhase` is that _any_ `Extractor` becomes a phase, so a host can put an existing combinator and a custom phase in one list. This port is the first evidence for that claim, and the claim is worth one explicit test rather than being left implicit in the preset's own wiring.

- [ ] **Step 1: Write the test**

  Build a `phasedExtractor` by hand whose phases are `extractorPhase("base", someExistingExtractor)` and `gapFillPhase(…)` — i.e. what the preset builds, assembled by a caller — and assert it produces the same fields as `gapFillExtractor` given the same inputs and the same fake chat. Use a `FakeExtractor` as the base so the test needs no model for the first phase.

- [ ] **Step 2: Run it** — Expected: PASS (this is a claim-pinning test, not a red-green cycle).

- [ ] **Step 3: Commit**

---

### Task 4: Changeset and the full gate

**Files:**

- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Add a changeset**

  `@azx/ribo-extractor-openai` is **major**: the progress events a consumer receives change shape, and the passthrough path's `fields` is no longer the same object. Say both in the summary, plus what a consumer gains — gap-fill is now a phase list a host can extend, rather than a closed wrapper.

- [ ] **Step 2: Run the full gate**

  `./check.sh`, then `pnpm docs:build` and `pnpm changeset status --since=origin/main`. Expected: PASS.

- [ ] **Step 3: Commit**

---

## Out of scope

- Porting `scopedInstanceExtractor` (Wave 5) or `threePhaseExtractor` (Wave 6).
- Removing `GapFillUnit` from the `ExtractionUnit` union — Wave 6, once nothing emits any of the three retiring unit types.
- Restoring the candidate count to the progress event. If it turns out to matter, that is a `PhaseUnit` question and a separate change.
- Retrofitting `groupedExtractor` or `instance-fill.ts` onto `retryAsync`.
- The acceptance-gate run. It happens once, after every port has landed.

## Notes for the reviewer

Two things most worth adversarial attention. First, whether `normalize`-in-`merge` genuinely reproduces today's "never on the passthrough path" semantics, or whether there is a path where it now runs twice or not at all. Second, whether `plan` can actually read the transcript from the `PhaseContext` — if it cannot, the ungrounded finder has no text to check spans against and the whole `targets: ["ungrounded"]` feature silently stops working, which no existing test would catch if the tests build their own drafts.
