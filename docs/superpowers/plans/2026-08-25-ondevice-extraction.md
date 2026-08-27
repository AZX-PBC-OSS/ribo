# On-Device Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an offline auditor's queued item run all the way to `awaiting-review` by extracting on-device through Chrome's Prompt API, instead of parking in `extracting` until signal returns.

**Architecture:** On-device is a second `ChatClient`, so it inherits `perGroupExtractor` unchanged. Two `perGroupExtractor` instances — managed and on-device, each configured for its own timing — sit behind a composite `Extractor` that selects per extraction, managed-first. The on-device client streams internally so it can kill Nano's degenerate whitespace loop early and retry, and enforces its own hard deadline for every other degeneration.

**Tech Stack:** TypeScript, zod, RxDB (outbox), vitest (unit + browser via Playwright), pnpm workspace, tsdown. Chrome Prompt API (`LanguageModel`) — browser-only, no npm dependency.

**Spec:** `docs/superpowers/specs/2026-08-17-ondevice-extraction-design.md`. Read §3.5, §10 and §11 before starting. This plan is **revision 2**: two reviewers found three execution-blockers in revision 1, recorded in spec §11. Where this plan and the spec disagree with the tree, **the tree is right** — that is how all three blockers arose.

## Global Constraints

- **No code blocks in this plan.** Per project preference, tasks state intent, interfaces and must-fail tests. Implementers write the code.
- Node >= 24, pnpm 10.34.5. All commands run from the repo root.
- `./check.sh` is the "am I done?" signal. Individual packages have **no `test` script** — select with a path argument, e.g. `pnpm vitest run packages/ribo-core`.
- A package with no `typecheck` script is silently absent from the gate. A package with no `src/index.ts` breaks `build:packages`. Any new package needs both **from its first commit**.
- Provenance envelope rules (`ribo-core/src/provenance.ts`) unchanged: every key required and nullable, no `.optional()`, no `minimum`/`maximum`/`pattern`.
- `spikes/extraction-snuggpro/score.mjs` is reused **verbatim**. Never edit it.
- The Prompt API does not exist in Node. Tasks 1–9 drive a **fake `LanguageModel` global** and need no browser.
- Measured constants from spec §10, used as written: context window 9,216 tokens; whitespace-abort threshold 80 characters; on-device per-call ceiling and hard deadline ~15,000 ms; on-device retries 4.

---

## File Structure

**New — `packages/ribo-extractor-ondevice/`**

- `src/loop-detector.ts` — the pure trailing-whitespace predicate. Isolated because it is the one piece with subtle correctness.
- `src/session.ts` — base-session lifecycle: lazy create, clone-per-call, idle destroy, gesture rules.
- `src/ondevice-chat.ts` — the `CapableChatClient`: translation, streaming, loop kill, hard deadline, error mapping, `prime()`.
- `src/index.ts` — public surface and the stable engine id. Exists from Task 2.

**Modified — `packages/ribo-extractor-openai/src/`**

- `chat-client.ts` — **`ChatCapability` and `CapableChatClient` are declared here**, at the seam both transports implement (spec §11, finding 1).
- `per-group.ts` — `PER_CALL_CEILING_MS` becomes a per-instance option.
- `helix-chat.ts` — optional connectivity source, capability reporting.
- `composite-extractor.ts` (new) — the selecting `Extractor`.

**Modified — `packages/ribo-core/src/`**

- `extractor.ts`, `queue/relay.ts`, `queue/schema.ts`, `queue/database.ts` — provenance to the outbox, including an RxDB version bump.

**Modified — `playground/src/`** — stand-in consumer: capability display, real-gesture priming, `invalidate()` wiring, beta badge.

**Modified — `vitest.config.ts` and the acceptance harness** — a real-Chrome path for the two tasks that touch the model.

---

### Task 1: Make the per-call ceiling configurable

`PER_CALL_CEILING_MS` is a module constant of 120,000 (`per-group.ts:170`), so `deriveMaxRetries` grants the on-device delegate **zero** retries at `batches = 7`. Everything in spec §3.5 depends on fixing that.

**Files:**

- Modify: `packages/ribo-extractor-openai/src/per-group.ts` (constant at :170, `PerGroupOptions`, the `deriveMaxRetries` signature at :200 and its call site at ~:386-395)
- Test: `packages/ribo-extractor-openai/src/per-group.test.ts`

**Interfaces:**

- Produces: `PerGroupOptions.perCallCeilingMs?: number`, defaulting to 120,000 so existing callers are unaffected. `deriveMaxRetries` takes the ceiling as a parameter.

- [ ] **Step 1: Write the failing tests.** (a) Existing defaults — 7 groups, `concurrency: 4`, ceiling 120,000, `stepTimeoutMs` 900,000, `maxRetries` 2 — still derive **2**, proving the refactor is behaviour-preserving. (b) `concurrency: 1` with the 120,000 ceiling derives **zero**, pinning the defect so nobody "fixes" it by loosening the timeout. (c) `concurrency: 1`, ceiling 15,000, **and `maxRetries` requested as 4**, derives **4**. That requested value is not optional: `deriveMaxRetries` only ever counts _down_ from what was asked (`per-group.ts:207`), so with the default of 2 this test would fail for the wrong reason.
- [ ] **Step 2: Run and watch them fail.** `pnpm vitest run packages/ribo-extractor-openai`.
- [ ] **Step 3: Implement.** Add the option, thread it through, default it to the existing value. `PER_CALL_CEILING_MS` is module-private today and is **not** exported from `index.ts`; keep it private and make it the option's default. Update the long explanatory comment above the derivation so it reads as a default rather than a law.
- [ ] **Step 4: Run the tests.** All three pass; the package's existing suite is untouched.
- [ ] **Step 5: Commit.**

---

### Task 2: Declare the capability contract at the seam

Revision 1 put this type in the on-device package, which both reviewers caught as a dependency cycle — `helixChat` and the composite live in `-openai`, and `-ondevice` depends on `-openai` (spec §11, finding 1). Doing it first means Tasks 4, 7 and 8 all build against one declaration.

**Files:**

- Modify: `packages/ribo-extractor-openai/src/chat-client.ts`, `src/index.ts`
- Test: `packages/ribo-extractor-openai/src/chat-client.test.ts`

**Interfaces:**

- Produces: `ChatCapability`, a discriminated union of `ready` / `needs-download` / `unavailable`, mirroring `TranscriberCapability` **minus `downloadBytes`** (the Prompt API reports progress as a 0..1 fraction with total always 1, so no byte figure exists; `unavailable` carries a required human-readable detail, as the transcriber's does). And `CapableChatClient` — a `ChatClient` that also has a readonly `engine` and a `capability()` returning a promise.
- Consumed by: Tasks 4, 7, 8.

- [ ] **Step 1: Write the failing test.** A plain object implementing `complete()`, `engine` and `capability()` satisfies `CapableChatClient`; a plain `ChatClient` does not. This is a type-level test — assert via a type-assertion helper the package already uses, or a compile-time expectation, not a runtime assertion.
- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement**, exporting both from the package index.
- [ ] **Step 4: Run the tests** and `pnpm --filter @azx/ribo-extractor-openai typecheck`.
- [ ] **Step 5: Commit.**

---

### Task 3: Carry the extracting engine to the outbox

Without this, `usage.engine` is computed and discarded (`extractor.ts:72-76`), which removes the reason for this architecture. **This is a real RxDB migration** — revision 1 called it free, which was wrong about the mechanism even though it is right about back-compat.

**Files:**

- Modify: `packages/ribo-core/src/extractor.ts`; `queue/relay.ts` (the `ExtractStep` type at :25 and the extract step's patch site); `queue/schema.ts` (the document schema at ~:200 and the `version: 3` at ~:350); `queue/database.ts` (`OUTBOX_MIGRATION_STRATEGIES`, ~:45-49)
- Test: `packages/ribo-core/src/extractor.test.ts`; `queue/schema.test.ts` (the version pin at ~:195); `queue/outbox.browser.test.ts` (the v0→v3 migration test at ~:335); `queue/outbox-memory.test.ts` (the version claim at ~:82)
- **Note:** the relay's tests are `queue/relay.browser.test.ts`. There is no `relay.test.ts` — revision 1 named a file that does not exist.

**Interfaces:**

- Produces: `ExtractionResult.usage.engine?: string` — **optional**, since `FakeExtractor`, `singleShotExtractor` and `perGroupExtractor` all return `{ calls }` today and a required field breaks every one. `ExtractStep` returns a **wrapper object** carrying the field map plus an optional engine.
- **Pick the wrapper, not a union.** A union of "bare field map or wrapper" cannot be discriminated safely: extraction field maps are arbitrary-keyed, so a legitimate map could itself carry a `fields` key. The wrapper means updating the inline `extract` fakes in `relay.browser.test.ts` — do that rather than inventing a runtime discriminator.

- [ ] **Step 1: Write the failing tests.** (a) An extractor reporting an engine leaves it on the persisted outbox row. (b) An extractor reporting **no** engine still succeeds, column absent — the back-compat case keeping `FakeExtractor` and the managed path working. (c) A v3 database opens against the v4 schema and its rows survive, exercising the new migration strategy. Without a strategy entry the outbox **fails to open entirely** (`database.ts:71-74`), so this test is the difference between a migration and an outage.
- [ ] **Step 2: Run and watch (a)–(c) fail.** `pnpm vitest run packages/ribo-core`.
- [ ] **Step 3: Implement.** Widen the types; stop discarding in `toExtractStep`; add the column; bump the schema to `version: 4`; add an identity migration strategy following the existing v0→v3 entries as the template; update the version pin in `schema.test.ts` and the version claim in `outbox-memory.test.ts`; update the inline `extract` fakes in `relay.browser.test.ts` for the new return shape.
- [ ] **Step 4: Run the tests**, both projects, plus `pnpm --filter @azx/ribo-core typecheck`.
- [ ] **Step 5: Commit.**

---

### Task 4: The whitespace loop detector, and the package scaffold

**Files:**

- Create: `packages/ribo-extractor-ondevice/src/loop-detector.ts`, `src/loop-detector.test.ts`, `src/index.ts`
- Create: `package.json`, `tsconfig.json`, `tsdown.config.ts`, `README.md`

**Interfaces:**

- Produces: a predicate taking accumulated output and returning whether the trailing 80 characters are all whitespace. Threshold exported as a named constant so the client and tests share one value.

- [ ] **Step 1: Scaffold the package.** Follow AGENTS §6.2's checklist. It **must** have a `typecheck` script and a real `src/index.ts` from this commit — a package missing either silently escapes the gate or breaks `build:packages`, and `./check.sh` may be run at any point between tasks.
- [ ] **Step 2: Write the failing tests.** (a) A well-formed pretty-printed extraction response of the shape §10 observed (462–917 chars, two-space indentation) returns **false** — the no-false-positive case, and the most important test here, since a false positive silently truncates good answers. (b) Content followed by 80+ newlines returns true. (c) Content followed by 80+ mixed spaces and newlines returns true, matching the real observed tails. (d) A string shorter than the threshold returns false regardless. (e) Exactly 79 whitespace characters returns false, exactly 80 returns true.
- [ ] **Step 3: Run and watch them fail.** `pnpm vitest run packages/ribo-extractor-ondevice`.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run the tests**, then `./check.sh` to confirm the new package joins the gate cleanly rather than silently sitting outside it.
- [ ] **Step 6: Commit.**

---

### Task 5: Capability probe and `prime()`

**Files:**

- Create: `packages/ribo-extractor-ondevice/src/capability.ts`, `src/capability.test.ts`, `src/test-support/fake-language-model.ts`

**Interfaces:**

- Consumes: `ChatCapability` from Task 2 — **imported, not redeclared**.
- Produces: a probe over an injected `LanguageModel`-shaped object, and a `prime` taking a progress callback.
- The fake must model: the four availability values; a `create` that can throw `NotAllowedError`; a monitor emitting `downloadprogress`; a call counter; and (for Task 7) a `promptStreaming` yielding caller-supplied chunks and observing its `AbortSignal`.

- [ ] **Step 1: Write the failing tests.** (a) Each availability value maps correctly — `available`→ready, `downloadable` and `downloading`→needs-download, `unavailable`→unavailable with a detail. (b) Probing performs **no** `create` call — assert the fake's counter is zero. This is the no-background-download rule. (c) `prime()` calls create once and forwards every progress event. (d) `NotAllowedError` from create surfaces as a **capability** failure whose message names the missing user gesture — the fix is "call this from a click" and the error must say so. (e) A probe that throws is treated as `unavailable`, never propagated (`first-capable.ts:239-243` is the existing precedent).
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests** and the package `typecheck`.
- [ ] **Step 5: Commit.**

---

### Task 6: Session lifecycle

**Files:**

- Create: `packages/ribo-extractor-ondevice/src/session.ts`, `src/session.test.ts`

**Interfaces:**

- Produces: a holder that lazily creates one base session with the system prompt and few-shot turns, hands out a **clone** per call, and destroys the base after idle. Timer injectable — reuse `ScheduleTimer`, which is **defined in `ribo-core/src/connectivity.ts`** and reused by `hedged.ts`; do not invent a new one.

- [ ] **Step 1: Write the failing tests.** (a) Two sequential calls create the base **once** and clone **twice** — the rule preventing group 7 from seeing group 1's context. (b) A clone is destroyed after its call; the base is retained. (c) A clone is destroyed on the **error and abort paths** too, not only on success — otherwise every loop-kill leaks a session. (d) After the idle period the base is destroyed and the next call creates a fresh one. (e) When availability is not `available`, the lazy create is **not attempted** and the caller gets a capability failure — the lazy path has no user gesture, so attempting it throws `NotAllowedError` from inside a queue drain. (f) Concurrent calls share one base session rather than each creating their own.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Commit.**

---

### Task 7: `OnDeviceChat` — translation, streaming, loop kill, deadline

The heart of the package. Spec §3.1 and §3.5. Largest task in the plan; if it needs splitting, split along **error-mapping versus streaming**, not along translation versus the rest — a loop detector with no stream to cancel proves nothing.

**Files:**

- Create: `packages/ribo-extractor-ondevice/src/ondevice-chat.ts`, `src/ondevice-chat.test.ts`
- Modify: `packages/ribo-extractor-ondevice/src/index.ts`

**Interfaces:**

- Consumes: Tasks 2, 4, 5, 6.
- Produces: a `CapableChatClient` plus `prime()`, and a stable engine id constant mirroring `ONDEVICE_WHISPER_ENGINE`'s naming (`ribo-transcriber-ondevice/src/index.ts:77`).
- Behaviour: `system` and few-shot messages become `initialPrompts`; only the final user turn is prompted. The JSON Schema becomes `responseConstraint`. `omitResponseConstraintInput` is true. **Sampling stays at default** — measured worse with `most-predictable` and possibly ignored outright (§10.5). `complete()` returns a whole string while consuming `promptStreaming` internally.
- **`ChatRequest.model` and `maxTokens` have no Prompt API equivalent and are ignored, not rejected.** Throwing `ChatError.unsupported` for them would be terminal (`extraction-common.ts:160-166`) and would kill the offline path on its first call.

- [ ] **Step 1: Write the failing tests — translation.** (a) System and few-shot land in `initialPrompts`; only the transcript is prompted. (b) The schema reaches `responseConstraint` unmodified. (c) `omitResponseConstraintInput` is set. (d) A request carrying `model` and `maxTokens` succeeds, ignoring both. (e) Every returned completion carries a `finishReason` — required of implementations per `chat-client.ts:81` even though the type marks it optional.
- [ ] **Step 2: Write the failing tests — errors.** `NotSupportedError`→unsupported, `SyntaxError`→malformed, `AbortError`→aborted, `NetworkError`→transport. And the critical one: **`QuotaExceededError` surfaces as a `ChatError` whose kind is neither `refusal` nor `unsupported`** — those two are the only kinds `completeOrClassify` makes terminal (`extraction-common.ts:160-166`), and terminal would disable the retry that measurement showed is the fix. Classify it **unconditionally**, not by string-matching Chrome's message: the pre-flight already excludes the input-overflow case, so every `QuotaExceededError` reaching here is output truncation. A test asserting terminal is the bug, not the fix.
- [ ] **Step 3: Write the failing tests — pre-flight.** A prepared input measured larger than `session.contextWindow` fails before any prompt, with a clear `ChatError`. Note `measureContextUsage` **ignores** `responseConstraint` (§10.2), so measure the prompt only.
- [ ] **Step 4: Write the failing tests — streaming, loop and deadline.** (a) A stream emitting content then 80+ whitespace characters is aborted mid-stream and surfaces a retryable error; assert the underlying stream was **actually cancelled**, not merely ignored. (b) A normal response completes and returns the whole string. (c) A stream that never degenerates into trailing whitespace but runs past the hard deadline is aborted by the client's own `AbortSignal` — this is the case the whitespace detector cannot catch, and §10.3 measured it at 114.8s. (d) An **external** `ChatCallOptions.signal` firing cancels the stream and rejects with `ChatError.aborted`; `perGroupExtractor` relies on this to cancel in-flight siblings (`per-group.ts:408`), and a client that ignores it leaves Nano generating past a failed extraction.
- [ ] **Step 5: Run and watch all four groups fail.**
- [ ] **Step 6: Implement.**
- [ ] **Step 7: Run the tests**, plus the package `typecheck` and `pnpm lint`.
- [ ] **Step 8: Commit.**

---

### Task 8: Give `helixChat` a capability

**Files:**

- Modify: `packages/ribo-extractor-openai/src/helix-chat.ts` (factory at :98)
- Test: `packages/ribo-extractor-openai/src/helix-chat.test.ts`

**Interfaces:**

- Consumes: Task 2's `CapableChatClient`.
- Produces: `HelixChatOptions` gains an optional connectivity source; the factory's return widens from `ChatClient` to `CapableChatClient`. Additive — existing callers touch only `complete()`.

- [ ] **Step 1: Write the failing tests.** (a) Connectivity online → `ready`. (b) Offline → `unavailable`. (c) The client **subscribes** and tracks change: flip the source after construction and the capability follows. A construction-time snapshot is the bug — it goes stale and the composite keeps choosing a dead uplink. (d) With **no** connectivity source, capability is `ready` — today's unconditional behaviour, so nothing existing changes.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.** Do not read `navigator.onLine`; the repo distrusts it for the captive-portal reason in `relay.ts`.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Commit.**

---

### Task 9: The composite extractor

**Files:**

- Create: `packages/ribo-extractor-openai/src/composite-extractor.ts`, `src/composite-extractor.test.ts`
- Modify: `packages/ribo-extractor-openai/src/index.ts`

**Interfaces:**

- Consumes: Tasks 2, 3, 8.
- Produces: a factory over an ordered list of `{ chat: CapableChatClient, extractor: Extractor }` entries, returning an `Extractor`. Probes each entry's chat capability, picks the first `ready`, runs that entry's extractor for the whole extraction, stamps `usage.engine`. Exposes `invalidate()`. TTL-caches capability, reusing `DEFAULT_CAPABILITY_TTL_MS` (exported from `ribo-core`, `first-capable.ts:39`) rather than a new number.
- **A managed client with no connectivity source reports `ready` (Task 8d), so a capability-less entry is not a case that needs handling** — every entry is a `CapableChatClient` by construction.

- [ ] **Step 1: Write the failing tests.** (a) Managed ready → managed runs and `usage.engine` names it. (b) Managed unavailable, on-device ready → on-device runs and is named. **Both directions asserted** — the ordering is inverted relative to the transcriber and reads like a bug, so these two tests are what stop someone "correcting" it. (c) An entry reporting `needs-download` is **never** selected, even as the only entry — that fetch needs a user gesture a queue drain cannot supply. (d) Selection happens **once** per extraction: with seven groups, capability is probed once. (e) `invalidate()` makes the next call re-probe instead of serving cache. (f) With no selectable entry, the error names the reason.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.** Put the inverted-ordering rationale in the file's doc comment citing spec §3.4 — the code is otherwise indistinguishable from a mistake.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Commit.**

---

### Task 10: Wire the delegates, and guard the timing model

**Files:**

- Create/modify: the module constructing the production pair, and its test. The only in-repo production construction today is `playground/src/extractor-store.ts:144-166` — and it uses **`openAiChat`**, not `helixChat`. Either give it a connectivity source via `helixChat`, or keep `openAiChat` and wrap it to report `ready`; decide and state it in the commit.

**Interfaces:**

- Consumes: Tasks 1, 7, 8, 9.
- Produces: the configured pair — managed on stock defaults (`concurrency: 4`, ceiling 120,000, retries 2); on-device on `concurrency: 1`, ceiling 15,000, **`maxRetries` requested as 4**.

- [ ] **Step 1: Write the failing test — the regression guard.** The on-device delegate's configuration derives **at least 4** retries. If someone restores the 120,000 ceiling, raises concurrency, trims `stepTimeoutMs`, or drops the requested `maxRetries`, this fails. Spec §3.5's whole argument lives on that number being non-zero and nothing else would notice it silently reaching zero.
- [ ] **Step 2: Write the failing test — worst-case fit.** The on-device worst case (7 batches × (retries+1) × ceiling + accumulated backoff) fits inside `stepTimeoutMs`. **Note this proves arithmetic on constants, not real latency** — the ceiling is not enforced by `per-group.ts` (spec §3.5), which is why Task 7's hard deadline exists.
- [ ] **Step 3: Run and watch them fail.**
- [ ] **Step 4: Implement the wiring.**
- [ ] **Step 5: Run the tests**, then `./check.sh`.
- [ ] **Step 6: Commit.**

---

### Task 11: Retry-to-success through the real extractor

Spec §4 lists this and revision 1 had no task for it. Task 7 tests loop-kill in isolation; Task 10 counts derived retries. Neither exercises `perGroupExtractor` × `OnDeviceChat` together.

**Files:**

- Create: `packages/ribo-extractor-ondevice/src/retry-integration.test.ts`

**Interfaces:** consumes Tasks 7, 10, and the fake from Task 5.

- [ ] **Step 1: Write the failing tests.** (a) A fake whose first two attempts degenerate and whose third succeeds produces a **successful extraction**, with exactly three attempts observed. (b) A fake that degenerates on every attempt exhausts the budget and fails **cleanly** — a `TerminalQueueError` or a surfaced failure, never a hang and never a silent empty result. (c) The failing case makes exactly `maxRetries + 1` attempts, no more — proof the retry is bounded.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement** whatever wiring the tests reveal missing. If all three pass immediately, that is a legitimate outcome — record it in the commit rather than inventing work.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Commit.**

---

### Task 12: A real-Chrome test path

**This is the blocker that made revision 1's Tasks 10 and 13 undeliverable.** The browser project launches Playwright's bundled Chromium (`vitest.config.ts`), which has no Gemini Nano — the model arrives via branded Chrome's component updater. As written, every real-model test would skip everywhere, including dev machines, and look like coverage. Spec §10.6.

**Files:**

- Modify: `vitest.config.ts`
- Create: a short `docs/implementation/` note recording how to arm a profile

**Interfaces:**

- Produces: a way to run a `.browser.test.ts` against real Chrome with a pre-armed profile. Two viable routes — pick one and record why: a Playwright `channel: "chrome"` launch with a persistent `user-data-dir` whose model is already downloaded; or a standalone harness like spec §10's, driven manually.
- Also: the browser project's include covers only `packages/*/src/**` and `playground/src/**`, and `testTimeout` is 30s. A real extraction runs 4–50s and a corpus run is ~10 minutes, so both the include globs and the timeout need addressing for Tasks 13–14.

- [x] **Step 1: Verify the problem before solving it.** **DONE 2026-08-26, and it overturned the premise.** `prompt-api-availability.browser.test.ts` measured Playwright's Chromium (HeadlessChrome 149): the `LanguageModel` global is **present**, `availability()` is **`downloadable`**, and `create()` fails with `NotAllowedError — Requires a user gesture`. The API is not missing; the gesture is. Spec §10.6 is corrected. This step existed to make abandoning the task cheap, and it half-did that — the task survives, but as a different task.
- [ ] **Step 2: Can a synthesised click satisfy user activation?** Drive a real click through the browser-mode user-event API and call `create()` from its handler. Playwright dispatches trusted events over CDP, so this may simply work. **A cheap yes/no that decides everything below**, so do it before building anything.
- [ ] **Step 3: Does the model survive between runs?** Playwright launches ephemeral contexts, so a fresh profile means a ~5.4-minute multi-gigabyte download **per run** — unusable for CI even if Step 2 succeeds. Measure whether a persistent `user-data-dir` keeps it. If it does not, the honest answer is that real-model runs stay manual and opt-in, and this task's deliverable is documenting that rather than automating it.
- [ ] **Step 4: Implement whatever Steps 2-3 justify**, including a per-test timeout sufficient for a ~50s call (the browser project's default is 30s). If they justify nothing, write the finding into `docs/implementation/` and close the task — an automated path that silently never runs is worse than an honest manual one.
- [ ] **Step 5: Commit.**

---

### Task 13: Browser proof against the real model — **NOT DONE, deliberately**

**Skipped, 2026-08-26.** Written for the per-group strategy, which no longer exists, and
retargeting it at three-phase would produce a test that **can only ever skip in CI**: Playwright's
Chromium ships a Prompt API stub that answers with canned text (spec §10.6), so the test would
either skip everywhere or, worse, pass against fixed strings and look like coverage.

Real-model verification is instead the corpus harness in `spikes/ondevice-acceptance/`, run
manually against real Chrome. That is strictly more thorough than this task ever was — 14
transcripts scored against annotated ground truth, versus one assertion that a response parses.
What it gives up is unattended verification, and nothing available here provides that.

The original task follows, unchanged, for whoever revisits this if Chromium ever ships a working
model — the tripwire in `prompt-api-gesture.browser.test.ts` fails on the day it does.

---

#### Original task

**Files:**

- Create: `packages/ribo-extractor-ondevice/src/ondevice-chat.browser.test.ts`

**Interfaces:** consumes Tasks 7, 12.

- [ ] **Step 1: Write the test.** Skip (not fail) when `LanguageModel` is absent or availability is not `available`, so CI stays green. When present: one real constrained extraction against a small enveloped schema, asserting the response parses, carries every leaf, and every leaf is a well-formed `{value, confidence, sourceSpan}` envelope. Do **not** assert extracted values — that is content accuracy, which spec §4 records rather than gates.
- [ ] **Step 2: Run it under Task 12's path** and confirm it genuinely executes, not skips.
- [ ] **Step 3: Add a repeat loop** driving the same extraction 10+ times, asserting **all** eventually succeed through the retry path. This is the standing regression for §10.5's 20/20 result. Give it a timeout sized for the repeats.
- [ ] **Step 4: Run again**, confirm stable across at least two runs — an intermittently-passing regression test is worse than none.
- [ ] **Step 5: Commit.**

---

### Task 14: Playground wiring — the stand-in consumer

**Files:**

- Create: `playground/src/ondevice-extractor-store.ts`, `src/ondevice-extractor-store.test.ts`
- Modify: `playground/src/extractor-store.ts` and the panel rendering extraction state

**Interfaces:** consumes Tasks 5, 7, 9. Mirror `whisper-store.ts`'s phase machine — it already solves this shape for the transcriber and divergence would be gratuitous.

- [ ] **Step 1: Write the failing tests.** (a) The store reports `needs-download` when the model is absent, `ready` when present. (b) Priming is reachable **only** through an explicit user action, never an effect — Chrome throws `NotAllowedError` without a gesture, so an effect-triggered prime is broken by construction. (c) An item extracted on-device is flagged so review can badge it. (d) **A connectivity transition calls the composite's `invalidate()`.** Spec §3.4 requires this and revision 1 had no task for it — without it a stale managed `ready` survives up to a 30s TTL after the uplink drops, costing one doomed attempt per drop.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.** The arming affordance is a real button. Its copy must say the size is unknown and the wait is minutes — measured 5.4 minutes cold (§10.1) — and must not invent a byte figure.
- [ ] **Step 4: Run the tests**, then `pnpm build:app`.
- [ ] **Step 5: Commit.**

---

### Task 15: Score the on-device path against the real corpus

The point of the beta. Until this runs, quality is entirely unmeasured (spec §6.8).

**Files:**

- Create: a browser-mode acceptance runner, located per Task 12's chosen route
- Do **not** modify `spikes/extraction-snuggpro/score.mjs`

**Interfaces:**

- Consumes: Tasks 7, 12, 13.
- Produces: result JSON in exactly the shape `score.mjs` consumes, **and a run record in the existing `run-store.ts` format** so on-device runs land in the same store as the CLI backends rather than a parallel one. The run-record infrastructure already exists (`1b2d003`) — reuse it; do not rebuild it.

- [ ] **Step 1: Write the failing test.** The runner emits result JSON matching the existing shape for one transcript — assert against the shape the scorer expects, not against extracted values.
- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement the runner**, driving the corpus through the on-device delegate. `score.mjs` already excludes the contaminated `02-oil-boiler-basement.txt` at grading time (`score.mjs:89-101`), so no exclusion logic is needed here — revision 1 implied the runner had to handle it, which was wrong though harmless.
- [ ] **Step 4: Run the scorer.** Record hallucination rate, miss rate, enum accuracy and span fidelity beside the existing baselines.
- [ ] **Step 5: Write the findings up** as a numbered `docs/implementation/` doc following 18's shape — separate shape conformance from content accuracy, and state plainly what is measured versus argued. Expect the enum-conflation failure §6.8 names; report it rather than smoothing it.
- [ ] **Step 6: Commit.**

---

## Deferred, with reasons

- **Re-measuring on a Surface Go 3** (spec §6.3). The retry budget is sized against a loop rate measured on an M-series laptop. Needs the device.
- **Re-measuring on Edge** (spec §6.6). The API guarantees no interoperability and Edge ships a different model, so every constant is Chrome-specific.
- **Sub-group splitting.** Not needed: schema size does not consume context (§6.1) and retry converges (§10.5).
- **A throughput/`too-slow` gate.** Deliberately not built — §3.5 explains why demoting has nowhere to fall back to.
- **Moving the `ChatClient` seam out of `ribo-extractor-openai`.** §3.2 accepts the naming wart until a third transport exists. Note Task 2 adds to that package, deepening the wart slightly; accepted for the same reason.
- **The acceptance run-record split.** Already shipped in `1b2d003`. Revision 1 had a whole task for it. Do not rebuild it.

## Self-review notes

Spec coverage, re-checked against the tree rather than against revision 1's claims: §3.1→Tasks 6–7; §3.2→Tasks 2, 4–7; §3.3→Task 5; §3.4→Tasks 8, 9, **14d** (the `invalidate()` wiring revision 1 dropped); §3.5→Tasks 1, 4, 7, 10, 11; §3.6→Task 3; §4→Tasks 11, 13, 15; §10.6→Task 12.

Two things deliberately have no task. §6.4's tab-throttling risk has no implementation until observed in the field. §6.5's multi-tab model contention is a performance unknown that `navigator.locks` already makes safe for correctness.

Task 7 remains the riskiest — translation, streaming, loop kill and deadline together, because they are not independently testable. Task 12 is the one most likely to be abandoned rather than completed, and its Step 1 exists to make that discovery cheap.
