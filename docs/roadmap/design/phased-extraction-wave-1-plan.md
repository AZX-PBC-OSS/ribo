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

  In `cancellation.test.ts`, assert that: a `new CancellationError("...")` satisfies `isCancellation`; a plain `new Error("...")` does not; an object carrying a truthy `[CANCELLATION]` **own** property does (the foreign-error case — construct a plain `Error` and assign the branded property, which is what `ChatError` will do in Task 4); an object carrying `[CANCELLATION]: undefined` as an own property does **not** (this is the case Task 4's TypeScript mechanics can accidentally create on every instance — see that task); a `DOMException` with name `"AbortError"` does; `isCancellation(new Error("x"), signal)` is `true` when `signal.aborted` is true and `false` when it is not; and `isCancellation(undefined)`, `isCancellation(null)` and `isCancellation("a string")` are all `false` rather than throwing. Assert `CancellationError`'s `name` is `"CancellationError"` and its `message` survives.

  **Pin the never-throws contract with hostile inputs, not prose.** Add: a `Proxy` whose `get` trap throws; a `Proxy` whose `has` and `getOwnPropertyDescriptor` traps throw; and a plain object with a `[CANCELLATION]` accessor whose getter throws. Each must return `false`, not propagate. These are the cases that turn a predicate called from a `catch` block into a bug that replaces the caller's original error with an unrelated one.

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `pnpm vitest run packages/ribo-core/src/cancellation.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the module**

  Export the symbol, the class and the predicate. The predicate checks, in order: the passed signal's `aborted` flag when a signal was given; a truthy `[CANCELLATION]` **own** property on a non-null object; and an error whose `name` is `"AbortError"`.

  Three implementation requirements, each answering a way the obvious version breaks:

  - **Wrap the entire body in `try { … } catch { return false; }`.** A `typeof`/null guard is not enough: a property read on a `Proxy` invokes its traps, and `Object.prototype.hasOwnProperty.call` invokes `getOwnPropertyDescriptor`. The try/catch is the only construct that actually delivers "never throws" for arbitrary input, and this predicate runs inside catch blocks where throwing would destroy the error being handled.
  - **Own property, and truthy.** Not `in`, which walks the prototype chain for no benefit — Task 4 brands instances in a factory, never a prototype — and widens the surface where a trap can fire. Truthy rather than present, because `useDefineForClassFields` can put an own `[CANCELLATION]: undefined` on every instance of a class that merely declares the field.
  - **Duck-check `name === "AbortError"`, not `instanceof DOMException`.** A `DOMException` crossing a realm boundary (iframe, worker) fails `instanceof` against the local constructor — and a worker boundary is exactly where this repo's on-device transport lives, so the native case this check exists for is the one `instanceof` would miss.

  Declare the brand property as optional on an exported interface so a TypeScript author can set it without a cast.

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

**The retry rules, in the order they are checked.** Before each attempt, if the caller's signal has already aborted, throw a `CancellationError` without starting the attempt and without counting it — the invariant `three-phase-extractor.ts:377-386` repeats at four sites and explains: an attempt that never ran must not appear in the attempt count. On attempt zero there is no previous error to rethrow, which is why this throws a fresh `CancellationError` rather than a captured one. After a failure: a `TerminalQueueError` is rethrown untouched; a cancellation (per Task 1's predicate, consulted with the caller's signal) is rethrown untouched; a failure for which `isTransientFailure` returns `false` is rethrown untouched; anything else is retried until `maxRetries` is exhausted, after which the last error is rethrown. A `SchemaParseError` is retried, because `isTransientFailure` already returns `true` for it and the design keeps that.

**Usage across attempts — the semantics this combinator has to choose.** `ExtractionUsage.calls` is documented as "Model calls made, **including retries**" (`extractor.ts:41`), and `grouped-extractor.ts:428` — the loop this generalizes — sums `usage.calls` across attempts. `retryExtractor` follows suit: on a **retried** success it returns a new result whose `usage.calls` is the sum over every attempt that reported one, preserving all other usage members from the accepted attempt. On a **first-attempt** success it returns the inner result object unchanged, by identity, because there is nothing to sum and rebuilding would break the passthrough guarantee downstream consumers rely on. A failed attempt that rejects reports no usage and contributes nothing; only attempts that returned a result can.

- [ ] **Step 1: Write the failing tests**

  In `retry-extractor.test.ts`, drive a stub `Extractor` whose `extract` is backed by a scripted queue of outcomes and which **records the options it was called with on every call** — `FakeExtractor` cannot serve here, because it always resolves and so can never produce a second attempt. Inject a `delay` that records the milliseconds it was asked to wait and resolves immediately.

  Assert: a first-attempt success calls the inner extractor once and returns its result unchanged, **by identity** (`toBe`); a transient failure followed by a success calls twice and returns the second attempt's fields; exhausting `maxRetries` rejects with the **last** error, not the first; a `TerminalQueueError` rejects immediately after one call; a `CancellationError` rejects immediately after one call; a 400-status error rejects immediately after one call (`isTransientFailure` is false); a `SchemaParseError` **is** retried; the `delay` function is called once per retry and never before the first attempt; `delay` receives a number (not an exact value — `fullJitterDelay` is randomised); an already-aborted signal rejects with a `CancellationError` without calling the inner extractor at all; and the caller's `ExtractOptions`, signal included, reaches the stub on **every** attempt.

  Pin the usage rule both ways: a first-attempt success returns the inner `usage` object by identity, and a success on the third attempt reports `usage.calls` equal to the sum across the attempts that returned one.

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

**Shape: a `Promise.race`, following `withTimeout`.** The deadline must hold even against an inner extractor that ignores its signal — that is the whole point of a timeout, and it is why the relay's own `withTimeout` (`relay.ts:198-221`) races the work against a timer promise rather than awaiting the work and converting afterwards. An await-then-convert shape cannot reject until the inner settles, so a hung inner hangs the combinator forever. Copy `withTimeout`'s ordering too: fire the abort **before** rejecting, so anything the signal cancels is already unwinding when the caller sees the timeout.

**Reap the losing promise.** When the timer wins, the inner promise is still outstanding and will often reject once its abort lands. An unhandled rejection fails the suite; `hedged.ts:233-234` documents this exact trap for the same reason. Attach a no-op catch to the inner promise at the point the race is set up, not conditionally afterwards.

**The error the caller sees, and why it is not cancellation-branded.** A deadline elapsing and a caller cancelling are different events, and a consumer that cannot tell them apart can report neither honestly. `ExtractionTimeoutError` is deliberately **not** branded, so `isTransientFailure` treats it as transient (the unrecognised-error default) and an **outer** `retryExtractor` will retry it — a per-attempt deadline with retries around it, which is the composition worth having. A cancellation-branded timeout would make that composition silently do nothing.

**Precedence when both happen.** If the caller's signal has aborted, the caller's cancellation wins, whatever the timer did — first aborter wins, matching `AbortSignal.any`'s own reason semantics, and misreporting a user's cancel as a deadline would be a lie in the direction that hides a user action. So: on rejection, if the caller's signal is aborted, propagate the inner error untouched; only when the caller's signal is intact does a fired timer produce `ExtractionTimeoutError`.

- [ ] **Step 1: Write the failing tests**

  In `timeout-extractor.test.ts`, inject a `scheduleTimer` that captures the callback rather than scheduling it, so tests fire the timer on demand. Most cases need a **hand-written pending stub** whose `extract` returns a promise that stays pending until the test resolves or rejects it, and which records the options it received — `FakeExtractor` resolves immediately, so it can only serve the success-path case and cannot be held pending while the timer fires.

  Assert: an inner extractor that resolves before the timer fires returns its result unchanged and the captured clear function was called; the clear function is **also** called when the inner rejects, and when the timer fires; firing the timer rejects with `ExtractionTimeoutError` whose message names the budget, **even though the pending stub never settles** (this is the test that distinguishes the race shape from an await-then-convert shape, and it is the reason for the shape); when the timer fires, the signal the stub received is already aborted at the moment of rejection; a stub that rejects with its own cancellation-branded error *after* the timer fired still surfaces as `ExtractionTimeoutError`; `isCancellation(new ExtractionTimeoutError(...))` is `false`; when the **caller's** signal aborts, the inner cancellation propagates unchanged rather than becoming a timeout; and — the race the plan previously left unpinned — when the caller's signal aborts **and** the timer fires in the same tick, the caller's cancellation wins, asserted in **both** firing orders.

  Assert no unhandled rejection is produced when the timer wins and the inner later rejects. Assert a non-positive `timeoutMs` is rejected at construction, naming the value, as `fullJitterDelay` validates its own input (`backoff.ts:36-40`).

- [ ] **Step 2: Run the tests to verify they fail**

  Run: `pnpm vitest run packages/ribo-core/src/timeout-extractor.test.ts`
  Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the combinator**

  Race the inner `extract()` against a timer promise, as `withTimeout` does. Combine the caller's signal with the timeout controller's using `AbortSignal.any`, never `??` — `grouped-extractor.ts:360-364` documents that exact trap, where a caller-supplied signal silently replaces the combinator's own and disables it. Attach the no-op catch to the inner promise where the race is built. Clear the timer in a `finally`, so every path clears it. Apply the caller-signal precedence rule above before converting anything to a timeout.

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

  **The TypeScript mechanics here are a trap and must be followed exactly.** Implementing the brand interface does not give the class a settable member — `implements` creates nothing. But a plain field declaration is worse: the repo targets ES2023 (`packages/tsconfig/base.json:4`), so `useDefineForClassFields` is on and a declared field **defines an own `[CANCELLATION]: undefined` on every `ChatError` instance**, including transport failures. Paired with a presence-based predicate that would mark every chat error as a cancellation and silently disable retries across the whole extraction path — which is why Task 1's predicate checks truthiness and Task 1's tests pin the `undefined`-own-property case.

  So: declare the member with `declare` (emitting no field initialiser) and **not** `readonly` (a `readonly` declaration makes the factory's assignment fail with TS2540), then assign it in the factory.

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

## Reviewed

Reviewed by OpenCode (`glm-5p3-flash`, run 80c8) before implementation. All eight findings applied.
The substantive ones: Task 3's original prose specified an await-then-convert shape whose deadline
would not bound a non-cooperating inner extractor, and whose described tests could not pass under
that shape — it is now a `Promise.race` following `withTimeout` (`relay.ts:198-221`), with the
losing promise reaped; Task 3's timer-versus-caller race was undefined and could misreport a user's
cancellation as a deadline — caller precedence is now specified and pinned in both firing orders;
Task 1's "never throws" was asserted in prose but achievable only with a total `try`/`catch`, since a
`Proxy` trap or a throwing getter defeats a `typeof` guard, and `instanceof DOMException` misses the
cross-realm case that is the whole reason for the check; Task 2 left usage-across-retries
unspecified against a documented "including retries" invariant; Task 2's forwarding test named
`FakeExtractor`, which cannot fail on cue and so can never produce a second attempt; and Task 4's
class-field mechanics would, under this repo's ES2023 target, have branded every `ChatError`.

The review independently verified the plan's load-bearing claim — that `isTransientFailure` must not
change — against `extraction-common.ts:246`, `docs/guide/extraction.md:46`, `single-shot.test.ts:362-376`
and the relay's own classification path, and confirmed Task 4 is additive for every existing consumer
of aborted errors.
