# Phased Extraction — Wave 7: tell the reader the composition layer exists

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the program by making the docs describe what the library now does. Six waves shipped a phase vocabulary, an engine and three ports, and no guide mentions any of it. Nothing here changes code behaviour.

**Architecture:** Documentation and status only. The guides gain a phased-composition section; the design doc stops claiming no plan exists; the roadmap records what shipped; the stale architectural claim in `AGENTS.md` is corrected; and the acceptance-gate instructions are written down where the person who has to run them will find them.

**Tech Stack:** Markdown. No code changes.

**Spec:** `docs/roadmap/design/phased-extraction-design.md`

## Global Constraints

- **No code changes.** Not a rename, not a doc comment on a source file, not a test. If a doc claim turns out to be false about the code, **stop and report** rather than changing the code to match the doc — that would be a behaviour change smuggled in under a docs wave.
- **Every claim must be true of the code as it stands.** Verify each one against the source before writing it. A guide that describes an intended design rather than the shipped one is worse than no guide, because a reader cannot tell which they are reading.
- **Do not document the agentic layer.** It is a later sub-project and does not exist. Referring to it as though it does is the single easiest way to make these docs wrong.
- Prose follows the existing guide voice: second person, short paragraphs, a runnable example per concept, and an explanation of _why_ a thing is shaped the way it is rather than only what it does.
- `pnpm docs:build` must pass; it is part of the CI bar and these files are what it builds.

---

### Task 1: The extraction guide gains phased composition

**Files:**

- Modify: `docs/guide/extraction.md`

**What to add**, after the existing strategy sections and before whatever closes the page: a section introducing `phasedExtractor` as the way a multi-pass strategy is expressed.

Cover, in this order, and verify each against the source first:

- **What a phase is** — `plan` narrows the next pass's work from accumulated state, `run` does one unit, `merge` folds the batch back. Say that `plan` is synchronous and pure, and why (a phase needing I/O to decide its work should do that I/O in an earlier phase's `run`).
- **What the combinator owns** — scheduling under a bound, per-item retry, cancellation, a deadline carried to every item, the progress stream, usage accumulation, and the closing trust-boundary parse. The point being that a phase author writes what to ask and nothing else.

  Be precise about the deadline: **nothing slices it.** Every phase's context receives the same effective deadline. What is divided per phase is the input to the _retry-budget_ derivation — remaining time over remaining phases. A reader told the deadline is sliced will go looking for a member that does not exist.

- **The draft** — fields fill progressively, `notes` carries typed cross-phase state through branded keys, and a leaf reads `T | null | undefined` where `undefined` means "not yet asked" and `null` means "asked, answered null". That distinction is the anti-hallucination rule and a reader will collapse it if not told.
- **`requires`/`produces`, checked at construction** — a mis-wired phase list fails before the first call is paid for, with the missing key named.
- **The three strategies are now presets over it** — `gapFillExtractor`, `scopedInstanceExtractor` and `threePhaseExtractor` each became a phase list. **Their option names held; two of the three changed their observer's unit type.** `GapFillOptions` and `ScopedFillOptions` used to be declared over the strategy-specific unit types and are now over `PhaseUnit`, so a handler written against the old type receives events its type did not name. `ThreePhaseExtractorOptions` was already over `PhaseUnit` and did not change. Do **not** write "unchanged public signatures" — it is false for two of the three, and it contradicts the major version bumps those ports declared.

  While you are there, the wave-4 changeset records three further host-visible gap-fill changes worth a sentence: the passthrough path now emits a base-phase `start`/`done` pair where it emitted nothing, the per-event candidate count is gone, and returned objects are no longer reference-equal to the base's.

- **Which phases a host can actually compose.** `gapFillPhase`, `inventoryPhase`, `fillPhase` and `rosterNoteKey` are exported from `@azx/ribo-extractor-openai`'s barrel. The on-device strategy's four phases are **not** exported — they live under an internal directory and the package's entry point exposes only the preset — and this repo forbids deep imports. Say which are available rather than implying all are; a reader following a general claim would hunt for exports that do not exist. `extractorPhase` lifts any existing `Extractor` into a list, in any package.
- **`onItemFailure`** — `"abort"` fails the run and cancels siblings; `"skip"` hands the failed outcome to `merge` to interpret. This is the one policy decision every phase author makes. Say that a cancellation overrides it either way, and that interpretation is the phase's job — the ported on-device strategy nulls a leaf's span when presence fails and keeps it when classify fails, two readings of "this item failed" inside one strategy.
- **`describeItem`** — without it every progress event carries an empty key. An author who wants a meaningful progress stream cannot discover this any other way.
- **`produces` is checked twice** — at construction, and again at each phase boundary at runtime, because a phase that declares a key and writes it only conditionally is a silent liar. An author warned only about the construction check will not expect the second.
- **A declared `maxRetries` is a request, not a promise** — the engine derives each phase's share from the time remaining and may run it with fewer. This is why the on-device preset sets the numbers it does, and that preset is inexplicable without it.
- **One worked example**, small enough to read: a two-phase list with a real narrowing between them.

- [ ] **Step 1: Verify every claim against the source** — read `phase.ts`, `phased-extractor.ts`, `phase-draft.ts`, `phase-notes.ts`, `validate-phases.ts`, `extractor-phase.ts`. Write down any claim above that the code does not support, and report it rather than writing it.

- [ ] **Step 2: Write the section**

- [ ] **Step 3: `pnpm docs:build`** — Expected: PASS.

- [ ] **Step 4: Commit**

---

### Task 2: The arbitration guide points at composition

**Files:**

- Modify: `docs/guide/arbitration.md`

This page already covers composing strategies — fallback ladders, racing, the arbiter contract. It should say where phased composition sits relative to those: arbitration chooses **between** strategies, phases are the steps **within** one. A short section plus a cross-link to Task 1's, not a duplicate of it.

Also note the two wrappers that landed alongside and are independently useful: `retryExtractor` and `timeoutExtractor` over any `Extractor`, with `timeoutExtractor`'s error deliberately not cancellation-branded so an outer retry will retry it.

- [ ] **Step 1: Verify, write, `pnpm docs:build`, commit**

---

### Task 3: The design doc stops lying about its own status

**Files:**

- Modify: `docs/roadmap/design/phased-extraction-design.md`

Its header says "Draft — revised after review. **No implementation plan written yet.**" Eight wave-plan files exist (waves 1, 2, 3a, 3b, 4, 5, 6, 7), covering seven waves, of which six have shipped. State whichever count the file tree actually supports rather than repeating one of these. Update the status line to record that it is implemented, list the wave plans, and note the one thing still outstanding: the acceptance-gate run.

Leave the body alone. It is a record of what was decided and why, including the arguments that were overruled, and rewriting it to match the outcome would destroy exactly what makes it worth keeping. Where the body was corrected mid-program — the cancellation-classification error, the byte-identity bar — those corrections are already in it.

- [ ] **Step 1: Update the status block, commit**

---

### Task 4: The roadmap records what shipped

**Files:**

- Modify: `docs/roadmap/index.md`

Add an entry to "What has shipped" for the phased-extraction program: what it is, that the three strategies are presets over it, and a link to the design doc. Match the existing entries' voice and length — they are a sentence or two each, not summaries.

- [ ] **Step 1: Write, commit**

---

### Task 5: Correct the stale architectural claim in `AGENTS.md`

**Files:**

- Modify: `AGENTS.md`

Its architecture summary describes "the extraction-arbitration engine for composing strategies" and lists `fallbackExtractor`, `raceExtractor` and the arbiter contract. That is still true and is now incomplete: it predates the phase vocabulary, the engine and the three ports.

Extend that sentence rather than rewriting the section. Anyone changing code in this repo reads this file first, and the thing they most need to know is that a multi-pass strategy is now a phase list rather than a bespoke loop — because the on-device strategy's four hand-rolled retry loops are gone and `instance-fill.ts`'s with them, and someone about to write another should find out here. Do not imply the tree is loop-free: `groupedExtractor` still inlines one, which the design keeps as a named smell.

- [ ] **Step 1: Verify the current claim, extend it, commit**

---

### Task 6: Write down how to run the acceptance gate

**Files:**

- Create: `docs/roadmap/design/phased-extraction-acceptance.md`

**Why a file rather than a line in a plan.** The gate is manual, it is the last thing outstanding, and the person who runs it will not be the person who wrote these plans. It needs: what the bar is, which two harnesses run it, what each needs, and what to do with the result.

Record:

- **The bar is structural, not point accuracy** — completions, zero degenerations, 100% span fidelity, per the measurement doc behind the on-device strategy. Say why: the model is non-deterministic and the repo already records run-to-run variance on identical code, so a point-accuracy comparison cannot distinguish a regression from noise.
- **Two harnesses.** The on-device arm is a manual real-Chrome run (it refuses Chromium's stub); the managed arm needs secrets. Name both and what they need.
- **What a failure means.** The design's **§4.7** reasons the three-phase port's ordering change (phase-major rather than group-major, and the wrapped-classify fourth phase) and concedes it is reasoned rather than measured. Cite §4.7, not §8 — §8's bullets are about other risks entirely, and an acceptance file that misdirects at the moment of failure is worse than one that says nothing. If the structural bar fails on the on-device arm, that is the hypothesis to test first — and the off-ramp is reverting that one port, not the program, since the engine and the other two ports stand independently.
- **Bisecting.** The gate runs once after all three ports rather than per port, so a failure does not identify its own cause. Name the three port commits so a bisect starts from the right place.

- [ ] **Step 1: Verify the harness paths and their requirements against the repo**

- [ ] **Step 2: Write the file, link it from the design doc's status block and the roadmap entry**

- [ ] **Step 3: `pnpm docs:build`, commit**

---

### Task 7: The gate

- [ ] **Step 1: Run `./check.sh`, `pnpm docs:build`, `pnpm changeset status --since=origin/main`**

  No changeset is needed: this wave changes no published code, and the majors for the program are already declared by the earlier waves' changesets. Verify that rather than assuming it — if `changeset status` wants one, add a patch-level entry for the docs.

- [ ] **Step 2: Commit**

---

## Out of scope

- The agentic layer (SP4) and the SP2/SP3 combinators. Not built, not documented.
- Retrofitting `groupedExtractor` onto `retryAsync` — still deliberately carried, and the design's §8 names it. (`instance-fill.ts` no longer has an inline loop; Wave 5 ported it. There is nothing left to retrofit there.)
- Exporting the on-device strategy's four phases. They are internal today, which makes the composition story asymmetric across packages — worth closing, but it is a code change and this wave has none.
- Running the acceptance gate. Task 6 documents it; running it needs a real browser and secrets.
- Any code change at all.

## Notes for the reviewer

The thing most worth adversarial attention is whether each doc claim is actually true of the shipped code — particularly the three-state leaf, the `requires`/`produces` construction check, and the claim that the three strategies' public signatures are unchanged. A guide describing the design rather than the implementation is the failure mode here, and it is invisible to every gate in this repo.

## Reviewed

Reviewed by OpenCode (`glm-5p3-flash`, run 08b1) before implementation. All eight findings applied.

**Two of the claims this plan told the writer to make were false**, which is the failure mode a
docs-wave review exists to catch, since nothing in this repo typechecks prose. "Unchanged public
signatures" is false for two of the three presets — `GapFillOptions` and `ScopedFillOptions` both
moved their observer to `PhaseUnit`, which is why those ports declared majors, so the guide would
have contradicted its own changesets. And "a host can take their phases apart" is false for the
on-device strategy, whose four phases are internal; only the `ribo-extractor-openai` phases are
exported, and this repo forbids deep imports. A reader following the general claim would have hunted
for exports that do not exist.

**A wrong citation in the artifact that most needs to be right.** The acceptance file was told to
cite §8 for the three-phase ordering change; §8 is about other risks entirely and the reasoning is
in §4.7. That file is read at the moment the gate fails, and misdirecting there is worse than saying
nothing.

**Four real gaps in the guide's coverage**, all from the shipped surface: `onItemFailure` — the one
policy decision every phase author makes, plus the rule that cancellation overrides it; `describeItem`,
without which every progress event carries an empty key and which is undiscoverable otherwise; the
runtime half of the `produces` check, which throws mid-run for a conditionally-written key; and that
a declared `maxRetries` is a request rather than a promise, without which the on-device preset's
tuning is inexplicable.

**One imprecision the guide would have propagated:** nothing slices the deadline. Every phase's
context receives the same effective deadline; what is divided per phase is the input to the
retry-budget derivation. A reader told otherwise goes looking for a member that does not exist.

Plus two stale statements of my own: `instance-fill.ts` no longer carries an inline retry loop (Wave
5 took it), so only `groupedExtractor` remains to retrofit and the docs must not imply the tree is
loop-free; and the plan count was wrong in every reading.

The review verified the rest against source, including the whole acceptance-gate setup — both
harnesses exist as described, the on-device arm does refuse Chromium's stub, the managed arm does
require the two environment variables, and the structural bar matches the measurement doc.
