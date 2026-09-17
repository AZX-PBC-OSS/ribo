# Phased Extraction — Wave 1: retry, timeout and a cancellation marker core can see

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three additive pieces in `@azx/ribo-core` that the phased combinator needs and that are independently useful today: a cancellation marker core can recognise without importing a transport's error type, a `retryExtractor` that wraps any `Extractor` with the attempt loop this repo currently hand-rolls in six places, and a `timeoutExtractor` that bounds one with a deadline.

**Architecture:** A unique-symbol brand plus a predicate, so an error thrown in `ribo-extractor-openai` can be recognised as a cancellation by a combinator in `ribo-core` with no dependency edge in the wrong direction. Two thin combinators over the existing `Extractor` seam, following `fallbackExtractor`/`raceExtractor`'s positional shape and reusing `fullJitterDelay`, `isTransientFailure` and `TerminalQueueError` rather than inventing retry semantics.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/phased-extraction-design.md` (§4.2, §4.4)

## Global Constraints

- **Purely additive.** No existing behaviour changes in this wave. Every existing test passes unmodified; if one does not, stop and report rather than amending it.
- **`isTransientFailure` is NOT changed.** The design doc's §4.4 says a cancellation should make it return `false`; that is wrong and the design has been corrected. `extraction-common.ts:246` ("`aborted` is deliberately left retryable") and `docs/guide/extraction.md:46` record a deliberate decision that a cancelled extraction **step** stays retryable by the relay, because the abort is caller-initiated on a deadline and a later attempt may succeed. The two layers are different: the relay may retry the step later; the in-run retry loop must stop immediately. This wave implements the second and leaves the first alone.
- **No new dependency edges.** `ribo-core` must not import from any `ribo-extractor-*` package. `ribo-extractor-openai` already depends on `ribo-core`, so the brand travels in that direction only.
- Tests run from the repo root via Vitest's own path filtering, not a per-package `test` script: `pnpm vitest run packages/<dir>/src/<file>.test.ts`. `pnpm --filter @azx/<pkg> typecheck` is correct as written.
- Follow the house combinator shape: an `F`-only generic takes its extractor positionally with an options object second, matching `fallbackExtractor` and `raceExtractor`. Do not use an options-bag-only signature; that shape is reserved for the `V`/`P`-generic combinators.
- Every new file carries an `@file` header comment in the style of its neighbours in `packages/ribo-core/src/` — what it is, why it exists here rather than elsewhere, and what it deliberately does not do.

---

### Task 1: A cancellation marker `ribo-core` can recognise

**Files:**

- Create: `packages/ribo-core/src/cancellation.ts`
- Create: `packages/ribo-core/src/cancellation.test.ts`
- Modify: `packages/ribo-core/src/index.ts` (add the exports to the barrel, in a new commented block matching the file's existing grouping style)

**Interfaces:**

- Produces: `CANCELLATION` — a `unique symbol` any error may carry as a truthy own property to declare itself a cancellation. `CancellationError` — an `Error` subclass carrying it, for core's own throws. `isCancellation(error: unknown, signal?: AbortSignal): boolean` — the predicate every later task uses.

**Why a symbol brand and not a class.** The discriminator has to work on an error constructed in another package. `ChatError` (`packages/ribo-extractor-openai/src/chat-client.ts`) already extends `Error` and cannot also extend a core class, and core cannot import it. A branded property is the only mechanism that lets a foreign error opt in without either package importing the other's type. This is the same problem `three-phase-extractor.ts:718-729`'s `isCancellation` solves locally by importing `ChatError` directly — which is exactly what a core combinator cannot do.

- [ ] **Step 1: Write the failing tests**

  In `cancellation.test.ts`, assert that: a `new CancellationError("...")` satisfies `isCancellation`; a plain `new Error("...")` does not; an object carrying `{ [CANCELLATION]: true }` does (the foreign-error case — construct a plain `Error` and assign the branded property, which is what `ChatError` will do in Task 4); a `DOMException` with name `"AbortError"` does (the native case a `fetch` abort produces); `isCancellation(new Error("x"), signal)` is `true` when `signal.aborted` is true and `false` when it is not; and `isCancellation(undefined)` and `isCancellation(null)` are both `false` rather than throwing. Also assert `CancellationError` keeps a useful `message` and that its `name` is `"CancellationError"`.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `pnpm vitest run packages/ribo-core/src/cancellation.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the module**

  Export the symbol, the class and the predicate. The predicate checks three things in order: the passed signal's `aborted` flag when a signal was given; the brand as an own or inherited property on a non-null object; and a `DOMException` whose `name` is `"AbortError"`. Guard the property read behind a `typeof error === "object" && error !== null` check so a string or `undefined` returns `false` instead of throwing — the predicate is called from catch blocks and must never itself throw. Declare the brand property as optional on an exported interface so a TypeScript author can set it without a cast.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `pnpm vitest run packages/ribo-core/src/cancellation.test.ts`
  Expected: PASS.

- [ ] **Step 5: Export from the barrel and typecheck**

  Add the three exports to `packages/ribo-core/src/index.ts`, following the file's existing convention of a short comment block per concept group. Run `pnpm --filter @azx/ribo-core typecheck`. Expected: PASS.

- [ ] **Step 6: Commit**

  Commit the new module, its test and the barrel change together.

---

### Task 2: `retryExtractor`

**Files:**

- Create: `packages/ribo-core/src/retry-extractor.ts`
- Create: `packages/ribo-core/src/retry-extractor.test.ts`
- Modify: `packages/ribo-core/src/index.ts`

**Interfaces:**

- Consumes: `isCancellation` from Task 1.
- Produces: `retryExtractor<F>(extractor: Extractor<F>, options?: RetryExtractorOptions): Extractor<F>`. `RetryExtractorOptions` carries `maxRetries?: number` (default 2, matching `GroupedExtractorOptions`), `delay?: (ms: number) => Promise<void>` and the existing `BackoffOptions` members. The `delay` member takes the **already-computed** `fullJitterDelay` result in milliseconds, exactly as `GroupedExtractorOptions.delay` does — a caller that wants no backoff passes a function that ignores its argument and resolves immediately, which is how the on-device preset will disable backoff in Wave 6.

**The retry rules, in the order they are checked.** Before each attempt, if the caller's signal has already aborted, throw without starting the attempt and without counting it — the invariant `three-phase-extractor.ts:377-386` repeats at four sites and explains: an attempt that never ran must not appear in the attempt count. After a failure: a `TerminalQueueError` is rethrown untouched; a cancellation (per Task 1's predicate, consulted with the caller's signal) is rethrown untouched; a failure for which `isTransientFailure` returns `false` is rethrown untouched; anything else is retried until `maxRetries` is exhausted, after which the last error is rethrown. A `SchemaParseError` is retried, because `isTransientFailure` already returns `true` for it and the design keeps that.

- [ ] **Step 1: Write the failing tests**

  In `retry-extractor.test.ts`, drive a stub `Extractor` whose `extract` is backed by a scripted queue of outcomes, with an injected `delay` that records the milliseconds it was asked to wait and resolves immediately. Assert: a first-attempt success calls the inner extractor once and returns its result unchanged, including `usage` and `raw` by identity; a transient failure followed by a success calls twice and returns the second result; exhausting `maxRetries` rejects with the **last** error, not the first; a `TerminalQueueError` rejects immediately after one call; a `CancellationError` rejects immediately after one call; a 400-status error rejects immediately after one call (`isTransientFailure` is false); a `SchemaParseError` **is** retried; the `delay` function is called once per retry and never before the first attempt; the recorded delays are non-decreasing in expectation given a stubbed random (assert simply that `delay` was called with a number, not an exact value, since `fullJitterDelay` is randomised); and an already-aborted signal passed in `options` rejects without calling the inner extractor at all. Finally, assert the caller's `ExtractOptions` — signal included — is forwarded to the inner extractor on every attempt, using `FakeExtractor`'s `callOptions` recorder, which exists precisely so a dropped forward is visible.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `pnpm vitest run packages/ribo-core/src/retry-extractor.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the combinator**

  Return an object with a single `extract` that loops attempts, applying the rules above. Reuse `fullJitterDelay` from `queue/backoff.js` for the wait computation and `isTransientFailure` from the same module for the classification; do not reimplement either. Default `delay` to a `setTimeout`-backed sleep, matching `grouped-extractor.ts`'s default.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `pnpm vitest run packages/ribo-core/src/retry-extractor.test.ts`
  Expected: PASS.

- [ ] **Step 5: Export from the barrel, typecheck and run the whole core suite**

  Run `pnpm --filter @azx/ribo-core typecheck`, then `pnpm vitest run packages/ribo-core`. Expected: PASS, with no existing test modified.

- [ ] **Step 6: Commit**

---

### Task 3: `timeoutExtractor`

**Files:**

- Create: `packages/ribo-core/src/timeout-extractor.ts`
- Create: `packages/ribo-core/src/timeout-extractor.test.ts`
- Modify: `packages/ribo-core/src/index.ts`

**Interfaces:**

- Produces: `timeoutExtractor<F>(extractor: Extractor<F>, options: TimeoutExtractorOptions): Extractor<F>`. `TimeoutExtractorOptions` carries `timeoutMs: number` (required — a timeout combinator with a default timeout is a trap) and `scheduleTimer?: ScheduleTimer`, reusing the injectable timer type already exported from `connectivity.ts` and used by `hedged.ts`, so tests drive time without sleeping. Also produces `ExtractionTimeoutError`.

**The decision this task encodes, which is not obvious.** When the timer fires, the inner extractor is aborted — and the inner extractor will typically reject with its own cancellation-branded error as a result. `timeoutExtractor` must **replace** that with an `ExtractionTimeoutError` when its own timer is what fired, rather than letting the inner cancellation propagate. Two reasons. First, they are different events: a caller cancelled versus a deadline elapsed, and a consumer that cannot distinguish them cannot report either honestly. Second, `ExtractionTimeoutError` is deliberately **not** cancellation-branded, so `isTransientFailure` treats it as transient (the unrecognised-error default) and an **outer** `retryExtractor` will retry it — which is the useful composition, a per-attempt deadline with retries around it. A cancellation-branded timeout would make that composition silently do nothing.

When the caller's own signal aborts, the inner rejection passes through untouched: that is a real cancellation and must stay one.

- [ ] **Step 1: Write the failing tests**

  In `timeout-extractor.test.ts`, with an injected `scheduleTimer` that captures the callback rather than scheduling it, assert: an inner extractor that resolves before the timer fires returns its result unchanged and the timer is cleared (assert the captured clear function was called); firing the timer rejects with `ExtractionTimeoutError`, whose message names the elapsed budget; when the timer fires, the signal handed to the inner extractor is aborted (capture it via `FakeExtractor.callOptions`); an inner extractor that rejects with its own cancellation-branded error **after** the timer fired still surfaces as `ExtractionTimeoutError`, not as the inner error; `isCancellation(new ExtractionTimeoutError(...))` is `false`; and when the **caller's** signal aborts, the inner cancellation propagates unchanged rather than being converted to a timeout. Also assert that a caller-supplied signal and the timeout's own signal are combined, so the inner extractor sees a signal that aborts on either — drive both directions.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `pnpm vitest run packages/ribo-core/src/timeout-extractor.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the combinator**

  Combine the caller's signal with the timeout controller's using `AbortSignal.any`, never `??` — `grouped-extractor.ts` documents that exact trap, where a caller-supplied signal silently replaces the combinator's own and disables it. Track whether the timer fired in a closure flag so the catch block can distinguish a timeout from a caller cancellation. Always clear the timer, on the success path and both failure paths.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `pnpm vitest run packages/ribo-core/src/timeout-extractor.test.ts`
  Expected: PASS.

- [ ] **Step 5: Export from the barrel, typecheck and run the whole core suite**

  Run `pnpm --filter @azx/ribo-core typecheck`, then `pnpm vitest run packages/ribo-core`. Expected: PASS.

- [ ] **Step 6: Commit**

---

### Task 4: `ChatError.aborted` carries the brand

**Files:**

- Modify: `packages/ribo-extractor-openai/src/chat-client.ts` (the `ChatError` class and its `aborted` static factory)
- Modify: `packages/ribo-extractor-openai/src/chat-client.test.ts` (or whichever existing test file covers `ChatError` — check first; if none exists, add the assertions to the most closely related existing suite rather than creating a new file for two assertions)

**Interfaces:**

- Consumes: `CANCELLATION` from Task 1.

**Why this task is in this wave.** Without it the marker is inert: nothing in the tree produces a branded error, so Task 2's cancellation rule is unreachable in production and only the synthetic test exercises it. This is the one change in the wave that touches a shipped code path, and it is additive — a new property on an error that already means what the brand says.

- [ ] **Step 1: Write the failing tests**

  Assert that `ChatError.aborted("...")` satisfies `ribo-core`'s `isCancellation`, and that a `ChatError` of any **other** kind — pick `"transport"` and `"unsupported"` — does not. The second assertion is the one that matters: branding the class rather than the factory would make every transport failure look like a cancellation and silently disable retries everywhere.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `pnpm vitest run packages/ribo-extractor-openai/src/chat-client.test.ts`
  Expected: FAIL — `ChatError.aborted` carries no brand.

- [ ] **Step 3: Set the brand in the `aborted` factory only**

  Set the branded property in the `aborted` static factory, not in the constructor and not on the prototype. Import the symbol from `@azx/ribo-core` — the dependency already exists in this package's `package.json`.

- [ ] **Step 4: Run the tests to verify they pass**

  Run: `pnpm vitest run packages/ribo-extractor-openai/src/chat-client.test.ts`
  Expected: PASS.

- [ ] **Step 5: Verify nothing else moved**

  Run `pnpm vitest run packages/ribo-extractor-openai` and `pnpm vitest run packages/ribo-extractor-ondevice`. Expected: PASS, unmodified. The on-device package's own `isCancellation` (`three-phase-extractor.ts:718-729`) still works by its own `ChatError` check and is not touched in this wave — Wave 6 deletes it when that strategy is ported.

- [ ] **Step 6: Commit**

---

### Task 5: Changeset and the full gate

**Files:**

- Create: `.changeset/<generated-name>.md`

- [ ] **Step 1: Add a changeset**

  Run `pnpm changeset` (or write the file by hand in the same shape as the existing entries in `.changeset/`). Both `@azx/ribo-core` and `@azx/ribo-extractor-openai` change; both are **minor**, because this wave is purely additive. The eventual `major` for the whole phased-extraction program lands in Wave 7 — do not claim it here.

  The summary should say what a consumer gains, not what the files are: two new combinators over the `Extractor` seam, and a cancellation marker that lets a combinator distinguish "the caller stopped this" from "this failed" without depending on a transport package.

- [ ] **Step 2: Run the full gate**

  Run `./check.sh`. Expected: PASS on every stage.

- [ ] **Step 3: Run the wider CI bar**

  `./check.sh` is not the whole CI bar. Also run `pnpm docs:build` and `pnpm changeset status`. Expected: PASS. (`pack-and-consume` matters when a publishable package is added or renamed, which this wave does not do.)

- [ ] **Step 4: Commit**

---

## Out of scope (confirmed against the design doc)

- `ExtractOptions.deadline` — Wave 2. `timeoutExtractor` here takes an explicit `timeoutMs` and does not read or write a deadline from the options bag.
- Any change to `isTransientFailure`, to the relay's step-retry behaviour, or to the documented decision that a cancelled extraction step is retryable. See Global Constraints.
- `PhaseUnit`, the `ExtractionUnit` union, and anything phase-shaped — Waves 2 and 3.
- Retrofitting `groupedExtractor` or `instance-fill.ts` onto `retryExtractor`. Both keep their inline loops until their own waves; the design's §8 names the duplication as knowingly carried in the interim.
- Deleting `three-phase-extractor.ts`'s local `isCancellation`. Wave 6.

## Notes for the reviewer

The two things most worth adversarial attention: whether Task 1's predicate can be fooled or made to throw by a hostile input reaching it from a catch block, and whether Task 3's timer-fired-versus-caller-aborted discrimination actually holds under a race where both happen in the same tick.
