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
- **What the combinator owns** — scheduling under a bound, per-item retry, cancellation, a running deadline sliced per phase, the progress stream, usage accumulation, and the closing trust-boundary parse. The point being that a phase author writes what to ask and nothing else.
- **The draft** — fields fill progressively, `notes` carries typed cross-phase state through branded keys, and a leaf reads `T | null | undefined` where `undefined` means "not yet asked" and `null` means "asked, answered null". That distinction is the anti-hallucination rule and a reader will collapse it if not told.
- **`requires`/`produces`, checked at construction** — a mis-wired phase list fails before the first call is paid for, with the missing key named.
- **The three strategies are now presets over it** — `gapFillExtractor`, `scopedInstanceExtractor` and `threePhaseExtractor` each became a phase list, with unchanged public signatures. Say that a host can take their phases apart and recompose them, and that `extractorPhase` lifts any existing `Extractor` into a list.
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

Its header says "Draft — revised after review. **No implementation plan written yet.**" Seven plans exist and six have shipped. Update the status line to record that it is implemented, list the wave plans, and note the one thing still outstanding: the acceptance-gate run.

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

Extend that sentence rather than rewriting the section. Anyone changing code in this repo reads this file first, and the thing they most need to know is that a multi-pass strategy is now a phase list rather than a bespoke loop — because the four hand-rolled retry loops that motivated the work are gone, and someone about to write a fifth should find out here.

- [ ] **Step 1: Verify the current claim, extend it, commit**

---

### Task 6: Write down how to run the acceptance gate

**Files:**

- Create: `docs/roadmap/design/phased-extraction-acceptance.md`

**Why a file rather than a line in a plan.** The gate is manual, it is the last thing outstanding, and the person who runs it will not be the person who wrote these plans. It needs: what the bar is, which two harnesses run it, what each needs, and what to do with the result.

Record:

- **The bar is structural, not point accuracy** — completions, zero degenerations, 100% span fidelity, per the measurement doc behind the on-device strategy. Say why: the model is non-deterministic and the repo already records run-to-run variance on identical code, so a point-accuracy comparison cannot distinguish a regression from noise.
- **Two harnesses.** The on-device arm is a manual real-Chrome run (it refuses Chromium's stub); the managed arm needs secrets. Name both and what they need.
- **What a failure means.** The design's §8 names the three-phase port's ordering change as reasoned rather than measured. If the structural bar fails on the on-device arm, that is the hypothesis to test first — and the off-ramp is reverting that one port, not the program, since the engine and the other two ports stand independently.
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
- Retrofitting `groupedExtractor` or `instance-fill.ts` onto `retryAsync` — still deliberately carried, and the design's §8 names it.
- Running the acceptance gate. Task 6 documents it; running it needs a real browser and secrets.
- Any code change at all.

## Notes for the reviewer

The thing most worth adversarial attention is whether each doc claim is actually true of the shipped code — particularly the three-state leaf, the `requires`/`produces` construction check, and the claim that the three strategies' public signatures are unchanged. A guide describing the design rather than the implementation is the failure mode here, and it is invisible to every gate in this repo.
