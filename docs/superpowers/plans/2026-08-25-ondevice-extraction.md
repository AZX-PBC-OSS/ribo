# On-Device Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an offline auditor's queued item run all the way to `awaiting-review` by extracting on-device through Chrome's Prompt API, instead of parking in `extracting` until signal returns.

**Architecture:** On-device is a second `ChatClient`, so it inherits `perGroupExtractor` unchanged. Two `perGroupExtractor` instances — managed and on-device, each configured for its own timing — sit behind a composite `Extractor` that selects per extraction, managed-first. The on-device client streams internally so it can kill Nano's degenerate whitespace loop early and retry, which is what makes the whole thing viable.

**Tech Stack:** TypeScript, zod, vitest (unit + browser mode via Playwright), pnpm workspace, tsdown. Chrome Prompt API (`LanguageModel`) — browser-only, no npm dependency.

**Spec:** `docs/superpowers/specs/2026-08-17-ondevice-extraction-design.md` — read §3.5 and §10 before starting. The design changed substantially after measurement; earlier reasoning in §9 is recorded as *superseded*, not as guidance.

## Global Constraints

- **No code blocks in this plan.** Per project preference, tasks state intent, interfaces and must-fail tests. Implementers write the code.
- Node >= 24, pnpm 10.34.5. All commands run from the repo root.
- `./check.sh` is the "am I done?" signal. Individual packages have **no `test` script** — select tests with a path argument, e.g. `pnpm vitest run packages/ribo-core`.
- A package without a `typecheck` script is silently absent from the gate. Any new package must define one.
- Provenance envelope rules (`ribo-core/src/provenance.ts`) are unchanged: every key required and nullable, no `.optional()`, no `minimum`/`maximum`/`pattern`.
- `score.mjs` is reused **verbatim**. Never edit it.
- The Prompt API is unavailable in Node. Every unit test drives a **fake `LanguageModel` global**; only browser-mode tests touch the real one, and they skip (not fail) when it is absent.
- Measured constants from spec §10, to be used as written: context window 9,216 tokens; whitespace-abort threshold 80 characters; on-device per-call ceiling ~15,000 ms; on-device retries 4.

---

## File Structure

**New package — `packages/ribo-extractor-ondevice/`**
- `src/capability.ts` — `ChatCapability` type and the mapping from the Prompt API's four availability values.
- `src/loop-detector.ts` — the pure whitespace-run predicate. No API calls, no session; separate because it is the one piece with subtle correctness and deserves isolated tests.
- `src/session.ts` — base-session lifecycle: lazy create, clone-per-call, idle destroy, gesture rules.
- `src/ondevice-chat.ts` — the `ChatClient` implementation, wiring the three above plus error mapping.
- `src/index.ts` — public surface and the stable engine id.
- `package.json`, `tsconfig.json`, `tsdown.config.ts`, `README.md`.

**Modified — `packages/ribo-extractor-openai/src/`**
- `per-group.ts` — `PER_CALL_CEILING_MS` becomes a per-instance option.
- `helix-chat.ts` — optional connectivity source, capability reporting.
- `composite-extractor.ts` (new) — the selecting `Extractor`. Lives here because it belongs to neither transport.

**Modified — `packages/ribo-core/src/`**
- `extractor.ts` — optional `engine` on `ExtractionResult.usage`; `toExtractStep` stops discarding it.
- `queue/relay.ts` — `ExtractStep` return widens; relay patches the new column.
- `queue/schema.ts` — outbox gains the extracting-engine column.

**Modified — `playground/src/`** — the stand-in consumer: capability display, a real gesture for `prime()`, beta badge.

**Modified — `packages/ribo-adapter-snuggpro/acceptance/`** — run record vs. baseline split, plus the browser-mode acceptance run.

---

### Task 1: Make the per-call ceiling configurable

Smallest change, and everything in §3.5 depends on it. Today `PER_CALL_CEILING_MS` is a module constant of 120,000 (`per-group.ts:170`), so `deriveMaxRetries` grants the on-device delegate zero retries at `batches = 7` — which would disable the retry that the whole design rests on.

**Files:**
- Modify: `packages/ribo-extractor-openai/src/per-group.ts` (the constant at :170, `PerGroupOptions`, the `deriveMaxRetries` call site around :386-395)
- Test: `packages/ribo-extractor-openai/src/per-group.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PerGroupOptions.perCallCeilingMs?: number`, defaulting to the existing 120,000 so every current caller is unaffected. `deriveMaxRetries` takes the ceiling as a parameter rather than closing over the constant.

- [ ] **Step 1: Write the failing tests.** Three cases. (a) With the existing defaults — 7 groups, `concurrency: 4`, ceiling 120,000, `stepTimeoutMs` 900,000 — the derived retry count is unchanged from today's value, proving the refactor is behaviour-preserving for the managed path. (b) With `concurrency: 1` and the default 120,000 ceiling, the derived count is **zero** — this pins the defect the spec describes, so nobody "fixes" it by loosening the timeout instead. (c) With `concurrency: 1` and a 15,000 ms ceiling, the derived count is **at least 4** — the on-device configuration must actually get a usable retry budget.
- [ ] **Step 2: Run and watch them fail.** `pnpm vitest run packages/ribo-extractor-openai` — expect a type error or failure on the unknown `perCallCeilingMs` option.
- [ ] **Step 3: Implement.** Add the option, thread it into `deriveMaxRetries`, default it to the current constant. Keep the constant exported as the default value so the existing explanatory comment block stays accurate — update that comment to say the figure is now a default rather than a fixed law.
- [ ] **Step 4: Run the tests.** All three pass; the rest of the package's suite is untouched.
- [ ] **Step 5: Commit.** Message should say why the constant became an option: a second transport needs an honest ceiling, and the derivation reads configured values.

---

### Task 2: Carry the extracting engine to the outbox

Without this, `usage.engine` is computed and discarded (`extractor.ts:72-76`; outbox `extracted` is a bare record at `queue/schema.ts:200`), which removes the reason for this whole architecture.

**Files:**
- Modify: `packages/ribo-core/src/extractor.ts`, `packages/ribo-core/src/queue/relay.ts` (the `ExtractStep` type at :25 and the extract step's patch site), `packages/ribo-core/src/queue/schema.ts` (around :200)
- Test: `packages/ribo-core/src/extractor.test.ts`, `packages/ribo-core/src/queue/relay.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ExtractionResult.usage.engine?: string` (**optional** — `FakeExtractor`, `singleShotExtractor` and `perGroupExtractor` all return `{ calls }` today and a required field breaks every one). `ExtractStep` returns the field map plus an optional engine. The outbox row gains an optional engine column.

- [ ] **Step 1: Write the failing tests.** (a) An extractor reporting an engine, driven through `toExtractStep` and the relay, leaves that engine on the persisted outbox row. (b) An extractor reporting **no** engine still succeeds and leaves the column absent — this is the back-compat case that keeps `FakeExtractor` and the managed path working untouched. (c) The existing relay tests still pass unmodified, proving the widening is additive.
- [ ] **Step 2: Run and watch (a) and (b) fail.** `pnpm vitest run packages/ribo-core`.
- [ ] **Step 3: Implement.** Widen the three types, stop discarding in `toExtractStep`, patch the column where the relay already patches `extracted`. Schema migrations are free here (no users), so no migration shim.
- [ ] **Step 4: Run the tests**, plus `pnpm --filter @azx/ribo-core typecheck`.
- [ ] **Step 5: Commit.**

---

### Task 3: The whitespace loop detector

Isolated from anything async because it is the one piece whose correctness is subtle and whose failure mode is silent. Spec §3.5 and §10.5.

**Files:**
- Create: `packages/ribo-extractor-ondevice/src/loop-detector.ts`, `src/loop-detector.test.ts`
- Create: the package scaffolding (`package.json`, `tsconfig.json`, `tsdown.config.ts`) — folded in here because this task is the package's first deliverable and it cannot be tested without them. The `package.json` **must** define a `typecheck` script or the package silently escapes the gate.

**Interfaces:**
- Produces: a predicate taking the accumulated output string and returning whether it has degenerated — true when the trailing 80 characters are all whitespace. Threshold exported as a named constant so tests and the client share one value.

- [ ] **Step 1: Write the failing tests.** (a) A well-formed pretty-printed JSON extraction response of the shape §10 observed (462–917 chars, ordinary two-space indentation) returns **false** — the no-false-positive case, and the most important test here, because a false positive silently truncates good answers. (b) Content followed by 80+ newlines returns true. (c) Content followed by 80+ mixed spaces-and-newlines returns true, matching the real observed tails. (d) A string shorter than the threshold returns false regardless of content. (e) Exactly 79 whitespace characters returns false and exactly 80 returns true — pin the boundary.
- [ ] **Step 2: Run and watch them fail.** `pnpm vitest run packages/ribo-extractor-ondevice`.
- [ ] **Step 3: Implement** the predicate and the constant.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Commit.**

---

### Task 4: Capability mapping and `prime()`

**Files:**
- Create: `packages/ribo-extractor-ondevice/src/capability.ts`, `src/capability.test.ts`
- Create: `src/test-support/fake-language-model.ts` — the fake `LanguageModel` global every later unit task reuses. Folded in here because this task is its first consumer.

**Interfaces:**
- Produces: `ChatCapability`, a discriminated union of `ready` / `needs-download` / `unavailable` mirroring `TranscriberCapability` **minus `downloadBytes`** (the Prompt API reports progress as a 0..1 fraction with total always 1, so no byte figure exists). A capability probe function over an injected `LanguageModel`-shaped object, and a `prime` function taking a progress callback.
- The fake must model: the four availability values, a `create` that can throw `NotAllowedError`, a monitor emitting `downloadprogress`, and a call counter so tests can assert nothing downloaded.

- [ ] **Step 1: Write the failing tests.** (a) Each of the four availability values maps to the right capability — `available`→ready, `downloadable` and `downloading`→needs-download, `unavailable`→unavailable with a reason. (b) Probing capability performs **no** `create` call at all — assert the fake's create counter is zero. This is the no-background-download rule. (c) `prime()` calls create exactly once and forwards each progress event to the callback. (d) A `NotAllowedError` from create surfaces as a **capability** failure carrying an actionable message about the missing user gesture — not as a generic transport error, because the fix is "call this from a click" and the error must say so. (e) A probe that throws is treated as `unavailable`, never propagated — a probe must not take the caller down (the `Transcriber` contract's rule, carried over).
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests**, plus the package's `typecheck`.
- [ ] **Step 5: Commit.**

---

### Task 5: Session lifecycle

**Files:**
- Create: `packages/ribo-extractor-ondevice/src/session.ts`, `src/session.test.ts`

**Interfaces:**
- Consumes: the fake from Task 4.
- Produces: a session holder that lazily creates one base session carrying the system prompt and few-shot turns, hands out a **clone** per call, and destroys the base after an idle period. Idle timer injectable so tests drive it without sleeping — follow `hedged.ts`'s `ScheduleTimer` pattern rather than inventing a new one.

- [ ] **Step 1: Write the failing tests.** (a) Two sequential calls create the base session **once** and clone **twice** — the clone-per-call rule that prevents group 7 seeing group 1's context. (b) A clone is destroyed after its call, base retained. (c) After the idle period the base is destroyed; the next call creates a fresh one. (d) When availability is not `available`, the lazy create is **not attempted** and the caller gets a capability failure — the lazy path has no user gesture, so attempting it would throw `NotAllowedError` from deep inside a queue drain. (e) Concurrent calls do not each create their own base session.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Commit.**

---

### Task 6: `OnDeviceChat.complete()` — translation, streaming, loop kill

The heart of the package. Spec §3.1 and §3.5.

**Files:**
- Create: `packages/ribo-extractor-ondevice/src/ondevice-chat.ts`, `src/ondevice-chat.test.ts`, `src/index.ts`
- Test: also add the fake's streaming support

**Interfaces:**
- Consumes: Tasks 3, 4, 5. `ChatClient`, `ChatError`, `ChatRequest`, `ChatCompletion` from `@azx/ribo-extractor-openai`.
- Produces: a `ChatClient` implementation plus `capability()` and `prime()`; and a stable engine id constant, mirroring `ONDEVICE_WHISPER_ENGINE`'s naming.
- Behaviour: `system` and few-shot messages become `initialPrompts`; only the final user turn is prompted. `response_format.json_schema.schema` becomes `responseConstraint`. `omitResponseConstraintInput` is set true. **Sampling is left at default** — measured worse with `most-predictable`, and it may be silently ignored anyway. The client consumes `promptStreaming` internally while `complete()` still returns a whole string.

- [ ] **Step 1: Write the failing tests — translation.** (a) A request with system + few-shot + transcript puts system and few-shot in `initialPrompts` and prompts only the transcript. (b) The JSON Schema reaches `responseConstraint` unmodified. (c) `omitResponseConstraintInput` is set. (d) Every returned completion carries a `finishReason` — the contract `chat-client.ts:81` says implementations must honour even though the type marks it optional.
- [ ] **Step 2: Write the failing tests — errors.** Each Prompt API error maps per spec §3.1: `NotSupportedError`→unsupported, `SyntaxError`→malformed, `AbortError`→aborted, `NetworkError`→transport. And the critical one: **a `QuotaExceededError` whose message indicates output truncation surfaces as a *transient* error, not a terminal one.** Assert on the transience explicitly, because `perGroupExtractor` routes truncation to `TerminalQueueError` and that would disable the retry this design depends on. A test asserting it is terminal is the bug, not the fix.
- [ ] **Step 3: Write the failing tests — the loop.** (a) A fake stream emitting content then 80+ whitespace characters is aborted mid-stream and surfaces a **transient** error; assert the underlying stream was actually cancelled, not merely ignored, so a runaway cannot keep generating. (b) A fake stream emitting a normal response completes and returns the whole string. (c) The abort happens without waiting for the output cap — assert the stream was cancelled after the threshold was crossed, not at stream end.
- [ ] **Step 4: Run and watch all three groups fail.**
- [ ] **Step 5: Implement.** Pre-flight: measure prepared input against `contextWindow` and fail with a clear `ChatError` if it does not fit — note `measureContextUsage` ignores `responseConstraint`, so measure the prompt only (§10.2).
- [ ] **Step 6: Run the tests**, plus the package's `typecheck` and `pnpm lint`.
- [ ] **Step 7: Commit.**

---

### Task 7: Give `helixChat` a capability

**Files:**
- Modify: `packages/ribo-extractor-openai/src/helix-chat.ts` (the factory at :98)
- Test: `packages/ribo-extractor-openai/src/helix-chat.test.ts`

**Interfaces:**
- Produces: `HelixChatOptions` gains an optional connectivity source; the factory's return type widens from `ChatClient` to a capability-reporting client. Additive — existing callers touch only `complete()`.

- [ ] **Step 1: Write the failing tests.** (a) With a connectivity source reporting online, capability is `ready`. (b) Reporting offline, `unavailable`. (c) The client **subscribes** and tracks changes — flip the source after construction and the capability follows. A snapshot read at construction is the bug: it goes stale and the composite keeps choosing a dead uplink. (d) With **no** connectivity source supplied, capability is `ready` — the current unconditional behaviour, so nothing existing changes.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.** Do not read `navigator.onLine`; the repo distrusts it for the captive-portal reason recorded in `relay.ts`.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Commit.**

---

### Task 8: The composite extractor

**Files:**
- Create: `packages/ribo-extractor-openai/src/composite-extractor.ts`, `src/composite-extractor.test.ts`
- Modify: `packages/ribo-extractor-openai/src/index.ts`

**Interfaces:**
- Consumes: Task 7's capability-reporting client; Task 2's `usage.engine`.
- Produces: a factory taking an ordered list of `{ engine, chat, extractor }` entries and returning an `Extractor`. It probes each entry's **chat** capability, picks the first `ready`, runs that entry's extractor for the whole extraction, and stamps `usage.engine`. Exposes `invalidate()`. Capability answers are TTL-cached, reusing `first-capable.ts`'s default TTL constant rather than a new number.

- [ ] **Step 1: Write the failing tests.** (a) Managed ready → managed runs, and `usage.engine` names it. (b) Managed unavailable, on-device ready → on-device runs and is named. **Both directions asserted**, because the ordering is inverted relative to the transcriber and reads like a bug; these two tests are what stop someone "correcting" it. (c) An entry whose capability is `needs-download` is **never** selected, even when it is the only entry — that fetch needs a user gesture a queue drain cannot supply. (d) Selection happens **once** per extraction: with seven groups, capability is probed once, not seven times. (e) `invalidate()` causes the next call to re-probe rather than serving the cache. (f) When no entry is selectable, the error is a clear one naming the reason, not a generic failure.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.** Write the inverted-ordering rationale into the file's doc comment, citing the spec section — the code is otherwise indistinguishable from a mistake.
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Commit.**

---

### Task 9: Wire the two delegates, and guard the timing model

**Files:**
- Create: `packages/ribo-extractor-ondevice/src/wiring.test.ts` (or the equivalent in whichever package composes them — keep it beside the composite)
- Modify: whichever module constructs the production extractor pair

**Interfaces:**
- Consumes: Tasks 1, 6, 7, 8.
- Produces: the configured pair — managed on stock defaults (`concurrency: 4`, ceiling 120,000, retries 2); on-device on `concurrency: 1`, ceiling ~15,000, retries 4.

- [ ] **Step 1: Write the failing test — the regression guard.** Assert the on-device delegate's configuration yields a **non-zero** derived retry count, and specifically at least 4. If someone later restores the 120,000 ceiling, or raises concurrency, or trims `stepTimeoutMs`, this test fails. Spec §3.5's entire argument lives or dies on that number being non-zero, and nothing else in the suite would notice it silently going to zero.
- [ ] **Step 2: Write the failing test — worst-case fit.** Assert the on-device delegate's worst case (7 batches × (retries+1) × ceiling + accumulated backoff) fits inside `stepTimeoutMs`, so a future ceiling bump cannot silently exceed the relay's timeout.
- [ ] **Step 3: Run and watch them fail.**
- [ ] **Step 4: Implement the wiring.**
- [ ] **Step 5: Run the tests**, then `./check.sh` for the first full-gate run.
- [ ] **Step 6: Commit.**

---

### Task 10: Browser-mode proof against the real model

Everything so far runs against a fake. This is the first task that touches real Nano.

**Files:**
- Create: `packages/ribo-extractor-ondevice/src/ondevice-chat.browser.test.ts`

**Interfaces:** consumes Task 6.

- [ ] **Step 1: Write the test.** Skip (not fail) when `LanguageModel` is absent or availability is not `available` — CI has no model and must stay green. When present: one real constrained extraction against a small enveloped schema, asserting the response parses, carries every leaf, and every leaf is a well-formed `{value, confidence, sourceSpan}` envelope. Do **not** assert on extracted values — that is content accuracy, which §4 records rather than gates.
- [ ] **Step 2: Run it.** `pnpm vitest run packages/ribo-extractor-ondevice` — confirm it skips cleanly where the model is absent, and passes where present.
- [ ] **Step 3: Add a repeat-count loop** driving the same extraction several times, asserting **all** attempts eventually succeed through the retry path. This is the empirical check that the loop mitigation holds — spec §10.5 measured 20/20, and this is its standing regression.
- [ ] **Step 4: Run again**, confirm stable.
- [ ] **Step 5: Commit.**

---

### Task 11: Playground wiring — the stand-in consumer

`ribo-ui-react` is headless and the real field app is a separate repo, so the playground is where this design gets exercised as a consumer.

**Files:**
- Create: `playground/src/ondevice-extractor-store.ts`
- Modify: `playground/src/extractor-store.ts`, and the panel that renders extraction state
- Test: `playground/src/ondevice-extractor-store.test.ts`

**Interfaces:** consumes Tasks 4, 6, 8. Mirror `whisper-store.ts`'s existing phase machine — it already solves this exact shape for the transcriber, and divergence would be gratuitous.

- [ ] **Step 1: Write the failing tests.** (a) The store reports `needs-download` when the model is absent and `ready` when present. (b) Priming is only reachable through an explicit user action, never an effect — Chrome throws `NotAllowedError` without a gesture, so an effect-triggered prime is broken by construction. (c) An item extracted on-device is flagged so the review UI can badge it.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.** The arming affordance is a real button. Its copy must state that the size is unknown and the wait is minutes — measured 5.4 minutes cold (§10.1) — and must not invent a byte figure, since the API does not provide one.
- [ ] **Step 4: Run the tests**, then `pnpm build:app`.
- [ ] **Step 5: Commit.**

---

### Task 12: Split acceptance run records from baselines

Doc 18 records this gap and spec §4 pulls it into scope: a failing run currently writes nothing, and for a beta model nearly every run fails, so the feature would be unmeasurable.

**Files:**
- Modify: `packages/ribo-adapter-snuggpro/acceptance/` — the gate that writes `baseline.<backend>.json`
- Test: the acceptance harness's own tests

**Interfaces:**
- Produces: every run writes a **run record** regardless of outcome; only a clean pass updates the **baseline**. Run records go somewhere not gitignored, or the gap simply moves.

- [ ] **Step 1: Write the failing tests.** (a) A run with a failing hazard writes a run record and does **not** touch the baseline. (b) A clean run writes both. (c) The run record captures enough to diagnose — per-hazard outcomes, not just a pass/fail bit.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.**
- [ ] **Step 5: Commit.**

---

### Task 13: Score the on-device path against the real corpus

The point of the beta. Until this runs, quality is entirely unmeasured — spec §6.8.

**Files:**
- Create: a browser-mode acceptance runner under `packages/ribo-adapter-snuggpro/acceptance/`
- Do **not** modify `spikes/extraction-snuggpro/score.mjs`.

**Interfaces:**
- Consumes: Tasks 6, 9, 12.
- Produces: result JSON in exactly the shape `score.mjs` already consumes, so it grades on-device output beside the existing codex and claude baselines with no scorer change.

- [ ] **Step 1: Write the failing test.** The runner emits result JSON matching the existing shape for one transcript — assert against the schema the scorer expects, not against extracted values.
- [ ] **Step 2: Run and watch it fail.**
- [ ] **Step 3: Implement the runner**, driving the 13 clean transcripts through the on-device delegate in browser mode. Exclude `02-oil-boiler-basement.txt` — it is byte-identical to the few-shot example and `score.mjs` already excludes it; a runner that silently re-included it would inflate every figure.
- [ ] **Step 4: Run the scorer** over the emitted results. Record hallucination rate, miss rate, enum accuracy and span fidelity beside the existing baselines.
- [ ] **Step 5: Write the findings up** as a numbered doc under `docs/implementation/`, following 18's shape — separate shape conformance from content accuracy, and state plainly what is measured versus argued. Expect the enum-conflation failure §6.8 names; report it rather than smoothing it.
- [ ] **Step 6: Commit.**

---

## Deferred, with reasons

- **Re-measuring on a Surface Go 3** (spec §6.3). The retry budget in Task 9 is sized against a loop rate measured on an M-series laptop. Task 10's repeat loop is the regression, but the *budget* is unvalidated on target hardware. This is a measurement task, not an implementation one — it needs the device.
- **Re-measuring on Edge** (spec §6.6). The API guarantees no interoperability, so every §10 number is Chrome-specific. Edge ships a different model.
- **Sub-group splitting.** No longer needed: schema size does not consume context (§6.1) and retry converges (§10.5). Kept out until something demands it.
- **A throughput/`too-slow` gate.** Deliberately not built — §3.5 explains why demoting has nowhere to fall back to when the network is the reason on-device is running.
- **Moving the `ChatClient` seam out of `ribo-extractor-openai`.** §3.2 accepts the naming wart until a third transport exists.

## Self-review notes

Spec coverage checked section by section. §3.1→Tasks 5–6; §3.2→Tasks 3–6; §3.3→Task 4; §3.4→Tasks 7–8; §3.5→Tasks 1, 3, 6, 9; §3.6→Task 2; §4→Tasks 10, 12, 13; §6.3 and §6.6→deferred above with reasons.

Two things deliberately have no task. §6.4's tab-throttling risk is real but has no implementation until it is observed in the field — recorded in the spec, not designed around. §6.5's multi-tab model contention is a performance unknown the `navigator.locks` claim already makes safe for correctness.

The riskiest task is 6. It carries the translation, the streaming loop kill and the transient classification together, because they are not independently testable — a loop detector with no stream to cancel proves nothing. If it needs splitting during execution, split along error-mapping versus streaming, not along translation versus everything else.
