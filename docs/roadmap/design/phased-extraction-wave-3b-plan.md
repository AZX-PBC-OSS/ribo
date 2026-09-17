# Phased Extraction — Wave 3b: the engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `phasedExtractor` — the combinator that runs a list of phases. It owns everything that is not "what to ask": scheduling, retry, abort, the running deadline, the unit stream, usage accumulation and the closing trust-boundary parse.

**Architecture:** Wave 3a landed the vocabulary; this wave runs it. Phases execute in order; items within a phase fan out through the existing `mapWithPool`. The retry policy that `retryExtractor` already implements is first extracted into a shared helper so this engine composes it rather than growing a fifth copy of the loop. The deadline is sliced per phase at the boundary where that phase's item count is finally known.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/phased-extraction-design.md` (§4.1, §4.4, §4.5, §4.6)

## Global Constraints

- **No sixth copy of the retry loop.** Task 1 exists because `retryExtractor` wraps an `Extractor` and this engine retries _items_, whose `run` is not an `Extractor` — so the engine cannot compose it directly, and would otherwise reimplement it. Extract the policy, then use it in both places.
- **`merge` owns every write to the draft.** `run` receives the draft to read; items within a phase run concurrently, so a mutating `run` races its siblings. `PhaseDraft`'s members are `readonly`, which enforces the type-level half.
- **Consumption of a `Phase` is Rank-2.** `I` and `C` are bound but anonymous inside `phase.with(def => …)`, so all of a phase's per-item work must happen inside one callback. Do not try to hoist a `def` out; it will come back as `PhaseDef<…, unknown, unknown>` and nothing will typecheck.
- **Cancellation always propagates, whatever the failure policy.** A skip-policy phase must never convert a cancellation into a skipped item — that resolves the run with all-null fields, indistinguishable from a document that said nothing. Use `isCancellation` from `cancellation.ts`.
- **`isTransientFailure` is not changed.** A cancelled extraction _step_ stays retryable at the relay layer; only the in-run loop stops. Wave 1 records why.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`.
- Every new file carries an `@file` header in the style of its neighbours.

---

### Task 1: Extract the retry policy into `retryAsync`

**Files:**

- Create: `packages/ribo-core/src/retry-async.ts`
- Create: `packages/ribo-core/src/retry-async.test.ts`
- Modify: `packages/ribo-core/src/retry-extractor.ts` (becomes a thin wrapper), `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `retryAsync<T>(work: (attempt: number) => Promise<T>, options: RetryAsyncOptions): Promise<T>`. `RetryAsyncOptions` carries `maxRetries`, `delay`, the `BackoffOptions` members, an optional `signal`, and an optional `onAttempt?: (attempt: number) => void` fired immediately before each attempt starts.
- Consumes: `isCancellation`, `isTransientFailure`, `TerminalQueueError`, `fullJitterDelay`.

**Why `onAttempt` exists.** The engine must emit a `PhaseUnit` `start` event per attempt, and the attempt number is the only way a retry is observable at all. Without this hook the engine would have to own the loop to own the events, which is the duplication this task removes.

**The policy, unchanged from `retryExtractor`.** Before each attempt: if the signal has already aborted, throw a `CancellationError` without starting or counting the attempt. After a failure: rethrow a `TerminalQueueError` untouched; rethrow a cancellation untouched; rethrow anything `isTransientFailure` rejects; otherwise retry until `maxRetries` is exhausted, then rethrow the last error.

- [ ] **Step 1: Write the failing tests**

  Port the behavioural assertions from `retry-extractor.test.ts` down to this level, driving a scripted `work` function rather than an extractor: first-attempt success calls once; transient-then-success calls twice and returns the second value; exhaustion rethrows the **last** error; `TerminalQueueError`, a cancellation, and a 400-status error each rethrow after one call; a `SchemaParseError` is retried; `delay` is called once per retry and never before the first attempt; an already-aborted signal throws `CancellationError` with zero calls; and `onAttempt` fires once per started attempt with the attempt index, and **not** for an attempt the pre-attempt abort check prevented.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, module does not exist.

- [ ] **Step 3: Implement `retryAsync`**

- [ ] **Step 4: Rewrite `retryExtractor` over it**

  `retryExtractor` becomes a call to `retryAsync` wrapping `extractor.extract(transcript, callerOptions)`. Its own test suite must pass **unmodified** — that is the proof the extraction preserved behaviour. If any assertion needs changing, stop and report rather than amending it.

  Keep `retryExtractor`'s file header's usage-undercount note; it is still true and still the thing a reader needs.

- [ ] **Step 5: Run both suites, export, typecheck** — Expected: PASS, `retry-extractor.test.ts` unmodified.

- [ ] **Step 6: Commit**

---

### Task 2: The engine skeleton — phases in order, items in a pool, one parse at the end

**Files:**

- Create: `packages/ribo-core/src/phased-extractor.ts`
- Create: `packages/ribo-core/src/phased-extractor.test.ts`
- Modify: `packages/ribo-core/src/index.ts`, `packages/ribo-core/src/index.test.ts`

**Interfaces:**

- Produces: `phasedExtractor<V, P>(options: PhasedExtractorOptions<V, P>): Extractor<Enveloped<V, P>>`. Options: `target`, `phases`, optional `normalize`, `concurrency` (run-level default a phase inherits when it declares none — **4**, matching `groupedExtractor`), `maxRetries`, `stepTimeoutMs`, `perCallCeilingMs`, `delay`, plus `BackoffOptions`, `ExtractionObserver<PhaseUnit>` and `RetryBudgetObserver`.

**This task deliberately omits retry, the deadline and the failure policy.** They land in Tasks 3 and 4. Build the spine first: validate at construction, run phases in order, fan each phase's items out through `mapWithPool`, thread the draft through `merge`, then normalize once and parse once.

**Shape notes.** Call `validatePhases` at construction, before returning the extractor — a mis-wired list must fail before any call. Each phase's work happens inside one `phase.with(def => …)` callback (the Rank-2 constraint). `plan` is synchronous; call it with the draft as the previous `merge` returned it. Fan out with `mapWithPool(items, limit, fn, abort)`, where `limit` is the phase's `concurrency` or the run default. Build a `PhaseItemOutcome` per item and hand the whole batch to `merge`.

**The closing sequence, in this order:** run `normalize` on the merged fields if supplied, then parse against `target.extractionSchema` (the trust boundary), then assemble the `ExtractionResult` — `fields` from the parse, `usage` summed from every `PhaseOutput`, `raw` from the draft if present, and `statedEmptyGroups` **omitted entirely when empty** rather than emitted as `{}`, because `extractor.ts` documents its absence as meaning "this extractor ran no roster pass".

- [ ] **Step 1: Write the failing tests**

  With hand-written phases over a tiny `V` and no model: two phases run in order and the second's `plan` sees what the first's `merge` wrote; a phase whose `plan` returns an empty array makes no call and emits no event; items within a phase run concurrently up to the limit (assert with a phase whose `run` records concurrent entries against a counter); the merged result is parsed against the schema and a phase that produces an invalid shape rejects with a `SchemaParseError`; `normalize` runs **once**, after the merge and before the parse; `usage.calls` is the sum across every `PhaseOutput` that reported one; `statedEmptyGroups` is absent from the result when no phase set one and present when one did; `raw` carries through; and a mis-wired phase list throws at construction, before `extract` is ever called.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, module does not exist.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass, export, typecheck**

- [ ] **Step 5: Commit**

---

### Task 3: Per-item retry, the two failure policies, and cancellation

**Files:**

- Modify: `packages/ribo-core/src/phased-extractor.ts`, `packages/ribo-core/src/phased-extractor.test.ts`

**Interfaces:**

- Consumes: `retryAsync` from Task 1.

**The two policies, and why they are one mechanism.** An **abort**-policy phase lets `mapWithPool` reject as it does today — siblings aborted, run failed, `map-with-pool.ts` untouched. A **skip**-policy phase catches inside the worker function so the pool never sees a rejection, and the failed item reaches `merge` as a `PhaseItemOutcome` on the `"error"` arm for the phase to interpret. That is why `merge` takes outcomes rather than bare contributions. Default is `"abort"`, matching `groupedExtractor`, which is the safer default: a strategy that wants to swallow says so.

**Interpretation is the phase's job, not the engine's.** The three-phase port will null a group's leaves on a presence failure but keep the span on a classify failure — two different readings of "this item failed" inside one strategy. The engine hands `merge` the outcomes and does not decide.

**Cancellation is the exception to everything above.** Before starting each item, and after any item fails, consult `isCancellation` with the caller's signal. A cancellation rejects the whole run regardless of policy — a skip-policy phase converting one into a skipped item would resolve with all-null fields, which is the bug class §2.4 of the design records as already present in the tree.

**Per-phase `maxRetries`.** A phase may declare its own, including **0**. Two ports need zero: gap-fill's follow-up has no retry loop today and must not gain one, and the inventory pass is deliberately one-shot. A phase that declares none inherits the run-level value.

- [ ] **Step 1: Write the failing tests**

  A transient item failure is retried and the run succeeds; an item failing past its budget under `"abort"` fails the run and aborts in-flight siblings (assert a sibling observed an aborted signal, and that no further item started); the same failure under `"skip"` reaches `merge` on the `"error"` arm and the run completes; a phase declaring `maxRetries: 0` makes exactly one attempt; a cancellation mid-phase rejects the run under **both** policies — pinned separately for a caller-aborted signal and for a `CancellationError` thrown by `run`; and the pre-attempt abort check does not count an attempt that never started.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL for each named reason.

- [ ] **Step 3: Implement** — reuse `retryAsync`; do not write a loop.

- [ ] **Step 4: Run to verify they pass, run the whole core suite**

- [ ] **Step 5: Commit**

---

### Task 4: The running deadline and the per-phase retry budget

**Files:**

- Modify: `packages/ribo-core/src/phased-extractor.ts`, `packages/ribo-core/src/phased-extractor.test.ts`

**The problem this solves.** `deriveRetryBudget` sizes retries from a known call count, and a phased run does not have one — the classify phase's item count depends on what the span phase produced. So the budget is derived per phase, at the boundary where `plan` has just returned and that phase's count is finally known, against that phase's share of the **remaining** time.

**The rules.** Record an effective deadline at the start: `Math.min` of `now + stepTimeoutMs` and any inherited `options.deadline`. At each phase boundary, the phase's share is `remaining / phasesLeft`; derive its budget with the existing `deriveRetryBudget` against that share and the phase's item count. A phase that finishes early leaves more for the rest. Pass the effective deadline down to each item's `run` through the phase context.

**`onRetryBudget` keeps its existing meaning: it fires when a budget was _reduced_, not on every derivation.** Firing unconditionally would turn a signal into a metronome. So a phased run emits one event per _reduced_ phase — commonly zero.

**A deadline-caused zero is not a configuration error.** Today `derived === 0` with `requested > 0` means the caller asked for retries that cannot fit any run of this shape, which is why `requireRetryBudget` throws `TerminalQueueError` and kills the session. Under a running deadline the same zero can come from elapsed wall-clock at a late phase boundary, which is transient. Distinguish them: a budget that would be zero against the **full** step timeout is the configuration error and still throws; a budget zero only against the **remaining** time runs with no retries and reports it. Conflating them kills sessions on a timing blip.

- [ ] **Step 1: Write the failing tests**

  With an injected clock: each phase's derived budget is computed from the time remaining at its own boundary, not at construction — a run whose first phase consumes most of the deadline yields a smaller budget for the second, and the emitted events show it; `onRetryBudget` fires only for phases whose budget was reduced; an inherited `options.deadline` earlier than `now + stepTimeoutMs` wins; each item's `run` receives the effective deadline in its context; a budget that is zero against the full step timeout throws `TerminalQueueError` when `requireRetryBudget` is set, and a budget zero only against the remaining time does **not** throw.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass, run the whole core suite**

- [ ] **Step 5: Commit**

---

### Task 5: The unit stream, and verifying a phase produced what it declared

**Files:**

- Modify: `packages/ribo-core/src/phased-extractor.ts`, `packages/ribo-core/src/phased-extractor.test.ts`

**What the engine emits.** One `PhaseUnit` per item attempt: `phaseId` from the phase's metadata, `pass` from its position in the list, `attempt` from `retryAsync`'s `onAttempt`, `key` and `leaf` from the phase's `describeItem` (defaulting to `key: ""` when the phase declares none — the same convention `groupedExtractor`'s `GroupMap` uses for a whole-schema entry), `usage` on `done` from the item's `PhaseOutput`, and `error` on `error`. `id` comes from `nextUnitId()`.

**`attempt` means combinator retry attempts of one phase item.** A call a `run` makes internally is not an attempt, because the engine did not make it and cannot bound it. The tree currently disagrees with itself on this — `grouped-extractor.ts` counts outer-loop iterations, `three-phase-extractor.ts` counts inner-loop — and the combinator-owned stream settles it.

**The `produces` verification.** After each phase's `merge`, check every key the phase declared in `produces` is now present in `draft.notes.keys`. A phase that declares a key and writes it only conditionally is a silent liar, and a roster-driven contribution is exactly that shape. Throw naming the phase and the key. This is the runtime half of Wave 3a's construction-time check, and it is what makes `requires`/`produces` an actual guarantee rather than a declaration.

- [ ] **Step 1: Write the failing tests**

  Events carry `phaseId` and the positional `pass`; a four-phase list reports `pass: 3`, which was impossible before Wave 2 widened the type; `attempt` increments per engine retry and does not move for calls a `run` makes internally (drive a `run` that calls a fake twice); `key` and `leaf` come from `describeItem`, and default to `""` when the phase declares none; an aborted sibling emits no `start` event for an attempt that never began; and a phase declaring `produces: ["roster"]` whose `merge` does not write it throws at that phase's boundary, naming both.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run to verify they pass, run the whole core suite**

- [ ] **Step 5: Commit**

---

### Task 6: Changeset and the full gate

**Files:**

- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Add a changeset**

  `@azx/ribo-core` is **minor** — additive; the program's `major` is already declared by Wave 2. The summary should say what a consumer gains: a combinator that runs a list of phases, owning scheduling, retry, cancellation, the deadline and the progress stream, so a multi-pass strategy is a list of narrowing steps rather than a bespoke loop.

- [ ] **Step 2: Run the full gate**

  `./check.sh`, then `pnpm docs:build` and `pnpm changeset status --since=origin/main`. Expected: PASS. Bare `pnpm changeset status` fails on a pre-existing mixed changeset unrelated to this work; if `--since=origin/main` also fails, verify the same failure at this wave's base commit before treating it as yours.

- [ ] **Step 3: Commit**

---

## Out of scope (confirmed against the design doc)

- Porting `gapFillExtractor`, `scopedInstanceExtractor` or `threePhaseExtractor` — Waves 4, 5, 6. This wave's tests use hand-written phases only.
- Removing `GapFillUnit`, `InventoryUnit` or `InstanceUnit` from the `ExtractionUnit` union — Wave 6.
- Retrofitting `groupedExtractor` or `instance-fill.ts` onto `retryAsync`. Task 1 makes it possible and the design's §8 names the duplication as knowingly carried; doing it here would widen a wave that is already the largest.
- Per-phase weights for the deadline slice. Equal shares assume equal cost and the design names that as a known weakness with `onRetryBudget` as the evidence channel — the bar for weights is evidence, not intuition.
- Any phase definition that assembles messages. Those need a transport and belong in `ribo-extractor-openai`.

## Notes for the reviewer

Three things most worth adversarial attention. First, Task 1: whether `retryAsync` genuinely preserves `retryExtractor`'s behaviour, given its suite must pass unmodified — and whether `onAttempt` fires in exactly the places the engine needs to emit honest events. Second, Task 4's two-kinds-of-zero rule: whether the distinction between a configuration zero and a deadline zero is computable at the phase boundary with the information the engine actually has. Third, Task 3's skip policy: whether catching inside the pool's worker genuinely leaves `mapWithPool`'s sibling-abort behaviour intact for the abort-policy phases in the same run.
