# Phased Extraction — Wave 6: port `threePhaseExtractor`, tune the on-device preset, retire three unit types

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The strategy the whole design was named after becomes **four** phases. The wrapped-schema fallback — today an error-driven request rewrite inside a retry loop — becomes a phase whose `plan` reads the leaves the classify phase could not handle, which is the narrowing pattern the combinator exists for. The on-device preset gets the two numbers that keep its retries alive, and the three unit types nothing emits any more leave the `ExtractionUnit` union.

**Architecture:** Presence → span → classify → classify-wrapped, all at `concurrency: 1` so the device still sees one call at a time. Each phase's request assembly is today's, moved. The cross-phase state — which leaves are present, which spans survived grounding, which leaves the model could not answer bare — travels in `notes`. Every phase uses the **skip** failure policy, because today's strategy swallows a failed group and continues; the engine's cancellation rule is what stops that from swallowing a cancellation, which today's code gets wrong in one place.

**Tech Stack:** TypeScript, Vitest. No new dependencies.

**Spec:** `docs/roadmap/design/phased-extraction-design.md` (§4.7, §4.2, §4.5)

## Global Constraints

- **`threePhaseExtractor`'s signature is unchanged except its observer's unit type.** `ThreePhaseExtractorOptions` keeps `target`, `chat`, `maxRetries` and `onUnit`.
- **The run goes phase-major**, where today it is group-major: every group's presence call, then every group's span call. This is the ordering change the design accepted when the acceptance bar moved from byte-identity to still-functioning, and it is what makes the narrowing phases possible at all. `concurrency: 1` on every phase keeps the device serial.
- **Every phase uses `onItemFailure: "skip"`.** Today a failed group is nulled and the loop continues. The engine's cancellation rule makes this safe: a cancellation propagates whatever the policy, which fixes a live bug — today's classify path has **no** cancellation check at all, so a transport abort arriving before the caller's signal flips becomes a null leaf with its span retained.
- **A failed classify keeps the leaf's span; a failed presence or span nulls it.** Two different readings of "this item failed" inside one strategy — which is why `merge` interprets outcomes rather than the engine applying a uniform rule. Getting this wrong starves gap-fill, whose candidates are leaves with a null value and a **non-null** span.
- Tests run from the repo root: `pnpm vitest run packages/<dir>/src/<file>.test.ts`.

---

### Task 1: The presence phase

**Files:**

- Create: `packages/ribo-extractor-ondevice/src/phases/presence-phase.ts` and its test

**Interfaces:**

- Produces: `presencePhase<V, P>(options): Phase<V, P>` — `groups` (the walked schema), `chat`, `model`. Produces the presence note key.

**`plan`** returns one item per group, always — presence is the pass that decides what everything else looks at, so it has nothing to narrow against. `describeItem` returns `{ key: group.key }`.

**`run`** builds and makes today's presence call and returns the boolean map for that group, reporting `{ calls: 1, engine: chat.engine }` on `PhaseOutput.usage`. The `engine` stamp matters: today's result carries `usage.engine` and a review card uses it to say which engine produced a draft, and the engine accumulator takes it from the first phase output that reports one.

**`merge` seeds every group with a full null envelope, and this is the task's load-bearing detail.** It stores each group's boolean map in `notes` **and** writes every group's complete leaf set as `value: null, confidence: 0, sourceSpan: null` — for successful items as well as failed ones. Later phases overwrite individual leaves; the seed is the floor.

Without it, a group whose presence map is **all false** has no item in any later phase, and the engine skips `merge` entirely on an empty plan — so no merge would ever write that group. Today every path commits a group result, including that all-false early-out. Ported without the seed, the group's key is simply **missing** from the fields; because the group schemas are `.optional()`, the closing parse then **succeeds silently** with the group absent, and the failure surfaces much later as a `TypeError` when something reads a leaf off it. Presence is the only phase whose `plan` is never empty (the schema walk refuses a zero-group target at construction), so it is the only phase that can own the floor.

**Every merge that writes a group entry applies the array wrap.** A collection group's value is the leaf-envelope map wrapped in a one-element array; a flat group's is the map itself. Today's code does this at its single commit point. With four merges writing group entries, it belongs in one shared helper that all of them use — otherwise three of the four will get it right and the fourth will produce a shape only the closing parse rejects, after every call has been paid for.

**The construction-time refusal moves here.** A group derived at `"row"` or `"none"` provenance granularity has no per-leaf envelope, and this strategy asks for one verbatim span per leaf, so it cannot extract that group. Today `extractGroups` throws at construction with a message naming the group and the leaf and explaining the alternative. Keep that message and keep it at construction — before any call is made.

- [ ] **Step 1: Write the failing tests**

  `plan` returns one item per group regardless of the draft; `run` makes one call and stamps `engine`; `merge` stores the map under the note key; a failed item nulls that group's leaves including their spans; the row/none refusal throws at construction with the group and leaf named.

  **And the two seed pins:** after `merge`, a group whose presence map is **all false** still has a complete null-filled entry in `fields` — the case no later phase can reach; and a collection group's entry is a **one-element array** while a flat group's is the bare map.

- [ ] **Step 2: Run to verify they fail** — Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** — move the existing schema walk, prompt builder and response parser rather than rewriting them.

- [ ] **Step 4: Run to verify they pass, typecheck** — [ ] **Step 5: Commit**

---

### Task 2: The span phase

**Files:**

- Create: `packages/ribo-extractor-ondevice/src/phases/span-phase.ts` and its test

**Interfaces:**

- Produces: `spanPhase<V, P>(options): Phase<V, P>`. `requires` the presence key; produces the spans key.

**`plan`** reads the presence map and returns one item per group **that has at least one present leaf** — the first real narrowing. A group whose leaves are all absent yields no item and therefore no call, which is today's `activeLeaves.length === 0` early-out expressed as planning rather than as a branch.

**`run`** makes today's span call over that group's active leaves only.

**`merge`** applies `isSpanGrounded` against the transcript, stores the **surviving** spans in `notes`, and nulls any leaf whose span is absent or ungrounded — today's unconditional grounding drop, which the measurement behind this strategy credits with taking source-span fidelity to 100%. A failed item nulls that group's leaves.

- [ ] **Step 1: Write the failing tests**

  `plan` yields nothing for a group with no present leaves and one item for a group with some; the item carries only the active leaves; `merge` drops an ungrounded span and nulls that leaf; `merge` keeps a grounded span in the notes; a failed item nulls the group's leaves.

- [ ] **Step 2: Run to verify they fail** — [ ] **Step 3: Implement** — [ ] **Step 4: Run, typecheck** — [ ] **Step 5: Commit**

---

### Task 3: The classify phase, and the wrapped-schema phase it feeds

**Files:**

- Create: `packages/ribo-extractor-ondevice/src/phases/classify-phase.ts` and its test

**Interfaces:**

- Produces: `classifyPhase<V, P>(options)` and `classifyWrappedPhase<V, P>(options)`. Classify `requires` the spans key and produces the unsupported key; wrapped `requires` the unsupported key.

**This is the task the whole design turns on.** Today, a classify call that fails with `ChatError` kind `"unsupported"` triggers a request rewrite _inside_ the retry loop: a wrapped schema, a different structured-output name, continuing attempt numbers under the same unit id. That shape is what the old byte-identity bar made inexpressible. Split across two phases it needs no error-driven rescheduling at all.

**Classify's `run` must not throw on `unsupported`.** It returns a discriminated contribution — a classified value, or a marker saying the model could not answer this schema — and does **not** reject. This is not a trick to dodge the retry loop; it is the honest model. The call succeeded. The transport reported that it cannot constrain output to this schema, which is a fact about the schema, not a transient failure. Throwing would send it through `retryAsync`, where `isTransientFailure` returns true for a `ChatError` carrying no numeric status, so every unsupported leaf would burn its whole retry budget re-sending a request that cannot succeed — four calls per leaf instead of one, before the fallback ever ran.

**Classify's `merge`** sets the value for a classified leaf and records an unsupported leaf in `notes` for the next phase. For a **failed** item — a real failure, not an unsupported marker — it nulls the value and **keeps the span**, unlike presence and span. That difference is load-bearing: gap-fill's candidates are leaves with a null value and a non-null span, so nulling the span here would starve the follow-up pass and strip the citation a reviewer reads.

**`classifyWrappedPhase.plan`** reads the unsupported leaves and returns one item each — no items, no call, no event, which is the empty-plan case. Its `run` makes today's wrapped-schema call with today's suffixed request name. Its `merge` is classify's.

**The catch must be narrow.** `run` rethrows everything that is not `unsupported` — a refusal and a malformed response are retried today and must stay retried, and a branded cancellation must propagate or the engine's cancellation rule is defeated at the one place it matters most. A broad catch here silently re-creates the bug this port is supposed to fix.

**The marker reports `{ calls: 1 }`.** The call was made and today's code counts it; a marker carrying no usage would undercount every unsupported leaf.

**Both phases are one item per leaf**, so `describeItem` returns `{ key: group.key, leaf: leaf.key }`.

- [ ] **Step 1: Write the failing tests**

  `plan` yields one item per grounded leaf and none for a leaf whose span was dropped; `run` returns a value for a normal answer; **`run` returns the unsupported marker without rejecting when the transport reports `unsupported`, and the chat is called exactly once** (the cost pin — a rejecting implementation retries); `merge` sets a classified value; `merge` records an unsupported leaf in the notes; **`merge` keeps the span on a failed item while nulling the value**; `classifyWrappedPhase.plan` yields exactly the recorded leaves and nothing when there are none; its `run` uses the wrapped schema and the suffixed name.

- [ ] **Step 2: Run to verify they fail** — [ ] **Step 3: Implement** — [ ] **Step 4: Run, typecheck** — [ ] **Step 5: Commit**

---

### Task 4: `threePhaseExtractor` becomes the preset, tuned for the device

**Files:**

- Modify: `packages/ribo-extractor-ondevice/src/three-phase-extractor.ts`

**The new body.** Walk the schema as today, then `phasedExtractor({ target, phases: [presence, span, classify, classifyWrapped], concurrency: 1, maxRetries, perCallCeilingMs, delay, onUnit })`. Delete the four retry loops, the four pre-attempt abort checks, the group loop, the emitter, and the local `isCancellation` — the engine owns all of it now.

**Two numbers keep this strategy working, and both are easy to omit.**

`perCallCeilingMs` must be **device-sized**. The default is 120 s, sized for a managed structured-output call; the on-device transport's own bound is `DEFAULT_DEVICE_PROMPT_DEADLINE_MS` (15 s). With the managed ceiling, a classify phase of a dozen-plus leaves at `concurrency: 1` derives to **zero retries** against any plausible share of the step timeout — against today's fixed three. `retry-budget.ts` already warns that an on-device preset must lower the ceiling or derive to zero.

`delay` must be **zero**. `ondevice-extraction-design.md` records, as a surviving lesson from a retired strategy, that backing off is wrong for a degenerate loop — "it should retry immediately" — which is why today's loops have no delay at all. The engine's default is `fullJitterDelay`, and on a transport whose calls complete in seconds the backoff would dominate the run. Pass a delay that ignores its argument and resolves immediately.

`maxRetries` keeps defaulting to `DEFAULT_MAX_RETRIES` (3), and `concurrency` is 1 because a single model session does not benefit from parallel calls.

- [ ] **Step 1: Rewrite the body, widen the observer's unit type, typecheck, commit**

  Do not run the suite yet — Task 5 classifies its failures.

---

### Task 5: Classify and amend every failing test

**Files:**

- Modify: `packages/ribo-extractor-ondevice/src/three-phase-extractor.test.ts`

**Run the suite and read every failure first.** Categories:

1. **Event ordering is phase-major, not group-major.** Any assertion on the sequence across groups changes. `pass` and `phaseId` survive; `pass: 3` is now reachable.
2. **The wrapped fallback is a separate phase.** The test pinning one unit id with continuing attempt numbers across both request shapes is the assertion this port exists to change: the wrapped call is now its own item with its own id at `pass: 3`. Rewrite it to assert the two-phase sequence.
3. **`usage.calls` counts successful items, not attempts** — the same change the previous port named.
4. **The rejection type on caller-abort paths changes.** Today an already-aborted signal rejects with `ChatError` kind `"aborted"`, and a test asserts exactly that. Ported, `retryAsync`'s pre-attempt check throws core's `CancellationError` before the transport is reached — and it is timing-dependent: an abort arriving between attempts _after_ a real failure rethrows **that failure** instead. Amend the aborted-run assertions to go through `isCancellation` rather than naming a concrete class.
5. **The unsupported attempt's event changes from `error` to `done`.** Today the bare attempt that reports `unsupported` emits an error event; ported, `run` returns a marker rather than throwing, so the engine — which emits `error` only for a thrown attempt — emits `done`. The unsupported fact stops being visible in the event stream and travels only in `notes`.
6. **The closing parse's error type changes.** Today a bad merged shape throws a raw `ZodError`; the engine throws a `SchemaParseError` carrying a context prefix.

Two categories the previous ports needed do **not** apply here, and no failure should be filed under them: the observer's unit type is already `ExtractionObserver<PhaseUnit>`, and this suite holds no reference-identity assertions.

**A failure fitting none of these is a real regression — stop and report.**

- [ ] **Step 1: Run the suite; write down every failure and its category**

- [ ] **Step 2: Amend, with a comment on each amended assertion naming its category**

- [ ] **Step 3: Add the assertions nothing currently covers**

  A cancellation **mid-call** rejects rather than resolving with nulled leaves — **the live bug this port fixes**, since today's classify path has no cancellation check. It must be mid-call: the fake observes the abort while the request is in flight. A between-attempts abort rejects through `retryAsync` whether or not `run` forwards `ctx.signal` at all, so a between-attempts test passes against an implementation that drops the signal entirely — which is the regression worth catching. Pin it for a caller-aborted signal and for a transport `aborted` error.

  Also: no backoff delay is taken between attempts (the regression Task 4's `delay` prevents), and the derived retry budget is the requested 3 with the device-sized ceiling. **Note in that test that it holds at the fixture's scale.** The per-phase share is the remaining time divided by the phases left, so at a dozen-plus grounded leaves the share cuts the budget even with the 15 s ceiling. That is the deadline-slicing weakness the design already names, with `onRetryBudget` as its evidence channel — so add a many-leaf case asserting the event fires and names the classify phase, which makes starvation observable rather than silent.

- [ ] **Step 4: Run the package suite** — Expected: PASS.

- [ ] **Step 5: Commit**

---

### Task 6: Retire the three unit types

**Files:**

- Modify: `packages/ribo-core/src/extraction-observer.ts`, `index.ts`, `extraction-observer.test.ts`, and **three** prose references that name the retiring types: `grouped-extractor.ts`, `phased-extractor.test.ts` and `gap-fill.ts`. The mentions inside `instance-fill.test.ts` are historical commentary about how the strategy used to report and are left as history — say so rather than editing them.

**Why now.** `GapFillUnit`, `InventoryUnit` and `InstanceUnit` described three strategies that now emit `PhaseUnit`. Nothing constructs them: a survey found references only in the barrel, the observability type test, and two prose comments. Leaving them would be three exported types describing events the library no longer produces.

- [ ] **Step 1: Remove them from the `ExtractionUnit` union and the barrel**

- [ ] **Step 2: Update `extraction-observer.test.ts`** — its assignability assertions name all three; rewrite them over the surviving units. The test's _purpose_ — that a narrow handler cannot take a wide observer's slot — must survive the edit; do not delete the assertions, re-express them.

- [ ] **Step 3: Fix the two doc comments** — [ ] **Step 4: Typecheck, run the full suite, commit**

---

### Task 7: Changeset and the full gate

- [ ] **Step 1: Add a changeset**

  `@azx/ribo-extractor-ondevice` **major**, `@azx/ribo-core` **major** (three exported types removed). Name: the three retired unit types; phase-major event ordering; the wrapped fallback becoming its own phase with its own unit id; `usage.calls` semantics; the rejection type on caller-abort paths; the unsupported attempt's event moving from `error` to `done`; and the closing parse throwing a `SchemaParseError` rather than a raw `ZodError`. And the fix worth naming as a fix — a cancellation during classification now rejects instead of resolving with silently nulled leaves.

- [ ] **Step 2: Run the full gate** — `./check.sh`, `pnpm docs:build`, `pnpm changeset status --since=origin/main`.

- [ ] **Step 3: Commit**

---

## Out of scope

- Retrofitting `groupedExtractor` or `instance-fill.ts` onto `retryAsync`. Still deliberately carried.
- Guide and README updates — Wave 7.
- The acceptance-gate run — once, after this wave lands, which is the point at which all three ports exist.

## Notes for the reviewer

Three things most worth adversarial attention. First, Task 3's unsupported-as-contribution: whether returning a marker rather than throwing genuinely avoids the retry budget, and whether anything else in the transport's error vocabulary should take the same route. Second, whether phase-major ordering breaks any assumption the on-device model session actually has — the design concedes this argument is reasoned, not measured, and it is the one thing here that a passing suite cannot confirm. Third, whether the skip policy plus the engine's cancellation rule really does fix the classify-path bug, or whether there is still a route by which a cancelled run resolves with nulled leaves.

## Reviewed

Reviewed by OpenCode (`glm-5p3-flash`, run 185e) before implementation. All findings applied.

It verified the four claims this plan rests on rather than taking them: a thrown `unsupported`
genuinely would burn the retry budget (`ChatError` carries a status only for the `http` kind, so
`isTransientFailure` returns true for it), and no other kind should take the marker route; the
failure-policy asymmetry is the right way round; the cancellation bug is live, reachable through a
transport abort with the caller's signal un-fired, and the engine's rule does close it; and the
managed-ceiling arithmetic is right — twelve batches at 120 s exceeds the full step timeout, so the
budget exhausts to zero.

The finding that would have stalled the port: **nobody null-fills a group whose presence map is all
false.** Today every path commits a group result, including that early-out. Ported, such a group has
no item in any later phase and the engine skips `merge` on an empty plan, so no merge covers it — and
because the group schemas are `.optional()`, the closing parse succeeds silently with the key
missing, surfacing later as a `TypeError` on a leaf read. Presence's `merge` now seeds every group's
full null envelope as the floor. The array wrap was also unmentioned, and with four merges writing
group entries it needs to be one shared helper.

Two amendment categories were missing and both would have tripped the stop-and-report rule on a spec
gap rather than a regression: the rejection type on caller-abort paths is no longer always
`ChatError.aborted` (and is timing-dependent), and the unsupported attempt's event moves from
`error` to `done`, which makes that fact event-invisible.

Three smaller corrections: the marker must report `{ calls: 1 }` or the unsupported path undercounts;
`run`'s catch must be narrow, because a broad one re-creates the cancellation bug at the exact site
this port fixes it; and the cancellation test must abort **mid-call**, since a between-attempts abort
rejects through `retryAsync` whether or not `run` forwards the signal at all.

It also caught that my budget pin is fixture-scale — at a dozen grounded leaves the per-phase share
cuts the budget even with the device ceiling — which is the deadline-slicing weakness the design
already names, so the plan now asks for the `onRetryBudget` assertion that makes starvation
observable. Two of my five amendment categories were vacuous for this suite and are now called out
as such rather than left for an implementer to file nothing under.
