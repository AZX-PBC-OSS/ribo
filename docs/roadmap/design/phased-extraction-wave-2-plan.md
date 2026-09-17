# Phased Extraction — Wave 2: a deadline the whole composition can see, and a phase identity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two contract widenings the phased combinator cannot work without. `ExtractOptions` gains a `deadline`, so a combinator nested inside another knows how much of the step's budget is actually left instead of assuming it has all of it. `PhaseUnit` gains a phase identity and loses the closed `0 | 1 | 2` union that sized it for exactly one strategy.

**Architecture:** An optional absolute-epoch-millisecond member on the options bag every `Extractor` already accepts, forwarded untouched by delegating combinators and narrowed with `Math.min` by any combinator holding its own budget. The relay, which already owns `stepTimeoutMs`, becomes the thing that sets it — so the deadline is real end-to-end rather than only honoured between combinators that happen to agree.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/phased-extraction-design.md` (§4.5, §4.6)

## Global Constraints

- **`deadline` is an absolute epoch millisecond value, never a duration.** A duration cannot survive being passed down a composition — each layer would have to know how long the layers above it had already spent, which is the exact bug this member exists to fix. `Date.now()`-based, compared with `Date.now()`.
- **A delegating combinator forwards the options bag WHOLE.** Never destructure-and-rebuild. A combinator that needs to replace one member spreads the original and overrides that member. This is the single rule Task 2 exists to enforce, and it is already violated once today.
- **A combinator that holds its own budget narrows, never widens:** its effective deadline is `Math.min` of its own and any it inherited. A combinator can always finish sooner than its caller allows; it may never grant itself more time than it was given.
- `PhaseUnit.phaseId` is **required**, not optional. The only things that construct a `PhaseUnit` are emitters inside this repo, and an optional identity would be absent exactly where a progress consumer needs it most. Making it required means the compiler names every construction site that has not been updated.
- Purely additive for `ExtractOptions` (a new optional member); **breaking** for `PhaseUnit` (a new required member, and a widened `pass`). The changeset reflects that — see Task 6.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`. There is no per-package `test` script.

---

### Task 1: `ExtractOptions` gains `deadline`

**Files:**

- Modify: `packages/ribo-core/src/extractor.ts` (the `ExtractOptions` interface and its doc comment)
- Modify: `packages/ribo-core/src/extractor.test.ts` (or the closest existing suite covering the seam — check first)

**Interfaces:**

- Produces: `ExtractOptions.deadline?: number` — absolute epoch milliseconds after which the caller considers the extraction failed.

**Scope note:** this task only adds the member and documents it. Nothing reads it yet; Tasks 2-4 make it mean something. Splitting it out keeps the type change reviewable on its own.

- [ ] **Step 1: Write the documentation and the type**

  Add the member with a doc comment that states: it is absolute epoch milliseconds, not a duration, and why (a duration cannot survive composition); a delegating combinator forwards it untouched; a combinator with its own budget takes the `Math.min`; and it is advisory in the sense that honouring it is the callee's job — nothing enforces it structurally the way `signal` does. Cross-reference `signal` as the sibling member with the same forwarding discipline.

- [ ] **Step 2: Typecheck**

  Run `pnpm --filter @azx/ribo-core typecheck`. Expected: PASS — the member is optional, so nothing breaks.

- [ ] **Step 3: Commit**

---

### Task 2: Close the one forwarding hole, and pin every other forwarder

**Files:**

- Modify: `packages/ribo-core/src/grouped-extractor.ts:423`
- Modify: `packages/ribo-core/src/grouped-extractor.test.ts`
- Modify: `packages/ribo-core/src/arbitration.test.ts`, `packages/ribo-extractor-openai/src/gap-fill.test.ts`, `packages/ribo-extractor-openai/src/schema-retry.test.ts`, `packages/ribo-extractor-openai/src/per-group.test.ts` (one added assertion each)

**Interfaces:**

- Consumes: `ExtractOptions.deadline` from Task 1.

**The finding this task acts on.** A survey of every `.extract(` call site in `packages/*/src` found exactly one that rebuilds the options bag instead of forwarding it: `grouped-extractor.ts:423` passes `{ signal: effectiveSignal }`, dropping every other member. Six other sites (`extractor.ts:164`, `arbitration.ts:371`, `arbitration.ts:440`, `gap-fill.ts:506`, `per-group.ts:283`, `schema-retry.ts:184`) forward `options` whole and are already correct. The fix is one line; the tests exist so the next member added to the bag does not have to rediscover this.

- [ ] **Step 1: Write the failing test for `groupedExtractor`**

  In `grouped-extractor.test.ts`, drive a `groupedExtractor` whose group entries are `FakeExtractor`s, call `extract` with an options bag carrying both a `signal` and a `deadline`, and assert via `FakeExtractor.callOptions` that each entry received the **deadline** as well as a signal. (`FakeExtractor.callOptions` exists precisely so a dropped forward is visible — `extractor.ts` says so.) Assert the signal the entry sees is the combinator's combined signal, not the caller's raw one, so the fix cannot be "forward the caller's bag verbatim" — which would silently disable sibling abort, the trap `grouped-extractor.ts:360-364` already documents.

- [ ] **Step 2: Run it to verify it fails**

  Run: `pnpm vitest run packages/ribo-core/src/grouped-extractor.test.ts`
  Expected: FAIL — the entry receives `{ signal }` only, so `deadline` is `undefined`.

- [ ] **Step 3: Fix the forward**

  Spread the caller's options and override only the signal. One line.

- [ ] **Step 4: Run it to verify it passes**

  Expected: PASS.

- [ ] **Step 5: Pin the other five forwarders**

  Add one assertion to each of the named suites: with a `deadline` in the caller's options, the wrapped/candidate extractor receives it. These pass immediately — they are regression pins, not fixes, and Step 6's commit message should say so rather than implying they were broken.

- [ ] **Step 6: Run the affected suites and commit**

  Run `pnpm vitest run packages/ribo-core` and `pnpm vitest run packages/ribo-extractor-openai`. Expected: PASS.

---

### Task 3: `timeoutExtractor` narrows against an inherited deadline

**Files:**

- Modify: `packages/ribo-core/src/timeout-extractor.ts`
- Modify: `packages/ribo-core/src/timeout-extractor.test.ts`

**Interfaces:**

- Consumes: `ExtractOptions.deadline`.
- Produces: no signature change. `timeoutExtractor`'s effective budget becomes `Math.min(now + timeoutMs, inheritedDeadline)`, and it passes its effective deadline down to the inner extractor.

**Why it passes its own deadline down rather than forwarding what it received.** `timeoutExtractor` is the first combinator that holds a budget, so it is the first that must narrow. An inner extractor told the _caller's_ deadline would believe it has longer than this combinator will actually allow, and would size its own retries against a wall that will never be reached because the timer fires first.

- [ ] **Step 1: Write the failing tests**

  Assert: with no inherited deadline, behaviour is exactly as Wave 1 left it (run the existing suite unchanged — it must not need amending); with an inherited deadline **later** than `now + timeoutMs`, the inner extractor receives a deadline equal to this combinator's own, and the timer still governs; with an inherited deadline **earlier** than `now + timeoutMs`, the inner receives the inherited one and the combinator rejects at the inherited deadline rather than the later one; and with an inherited deadline **already in the past**, the combinator rejects immediately with `ExtractionTimeoutError` **without calling the inner extractor at all** (assert the stub recorded zero calls).

  Use the injected `scheduleTimer` and an injectable clock. If `timeout-extractor.ts` has no clock seam from Wave 1, add one (`now?: () => number`, defaulting to `Date.now`), matching how `compositeExtractor` and `hedged` inject theirs — do not use real time in tests.

- [ ] **Step 2: Run to verify they fail**

  Run: `pnpm vitest run packages/ribo-core/src/timeout-extractor.test.ts`
  Expected: FAIL — the combinator ignores `options.deadline` entirely.

- [ ] **Step 3: Implement**

  Compute the effective deadline, schedule the timer for the remaining interval, and pass the effective deadline down in the spread options bag alongside the combined signal.

- [ ] **Step 4: Run to verify they pass, then the whole core suite**

  Expected: PASS, with Wave 1's existing timeout tests unmodified.

- [ ] **Step 5: Commit**

---

### Task 4: The relay sets the deadline

**Files:**

- Modify: `packages/ribo-core/src/queue/relay.ts` (the extract step's invocation — find where it currently passes the step signal)
- Modify: `packages/ribo-core/src/queue/relay.browser.test.ts` or whichever relay suite covers the extract step (check which one exercises `sessionExtract`)

**Why this task matters more than it looks.** Without it the deadline is theoretical: combinators would honour each other, but nothing would ever set an initial value, so every `deadline` in the tree would be `undefined` and §4.5's whole mechanism would be inert in production while passing all its unit tests. The relay already owns `stepTimeoutMs` and already aborts a step signal on timeout; setting `deadline` alongside that signal is the one change that makes the member real.

- [ ] **Step 1: Write the failing test**

  Drive the relay through an extraction step with an injected `sessionExtract` that records the options it was handed, and assert it received a `deadline` approximately `stepTimeoutMs` in the future (assert a range, not an exact value — the relay's own clock advances between the two reads). Assert it is consistent with the step timeout the relay was configured with, by configuring a distinctly small one and checking the deadline moved with it.

- [ ] **Step 2: Run to verify it fails**

  Expected: FAIL — the step receives a signal but no deadline.

- [ ] **Step 3: Implement**

  Set `deadline` from the same clock and the same `stepTimeoutMs` the existing `withTimeout` call uses, so the two cannot drift apart. If the relay has an injectable clock, use it; if it uses `Date.now()` directly, match that rather than introducing a seam this task does not need.

- [ ] **Step 4: Run to verify it passes, then the whole relay suite**

  Expected: PASS, nothing else modified.

- [ ] **Step 5: Commit**

---

### Task 5: `PhaseUnit` gains `phaseId` and widens `pass`

**Files:**

- Modify: `packages/ribo-core/src/extraction-observer.ts:53-59`
- Modify: `packages/ribo-extractor-ondevice/src/three-phase-extractor.ts` (the `PhaseEmitter`/`newUnit` machinery around lines 75-128, and its three call sites)
- Modify: `packages/ribo-extractor-ondevice/src/three-phase-extractor.test.ts`

**Interfaces:**

- Produces: `PhaseUnit` with `pass: number` (widened from `0 | 1 | 2`) and a new required `phaseId: string`.

**Why `phaseId` and not `phase`.** `UnitBase` already declares `phase: "start" | "done" | "error"` as the lifecycle discriminator (`extraction-observer.ts:16`), and `PhaseUnit` is an **intersection** with it — so declaring `phase: string` here would not widen anything, it would narrow to the lifecycle union, and emitting `phase: "presence"` would fail with an error that names neither the cause nor the collision. The collision is silent, which is why the design records it and why this task must not "simplify" the name.

**What `pass` means now.** Position in the phase list. It previously meant the strategy's own pass index; for three-phase those coincide, so no existing assertion changes meaning. For a four-phase list they would not, and position is the only meaning a general combinator can offer.

- [ ] **Step 1: Write the failing tests**

  In `three-phase-extractor.test.ts`, assert that the events for each pass carry `phaseId` of `"presence"`, `"span"` and `"classify"` respectively, alongside the `pass` values the existing assertions already check. Do not change any existing assertion — `pass === 0` and friends must keep passing, and if one breaks, that is a real regression, not a test to update.

- [ ] **Step 2: Run to verify they fail**

  Run: `pnpm vitest run packages/ribo-extractor-ondevice/src/three-phase-extractor.test.ts`
  Expected: FAIL — `phaseId` is absent from every event, and the type does not declare it.

- [ ] **Step 3: Widen the type**

  In `extraction-observer.ts`, change `pass` to `number` and add the required `phaseId: string` with a doc comment saying what it is and, briefly, why it is not called `phase`. Run `pnpm --filter @azx/ribo-core typecheck`, then `pnpm --filter @azx/ribo-extractor-ondevice typecheck`. Expected: the on-device package now **fails** to typecheck, naming every construction site missing `phaseId`. That failure is the point of making the member required.

- [ ] **Step 4: Emit the identity**

  Thread a phase identity through `three-phase-extractor.ts`'s emitter: `newUnit` takes it alongside `pass`, and the three call sites supply `"presence"`, `"span"` and `"classify"`. The wrapped-schema fallback path shares the classify unit and therefore its identity — it is the same phase, and Wave 6 is what splits it out.

- [ ] **Step 5: Run to verify they pass**

  Run the on-device suite. Expected: PASS, with every pre-existing assertion untouched.

- [ ] **Step 6: Commit**

---

### Task 6: Changeset and the full gate

**Files:**

- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Add a changeset**

  `@azx/ribo-core` is **major** and `@azx/ribo-extractor-ondevice` is **major**: `PhaseUnit` gains a required member and widens another, which breaks any code constructing one. `ExtractOptions.deadline` on its own would only be minor, but a changeset declares the largest impact in the change, and the whole phased-extraction program is a major bump regardless (design §7) — so declaring it here is honest rather than premature.

  The summary should say what a consumer gains and what breaks: extraction now carries a deadline down a composition so a nested combinator sizes its work against the time actually remaining; progress events name their phase; `PhaseUnit` constructions need updating.

- [ ] **Step 2: Run the full gate**

  Run `./check.sh`, then `pnpm docs:build` and `pnpm changeset status --since=origin/main`. Expected: PASS.

  Note: bare `pnpm changeset status` fails on a pre-existing mixed changeset unrelated to this work (observed at baseline in Wave 1). Use `--since=origin/main`, and if it fails, verify the same failure exists at this wave's base commit before treating it as yours.

- [ ] **Step 3: Commit**

---

## Out of scope (confirmed against the design doc)

- `phasedExtractor` itself and everything phase-shaped — Wave 3.
- Removing `GapFillUnit`, `InventoryUnit` or `InstanceUnit` from the `ExtractionUnit` union. They stay until their strategies are ported; Wave 6 removes them.
- Retrofitting `groupedExtractor` or `instance-fill.ts` onto Wave 1's `retryExtractor`. Still deliberately carried; design §8 names it.
- Making any combinator other than `timeoutExtractor` narrow the deadline. None of the others hold a budget yet. `groupedExtractor` derives a retry budget from `stepTimeoutMs` but does not hold a wall-clock deadline, and changing that is Wave 3's problem, where the phased combinator needs it.
- Enforcing the deadline structurally. Nothing checks that a callee honours it; that is the same advisory contract `signal` has.

## Notes for the reviewer

Two things most worth adversarial attention. First, Task 4: whether the relay's deadline and its `withTimeout` can drift apart, and whether a deadline set from a different clock reading than the timeout would ever let a step believe it has time after the relay has already aborted it. Second, Task 3's "already in the past" case: whether rejecting without calling the inner extractor is right, or whether a caller who passed a stale deadline would rather have one attempt made.
