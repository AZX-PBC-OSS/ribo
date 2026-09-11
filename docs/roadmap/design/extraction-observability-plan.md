# Extraction observability — implementation plan

**Authority:** `extraction-observability-design.md`. **Read §0 first.** It records eight decisions
taken after the code was read, and four of them contradict the request reproduced below it. A task
that follows the request where §0 overrules it has failed.

**Goal.** One optional progress hook, declared once in `ribo-core`, inherited by every extraction
strategy's options, so a reviewer watching a ten-minute extraction sees each unit of work start and
settle. Plus the three adjacent blind spots §0 confirmed are real: a silently-derived-to-zero retry
budget, a page sweep that announces nothing, and an error handler that cannot tell a recording from
a session.

**Scope.** The extraction seam, the pdf.js document transcriber, and `RelayOptions.onError`. The
outbox and session RxDB schemas are **not** touched — see §0.6 for why the persisted-`kind`
proposal was declined.

**What this does not build.** Mid-generation token progress (`complete()` resolves a whole
completion; a 90-second call is one unit not moving however good `onUnit` is), cost accounting, and
the extraction plan — all three are listed under the design's "Not asked for" and stay there.

---

## Decisions pinned for this increment

**Every hook is a property with a function type, never a method.** `onUnit?: (event: U) => void`,
not `onUnit?(event: U): void`. Interface methods are **bivariant even under `strict`**, so the
method spelling silently accepts a handler narrower than the site it is passed to — which is
exactly the assignment Task 1's type test demands be rejected. The whole contravariance argument in
the design's Ask 1 collapses if anyone "tidies" this into method syntax. The same rule applies to
`onRetryBudget` and `onPage`.

**No behaviour change when a hook is absent.** These are observation points. Every task that adds
one also adds a test proving the path is byte-for-byte unchanged with no callback passed, and every
call site guards with optional-call (`onUnit?.(…)`).

**A hook must never take the caller down.** Documented "Must not throw" on every one, matching
`FirstCapableOptions.onFallback`. We do **not** wrap them in try/catch: the existing precedent
documents the contract and trusts it, and swallowing a handler's throw would hide a consumer bug
inside a library. Follow the precedent; do not invent a second convention.

**No model output in an event.** Identifiers and `usage` only. An event carrying unparsed content
would put it in front of a consumer ahead of the trust boundary `parseWithSchema` exists to be.

**`usage.calls` semantics are not touched.** A ladder running three candidates bills for three
while `usage.calls` reports only the accepted candidate's. That divergence is recorded as
deliberate in `extractor-arbitration-plan.md`. Do not "fix" it here — `onUnit` is precisely what
makes the real call count observable without changing what `usage` means.

**The `Extractor` seam does not change.** `extract(transcript) → ExtractionResult<F>` is unchanged
throughout. Every addition is to an _options_ type.

---

## Global constraints

Every task inherits these.

- ESM-only; `.js` extensions on relative TypeScript imports; `import type` for type-only imports
  (lint-enforced).
- **Verification is light per task, full at the end.** Per task: `pnpm typecheck`, `pnpm lint`,
  `pnpm format:check`, and `pnpm vitest run <the paths you touched>`. Nothing in this plan needs a
  model, a network call or a real transcript — every task is testable with fakes, and a task
  reaching for a real extraction has misread its scope. `./check.sh` runs **once, after the last
  task**.
- **`./check.sh` is not the whole bar here.** `.github/workflows/ci.yml` runs three further steps,
  and **all three are required on every push** — `pnpm docs:build` (this change adds many exported
  symbols carrying `{@link}` targets), `pnpm changeset status --since=origin/main` (pull requests
  only), and `pnpm test:pack-and-consume`. The last is easy to under-call: no package is added or
  renamed here, so it should pass by construction — but it packs real tarballs and builds an app
  outside the repo against the changed public API, and CI runs it regardless. It is on the final
  verification list, not optional.
- The suite is green on this base; **any** failure is yours to explain.
- No new dependencies.
- Comments explain **why**, not what. Keep them terse, and never bake a leaf or group count into
  prose — let the tests pin counts. A comment describing behaviour the code no longer has is a
  defect.
- Every new public symbol is exported from its package's `src/index.ts` **in the task that creates
  it**, with a short comment saying why it lives there.
- Commit in small pieces as you go. A run that leaves everything uncommitted produced nothing.
- One changeset for the whole change, written in Task 11 — **major**, naming each narrowed set, so
  a consumer's compile error arrives with its explanation.

---

## Task 1 — The observer vocabulary in `ribo-core`

**Files:** create `packages/ribo-core/src/extraction-observer.ts` and
`packages/ribo-core/src/extraction-observer.test.ts`; modify `packages/ribo-core/src/index.ts`.

**Intent.** The whole vocabulary, with nothing calling it yet. Pure types plus two tiny pure
functions, testable with plain objects.

**Interfaces.**

A private `UnitBase` carries what every unit has whatever divided the work: an opaque `id` stable
across this unit's `start` and its `done`/`error`; a `phase` of `"start" | "done" | "error"`; an
`attempt` that is `1` on the first try and is the only way a retry is observable at all; an
optional `strategy` naming the composing strategy when one is running; an optional `usage` of
`{ inputTokens, outputTokens }` on `"done"`; and an optional `error` on `"error"`. Every member
`readonly`.

Six exported variants intersect `UnitBase` with a `unit` tag and their own required fields —
required where they apply, absent where they do not, so `switch (event.unit)` narrows and there is
nothing to guess:

- `WholeUnit` — `unit: "whole"`. The document in one call. No further fields.
- `GroupUnit` — `unit: "group"`, plus `key`, `part`, `parts`. One group, or one part of a
  partitioned group. **An unpartitioned group reports `part: 1, parts: 1`**, never omission — a
  consumer must not need two code paths for "one part" and "several".
- `InventoryUnit` — `unit: "inventory"`. The house-wide roster pass. No further fields.
- `InstanceUnit` — `unit: "instance"`, plus `key`, `instance`, `instances`, `part`, `parts`. One
  instance's fill. **`part`/`parts` are here per §0.2** and follow `GroupUnit`'s convention.
  `instance` is 1-based for the same reason `part` is.
- `PhaseUnit` — `unit: "phase"`, plus `pass` (`0 | 1 | 2` — presence, quote, classify), `key` (the
  group), and `leaf?` (phase 2 only, one leaf per call).
- `GapFillUnit` — `unit: "gapfill"`, plus `candidates` (how many abstained-with-evidence leaves the
  follow-up asks about). **Per §0.1.**

`ExtractionUnit` is the union of all six. Export the variants individually as well as the union —
the type parameter names them, so they have to be nameable.

`ExtractionObserver<U extends ExtractionUnit = ExtractionUnit>` declares exactly one member:
`onUnit`, optional, **a property with a function type** taking `U` and returning `void`, documented
"Must not throw." The default parameter keeps the general case general.

Two functions:

- `nextUnitId()` returns a fresh opaque id, unique for the lifetime of the module. A monotonic
  counter is enough. It is deliberately opaque and deliberately **not** derived from a group key or
  a response-schema name: the structured fields are how a consumer identifies a unit, and an id
  that looked parseable would invite exactly the coupling this hook exists to remove. It is
  process-global rather than per-extractor so that ids from two tiers of one ladder cannot collide.
- `stampStrategy(strategy, onUnit)` returns an `onUnit` that copies each event with `strategy` set,
  or `undefined` when handed `undefined`. Generic in `U`, so it preserves a narrow set. This is
  what `instanceLadder` uses in Task 5 and what a hand-rolled ladder uses to get the same
  attribution — see §0.3.

**Must-fail tests.** Write these first and watch each one fail.

_Runtime._ `nextUnitId()` returns a different value on each call. `stampStrategy` sets `strategy`
on a forwarded event and mutates nothing else about it; handed `undefined` it returns `undefined`
(so an extractor threading an absent observer stays absent, not a no-op function).

_Type-level — these are the heart of the task, and each `@ts-expect-error` **is** the assertion._
Follow the convention in `restrict-to-kind.test.ts` and `adapter.test.ts`: if a directive flips to
"unused '@ts-expect-error' directive" (TS2578) the guarantee is gone and the test fails loudly.

1. A handler typed `(e: ExtractionUnit) => void` is assignable to `ExtractionObserver<GroupUnit>`,
   to `ExtractionObserver<WholeUnit>`, to `ExtractionObserver<InventoryUnit | InstanceUnit>`, to
   `ExtractionObserver<PhaseUnit>`, to `ExtractionObserver<GapFillUnit>` and to the default. One
   broad handler, every site. Assert with `expectTypeOf`, not a comment.
2. A handler typed `(e: GroupUnit) => void` is **rejected** by `ExtractionObserver<ExtractionUnit>`.
   `@ts-expect-error`. **This is the test that catches method syntax** — under `onUnit?(…): void`
   it compiles, the directive becomes unused, and TS2578 fails the build. Say so in a comment above
   it so nobody deletes the directive to "fix" the error.
3. Inside a handler typed for `ExtractionObserver<GroupUnit>`, reading `event.key`, `event.part`
   and `event.parts` compiles, and `event.instance` does not (`@ts-expect-error`). A `case
"instance"` at a `GroupUnit` site is a compile error, not dead code.
4. **A `WholeUnit` literal carrying a `part` does not compile** (`@ts-expect-error`), and neither
   does a `GroupUnit` literal missing one. This is the design's "Done means" clause: the fields are
   required where they apply and absent where they do not, so the union genuinely narrows rather
   than being one flat shape with four fields that are meaningless three-quarters of the time.
5. `switch (event.unit)` over the full `ExtractionUnit` union narrows each arm to its own fields,
   and an exhaustive switch assigning the default arm to `never` compiles. Add a one-line comment
   recording the caveat the design names: a single-variant `U` is an intersection, not a union, so
   this `never` idiom does **not** apply at a narrow site — the fields are read directly there,
   which is the point.

**Commit.** `feat(core): ExtractionObserver, the six unit variants, and the id/strategy helpers`.

---

## Task 2 — Hoist the retry-budget derivation into core

**Files:** create `packages/ribo-core/src/retry-budget.ts` and
`packages/ribo-core/src/retry-budget.test.ts`; modify `packages/ribo-core/src/index.ts`,
`packages/ribo-extractor-openai/src/per-group.ts`,
`packages/ribo-extractor-openai/src/instance-fill.ts`,
`packages/ribo-extractor-openai/src/per-group.test.ts`.

**Intent.** §0.4. One derivation, one worst-case-backoff helper, one event shape — before Task 3
adds a hook to it and creates a third copy. This task is a **pure move with no behaviour change**:
the existing `per-group.test.ts` derivation assertions are the regression gate and **are not
edited** beyond their import path. If one needs its expected value changed, you have changed
behaviour and the task has failed.

**Interfaces.**

`RetryBudget` is the readonly event interface, exactly as the design's Ask 3 gives it:
`requested`, `derived`, `batches`, `perCallCeilingMs`.

`RetryBudgetObserver` is the shared options mixin, declaring one optional property-typed
`onRetryBudget` taking a `RetryBudget`, documented "Called when the retry budget had to be reduced
to fit the step timeout. Must not throw." It also declares `requireRetryBudget?: boolean`,
defaulting to `false` — see §0.5, and Task 3 for what turns it on.

`maxAccumulatedBackoff(retries, baseMs, capMs)` moves across unchanged, including its clamp of the
exponent at 32. Keep the existing comment explaining that the real delay is always at or under this
and that the derivation uses the worst case so the step timeout is never exceeded by backoff alone.

`deriveRetryBudget({ requested, batches, stepTimeoutMs, perCallCeilingMs, baseMs, capMs })` returns
a `RetryBudget` rather than a bare number. Returning the event shape is the point: the caller
reports `derived` to its retry loop and hands the same object to `onRetryBudget`, so the number
that governs the run and the number the consumer is told can never disagree. The algorithm is
unchanged — decrement from `max(0, requested)` until
`batches * ((r + 1) * perCallCeilingMs + maxAccumulatedBackoff(r, …))` fits `stepTimeoutMs`,
floor 0.

`PER_CALL_CEILING_MS` (120,000) is defined once in core and re-exported where the two extractors
used their own copies. Its comment stays: this is a physical assumption about call latency, not an
arbitrary retry count.

Both extractors delete their local copies and call the core one. `deriveMaxRetries` is **not** in
`ribo-extractor-openai`'s public index (only `per-group.ts` exports it, and only its own test
imports it), so nothing published changes name. Do not leave a re-export behind.

**Must-fail tests.** A new `retry-budget.test.ts` asserting: the documented default case (15-minute
step timeout, 4 concurrency, 7 groups, 2 requested, 120 s ceiling) derives 2 and reports
`requested: 2, derived: 2`; a step timeout too tight for even one attempt derives 0; a
`requested: 0` derives 0 without looping; the returned `batches` and `perCallCeilingMs` echo the
inputs. Then move the existing `per-group.test.ts` derivation cases over as-is and confirm they
still pass **against the moved function** — that is the no-behaviour-change proof.

**Commit.** `refactor(core): one retry-budget derivation, returning the event shape`.

---

## Task 3 — `perGroupExtractor` emits `GroupUnit`, and reports its budget

**Files:** modify `packages/ribo-extractor-openai/src/per-group.ts` and
`packages/ribo-extractor-openai/src/per-group.test.ts`.

**Intent.** The busiest strategy and the one a real Manual J spends most of its ten minutes in — 16
units on the real target.

**Interfaces.** `PerGroupOptions<V, P>` extends `BackoffOptions`, `ExtractionObserver<GroupUnit>`
and `RetryBudgetObserver`.

Emission sits **inside** the retry loop, around the chat call, not around the pooled work item:
mint one `id` per prepared entry before the loop, then per attempt fire `start` with
`attempt: attempt + 1`, and on settle fire `done` (with `usage` mapped from the completion's
`promptTokens`/`completionTokens`) or `error` (carrying the thrown value). Same `id` across every
attempt of one entry; `attempt` is what distinguishes them. A terminal failure, an abort by a
sibling, and an exhausted budget each end as an `error` event — those are the failures that are
currently invisible.

`key` is `group.key`, which is the empty string for the non-grouped fallback. That is honest and
documented, not a defect: the schema had no groups to split. `part` is `(group.part ?? 0) + 1` and
`parts` is `group.parts ?? 1` — the internal representation is 0-based and optional, the event is
1-based and always present.

The budget: call `deriveRetryBudget` at construction, fire `onRetryBudget` when `derived <
requested`, and when `requireRetryBudget` is set and `derived === 0` while `requested > 0`, throw a
plain `Error` at construction naming `stepTimeoutMs`, `perCallCeilingMs` and `concurrency` — the
three knobs that fix it. A construction-time throw never reaches the queue, so it is not a
`TerminalQueueError`.

**Must-fail tests.**

- A two-group target with a fake chat emits, per group, a `start` then a `done`, with `part: 1,
parts: 1` on both and the two groups' `key`s distinct.
- A group that fails transiently once then succeeds emits `start(1)`, `error(1)`, `start(2)`,
  `done(2)` — **the same `id` on all four**, which is the assertion that proves `attempt` is the
  only way a retry is observable.
- A partitioned group (drive it by setting `maxNullableUnionsPerGroup` low enough to force a split;
  do not hardcode the resulting count in a comment) emits units carrying `part: 1, parts: 2` and
  `part: 2, parts: 2`.
- A terminal failure emits exactly one `error` event and no retry `start`.
- `done` carries `usage.inputTokens`/`outputTokens` from the completion, and omits `usage` when the
  fake reports none.
- A target whose schema is not an object of groups emits one unit with `key: ""`.
- With `onUnit` absent, an identical run produces an identical `ExtractionResult` and an identical
  chat-call sequence. Assert against a recorded request log, not just the fields.
- `onRetryBudget` fires with `{ requested: 5, derived: 0, … }` for a step timeout that admits no
  retries, and does **not** fire when the requested budget survives intact.
- With `requireRetryBudget: true` and a step timeout that derives 0, construction throws and the
  message names all three knobs. With it absent, construction succeeds — the default-unchanged
  proof for §0.5.

**Commit.** `feat(extractor-openai): per-group progress units and a visible retry budget`.

---

## Task 4 — `scopedInstanceExtractor` emits `InventoryUnit` and `InstanceUnit`

**Files:** modify `packages/ribo-extractor-openai/src/instance-fill.ts` and
`packages/ribo-extractor-openai/src/instance-fill.test.ts`.

**Intent.** Tier 1 — the inventory pass, then each `(group, instance, piece)` fill.

**Interfaces.** `ScopedFillOptions<V, P>` extends `BackoffOptions`,
`ExtractionObserver<InventoryUnit | InstanceUnit>` and `RetryBudgetObserver`.

The inventory pass emits one unit: `start` before `inventory(transcript)`, then `done` or `error`.
`attempt` is always 1 — there is no retry loop around it. It carries **no `usage`**: `inventory` is
a caller-supplied function returning a `Roster`, not a completion, so its cost never reaches this
extractor. That is the same gap `instance-fill.ts` already documents where it counts the inventory
call in `usage.calls` but not in the token totals; do not paper over it by inventing a zero.

Each `FillJob` emits an `InstanceUnit` per attempt, with the same one-id-per-job,
`attempt`-distinguishes-retries discipline as Task 3. `key` is the group key; `instance` is
`job.instanceIndex + 1` and `instances` is that group's current-candidate count; `part`/`parts`
follow Task 3's 1-based convention off `group.part`/`group.parts`. A **singleton** group and the
non-grouped fallback each report `instance: 1, instances: 1` — one code path for the consumer, per
Task 1's `part` reasoning.

The budget derives **per `extract()`**, after the roster is back, because the job count is not known
until then. Fire `onRetryBudget` there. When `requireRetryBudget` is set and it derives to zero,
throw a `TerminalQueueError` from `extract()` — no retry fixes a configuration error, and the queue
should reach `dead` rather than burn its whole attempt budget rediscovering that. Document the
timing difference from Task 3 in the option's doc comment: one throws at construction, one cannot.

**Must-fail tests.**

- A roster with one collection group of two current candidates emits: one `inventory` start/done
  pair, then two `instance` units with `instance: 1` and `instance: 2`, both `instances: 2`.
- A group whose roster says `stated: "none"` makes no fill call and emits no `instance` unit for it
  — the `statedEmptyGroups` path stays silent, matching that it costs nothing.
- A failing `inventory` emits `inventory` `start` then `error`, and no `instance` units at all.
- A partitioned tier-1 group emits two units for the **same** `(key, instance)` differing only in
  `part` — the assertion that §0.2 was necessary.
- A singleton group reports `instance: 1, instances: 1`.
- With `onUnit` absent, an identical run produces an identical result and call sequence.
- `onRetryBudget` fires from `extract()`, after the roster, carrying the job-derived `batches`.
- With `requireRetryBudget: true` and a deriving-to-zero configuration, `extract()` rejects with a
  `TerminalQueueError`; with it absent, `extract()` succeeds.

**Commit.** `feat(extractor-openai): inventory and per-instance progress units`.

---

## Task 5 — `instanceLadder` threads the observer and attributes each tier

**Files:** modify `packages/ribo-extractor-openai/src/instance-ladder.ts` and
`packages/ribo-extractor-openai/src/instance-ladder.test.ts`; create
`packages/ribo-core/src/composite-observer.test.ts`.

**Intent.** Ask 2 — the important half, and the easy half to miss. Read §0.3 before starting; the
request's premise about `fallbackExtractor` is wrong and this task is where that matters.

**Interfaces.** `InstanceLadderOptions<V>` extends `ExtractionObserver` at the **default**
parameter: a composite's own `U` is the union of its candidates', and tier 1 emits inventory and
instance units while tiers 2 and 3 emit group units.

`instanceLadder` passes its `onUnit` into each tier it constructs, wrapped in
`stampStrategy(tierId, onUnit)`, so every unit arrives carrying `strategy: "tier1" | "tier2" |
"tier3"` and is attributable without the consumer tracking state. A tier's own explicitly-supplied
`onUnit` in its options object must not be silently dropped — if both are present, the ladder's
wins and the tier's is called too; assert both fire. Threading is by option merge, so an
`onUnit` already on `tier1` and the ladder's are composed rather than one overwriting the other.

`fallbackExtractor`, `raceExtractor` and `compositeExtractor` are **unchanged**. Their existing
suites are the regression gate and are not edited.

**Must-fail tests.**

In `instance-ladder.test.ts`:

- A ladder whose tier 1 fails and tier 2 succeeds emits tier 1's inventory/instance units stamped
  `strategy: "tier1"` **and** tier 2's group units stamped `strategy: "tier2"`. This is the
  assertion that fails if the threading is missed.
- Every event a tier emits carries a `strategy`; none arrives unstamped.
- A tier configured with its own `onUnit` **and** run under a ladder with one: both handlers see
  the event, and the ladder's copy is stamped.
- With the ladder's `onUnit` absent, tiers behave identically and any tier-level `onUnit` still
  fires.

In `composite-observer.test.ts` — this is the design's required composite-forwarding test, written
against the corrected premise:

- A `fallbackExtractor` wrapping two fake extractors that each emit units through an observer the
  **caller** configured must deliver every inner unit to the caller, not only the composite's own
  attempts. Assert on the count and the unit tags. Above it, a comment recording §0.3: the
  composite forwards nothing because it intercepts nothing — the candidates were built with the
  observer already — and `stampStrategy` is how attribution is recovered.
- `stampStrategy` applied by hand to two candidates of a `fallbackExtractor` produces the same
  attribution `instanceLadder` produces internally.

**Commit.** `feat(extractor-openai): thread and attribute progress units through the ladder`.

---

## Task 6 — `singleShotExtractor` and `gapFillExtractor`

**Files:** modify `packages/ribo-extractor-openai/src/single-shot.ts`,
`packages/ribo-extractor-openai/src/single-shot.test.ts`,
`packages/ribo-extractor-openai/src/gap-fill.ts`,
`packages/ribo-extractor-openai/src/gap-fill.test.ts`.

**Intent.** The two single-call strategies. Landed together because each is a handful of lines and
neither has a retry loop.

**Interfaces.** `SingleShotOptions<V, P>` extends `ExtractionObserver<WholeUnit>`.
`GapFillOptions<V>` extends `ExtractionObserver<GapFillUnit>` — the sixth variant, per §0.1.

Single-shot emits exactly one unit per `extract()`: `start` with `attempt: 1`, then `done` with the
completion's usage or `error`. There is no retry loop, so `attempt` is always 1 and that is the
honest report.

Gap-fill emits its unit **only on the follow-up path**. With no abstained-with-evidence candidates
it makes no call, and the design's own file header pins that the base result passes through
untouched: no second call, no wrapper object, no usage change. Emitting a phantom unit there would
be a behaviour change in the one direction the non-negotiables forbid. `candidates` is the count of
leaves the follow-up asks about.

Gap-fill is also a composite in the §0.3 sense — it wraps a `base` extractor it is handed
already-built, so the base's units flow through the observer the caller gave the base. Say so in a
comment; a reader arriving from Ask 2 will look for threading that cannot exist here.

**Must-fail tests.**

- Single-shot emits one `start` and one `done`, `attempt: 1` on both, same `id`, `usage` mapped
  from the completion.
- A single-shot whose call throws emits `start` then `error` carrying the thrown value.
- Gap-fill with two abstained-with-evidence leaves emits one unit with `candidates: 2`.
- **Gap-fill with zero candidates emits nothing at all** and makes no chat call — assert both.
- Gap-fill over a base built with its own `onUnit` delivers the base's units and its own, in that
  order.
- With `onUnit` absent, both produce identical results and call sequences.

**Commit.** `feat(extractor-openai): whole-document and gap-fill progress units`.

---

## Task 7 — `threePhaseExtractor` emits `PhaseUnit`, and the internal `onCall` retires

**Files:** modify `packages/ribo-extractor-ondevice/src/three-phase-extractor.ts` and
`packages/ribo-extractor-ondevice/src/three-phase-extractor.test.ts`.

**Intent.** The fifth variant, and the longest-running loop in the library: phase 2 classifies
**one leaf at a time**, so on a document with hundreds of grounded spans this is the loop a
reviewer would most want to watch. Read §0.7 first — `onCall` is not a public option and never was.

**Interfaces.** `ThreePhaseExtractorOptions<V, P>` extends `ExtractionObserver<PhaseUnit>`.

The four phase helpers currently take `onCall: () => void`, threaded from a local `recordCall`
closure purely to count calls. Replace that parameter with a single internal emitter the extractor
constructs per `extract()`, which both increments the counter and fires `onUnit`. The count then
**derives from the observer** rather than sitting beside it, which is the whole of "retire
`onCall`": there is exactly one mechanism, and it is the better-informed one. `usage.calls` must
report the same number it reports today.

Emission: `extractPresence` emits `pass: 0` with the group's `key`; `extractSpans` emits `pass: 1`
with the same; `classifyLeaf` emits `pass: 2` with `key` and `leaf`. One `id` per logical unit,
`attempt` incrementing across the helper's retry loop.

`classifyWrapped` is the same leaf asked a second way after an `unsupported` error, not a new unit
— pass the leaf's `id` and its running attempt count into it so the escalation reads as continued
attempts on one unit rather than a second unit appearing from nowhere.

Every failed attempt emits an `error`. This matters more here than anywhere else in the plan:
`threePhaseExtractor` **swallows** phase 0 and phase 1 failures, filling the group with nulls and
continuing, and `classifyLeaf` returns `null` after exhausting its budget. Those are today's
silent failures — a group that produced nothing looks identical to a group with nothing to say.
The `error` events are what make them visible, and they must fire even though the extractor goes
on to succeed.

`usage` on `done` only if the on-device completion reports it; `ChatCompletion.usage` is optional
and the on-device transport generally omits it. Omit rather than invent.

**Must-fail tests.**

- A two-group target where every leaf is present emits, per group, one `pass: 0` unit, one `pass: 1`
  unit, and one `pass: 2` unit per active leaf, each `pass: 2` unit carrying its own `leaf`.
- A `pass: 0` unit carries no `leaf`.
- A group whose presence call fails every attempt emits `maxRetries + 1` `error` events for that
  unit and no `pass: 1` or `pass: 2` units for it — **and `extract()` still resolves**, proving the
  swallowed failure is now visible without changing that it is swallowed.
- A leaf whose bare classify hits `unsupported` and succeeds wrapped emits its attempts under one
  `id`, with the attempt numbers continuing rather than restarting.
- `usage.calls` after a run equals the number of `start` events. This is the assertion that the
  count derives from the observer.
- With `onUnit` absent, an identical run produces an identical result and an identical
  `usage.calls`.

**Commit.** `feat(extractor-ondevice): three-phase progress units, replacing the internal call
counter`.

---

## Task 8 — `onPage` on the pdf.js document transcriber

**Files:** modify `packages/ribo-transcriber-pdfjs/src/pdf-text.ts`,
`packages/ribo-transcriber-pdfjs/src/config.ts`,
`packages/ribo-transcriber-pdfjs/src/index.ts`,
`packages/ribo-transcriber-pdfjs/src/pdf-text.browser.test.ts`.

**Intent.** Cheap and separate. `readText()` is a `for (let i = 1; i <= doc.numPages; i++)` sweep
that emits nothing, while `pageCount` is documented "free once open" — so the total is known before
the loop starts. On a 35-page report that is real, currently invisible progress.

`@azx/ribo-transcriber-managed-docs` is deliberately **not** touched: it is one HTTP call returning
every page at once, so it has no per-page loop to observe. Say so in a comment where a reader would
look for the parallel.

**Interfaces.** A readonly `PageRead` interface: `page`, `of`, and `chars` — non-whitespace
characters this page yielded. `onPage?: (event: PageRead) => void`, a property with a function
type, documented "Called after each page is read. Must not throw."

It goes on `OpenDocumentOptions`, so `openDocument`, `readDocumentText` and the `PdfjsTranscriber`
constructor all inherit it, and on `PdfjsTranscriberOptions` so a host wiring the transcriber can
pass one. `readDocumentText` forwards it untouched.

`chars` earns its place beyond a progress bar: a scanned insert in an otherwise text-layer PDF
shows up as a run of zero-character pages, worth surfacing **before** the whole-document
`no-text-layer` threshold decides. So `chars` counts the laid-out page text with whitespace
stripped and **excluding the page marker** — the marker is ours, and counting it would floor every
page at a non-zero number and destroy exactly the signal the field exists for.

**Must-fail tests.** These belong in the browser project alongside the existing pdf.js tests.

- A three-page fixture fires `onPage` three times with `page: 1, 2, 3` and `of: 3` on each.
- Each event's `chars` matches the page's own non-whitespace character count and **excludes** the
  page marker — assert a genuinely empty page reports `chars: 0`, which is the whole point.
- `onPage` fires before `readDocumentText`'s `no-text-layer` guard throws, so a scanned document
  still reports its pages before it is rejected.
- With `onPage` absent, `readText()` returns identical text.

**Commit.** `feat(transcriber-pdfjs): per-page read progress`.

---

## Task 9 — Tag `ExtractionOutcome`

**Files:** modify `packages/ribo-core/src/arbitration.ts`,
`packages/ribo-core/src/arbitration.test.ts`, `packages/ribo-core/src/composite-extractor.ts`,
`packages/ribo-core/src/index.ts`.

**Intent.** §0.8. The reason a unit event is tagged on `unit` is that `switch` narrowing makes a
consumer's job mechanical; `ExtractionOutcome` is the one exported union in this area with a
documented near-miss from not having a tag. **`ArbiterVerdict` is deliberately left alone** — its
three arms already carry three distinct required key names and narrow correctly under `in`, and
retagging would rewrite every arbiter in the repo for no new safety. Record that in a comment where
`ArbiterVerdict` is declared so it is not re-opened.

**Interfaces.** `ExtractionOutcome<F>` gains a required `outcome: "result" | "error"` discriminant
on both arms, keeping the existing `?: never` members — belt and braces, and removing them would
weaken the exclusivity the tag is being added to strengthen. `ResultOutcome<F>` and
`ErrorOutcome<F>` become `Extract<…>` on the **tag** rather than on a property name, which is the
whole gain: the aliases stop being the manual version of what a tag does.

`resultOutcome()` and `errorOutcome()` stamp the tag; they are already the documented construction
path. The two module-private guards in `arbitration.ts` and the two duplicated in
`composite-extractor.ts` become tag comparisons.

The long comment explaining why discrimination is on the `result` **value** and never on key
presence must be **rewritten, not deleted**. It records a real bug — an error outcome written
`{ candidate, error, result: undefined }` read as a SUCCESS under `"result" in outcome`, and
`terminalFallsThrough` then returned `{ accept: undefined }`, accepting a result that does not
exist and swallowing the error. That history is why the tag exists; keep it and add the new
conclusion.

`applyVerdict`'s identity comparison against `verdict.accept` stays, and so does its
narrow-to-result-outcomes-first ordering. Both are load-bearing for an arbiter that accepts
`undefined`, and the tag does not replace either.

**Must-fail tests.** The existing `arbitration.test.ts` suite is the regression gate — including
the test pinning the `result: undefined` near-miss, which must still pass. Add: an outcome built
through `resultOutcome()` carries `outcome: "result"`; `switch (outcome.outcome)` narrows each arm
to its own members with no cast; `Extract<ExtractionOutcome<F>, { outcome: "result" }>` is
`ResultOutcome<F>` (`expectTypeOf`); and an inline object literal missing the tag is rejected
(`@ts-expect-error`), which is what makes the constructors the only path.

**Commit.** `refactor(core)!: tag ExtractionOutcome on its own discriminant`.

---

## Task 10 — A tagged subject on `RelayOptions.onError`

**Files:** modify `packages/ribo-core/src/queue/relay.ts`,
`packages/ribo-core/src/queue/relay.browser.test.ts`,
`packages/ribo-core/src/queue/index.ts`, `packages/ribo-core/src/index.ts`.

**Intent.** §0.6. Today `onError(error, item: OutboxItem | SessionItem)` hands over a bare union
whose arms are told apart only by probing for `audioReady` — an error handler that cannot tell a
recording from a session is a real gap. **Read §0.6 before starting: the persisted-`kind` route was
considered and declined, and no RxDB schema, version or migration is touched by this task.** If you
find yourself editing `sessionRxSchema` or `outboxRxSchema`, stop.

**Interfaces.** A `RelaySubject` union with two arms — `{ kind: "recording", item: OutboxItem }`
and `{ kind: "session", session: SessionItem }` — both readonly, exported from core.
`RelayOptions.onError` becomes `(error: unknown, subject: RelaySubject) => void`. The relay builds
the tag at each call site, where the two are already distinguishable; nothing is inferred and
nothing is stored.

Each arm names its payload for what it is (`item` / `session`) rather than sharing one key, so a
`switch (subject.kind)` reaches a correctly-typed document with no cast.

This is breaking for `onError` consumers, which is permitted. The changeset must name it.

**Must-fail tests.** In `relay.browser.test.ts`, alongside the existing error-path coverage: a
failing recording step calls `onError` with `kind: "recording"` and the outbox item; a failing
session extract calls it with `kind: "session"` and the session document; a failing session write
does the same. Plus a type-level assertion that `switch (subject.kind)` reaches `subject.item.id`
in one arm and `subject.session.ref` in the other with no cast, and that reaching for
`subject.session` in the recording arm is a compile error (`@ts-expect-error`).

**Commit.** `feat(core)!: tag the subject handed to RelayOptions.onError`.

---

## Task 11 — The stage-transitions answer, the changeset, and full verification

**Files:** modify `docs/roadmap/design/extraction-observability-design.md`,
`docs/implementation/03-ribo-core.md`, `AGENTS.md`; create `.changeset/extraction-observability.md`.

**Intent.** The design's closing question is not an ask but a request for a documented answer:
"how should a non-queue consumer observe stage changes?" — and it belongs "where a host will read
it before repeating our mistake."

**The answer, having seen the code: use the queue.** The relay already owns that state machine
(`queued → transcribing → extracting → awaiting-review → writing → done`), persisted in the outbox
and the session document, and a consumer that skips the queue throws it away along with durability.
Building a second, in-memory stage mechanism beside it would give a host two sources of truth for
one fact, and the in-memory one loses on every reload.

The reason that answer is now worth writing down rather than assuming is the one the design
supplies: a reviewer at a desk has no offline-capture problem, so the queue looked optional — but
**a ten-minute extraction that dies on an accidental page refresh is a real problem**, and that is
a desk problem. `onUnit` is progress _within_ a stage and is deliberately not durable; the queue is
what makes the stage itself survive a reload. Write that distinction explicitly — it is the sentence
that stops the next host from reaching for the wrong one.

Add the answer as a section of the design doc, a short pointer from `docs/implementation/03-ribo-core.md`
where the relay state machine is described, and one line in AGENTS.md §1 so it is reachable from
the first thing anyone reads.

**The changeset** is **major** for `@azx/ribo-core`, `@azx/ribo-extractor-openai`,
`@azx/ribo-extractor-ondevice` and `@azx/ribo-transcriber-pdfjs`. It must name **each narrowed
set** — which extractor's options declare which units — because a consumer's compile error should
arrive with its explanation, and it must call out the two genuinely breaking changes:
`ExtractionOutcome`'s tag and `onError`'s tagged subject. Note that widening an extractor's
declared unit set later is itself a major change, and say why: that exposure is accepted, localised
to the extractors that gained an event rather than every consumer that switches.

**Verification.** Run, in order, and paste each summary line rather than asserting success:

1. `./check.sh` — the everyday bar.
2. `pnpm docs:build` — typedoc entry points and every new `{@link}` target.
3. `pnpm changeset status --since=origin/main` — every changed package has a changeset.

4. `pnpm test:pack-and-consume` — real tarballs installed into an app outside this repo, built and
   driven for real. CI runs it on every push, so it is required here rather than optional. It
   should pass by construction, since no package is added, renamed or removed — but that is a
   prediction, and this step is what turns it into a result.

**Commit.** `docs: record the stage-transitions answer and the observability changeset`.

---

## Report back

The design asks five questions. Four are answered in §0 before a line is written — they were
settled by reading the code, and the answers are 0.1 (a sixth variant), 0.3 (the
`fallbackExtractor` premise), 0.5 (`derived === 0` is an event) and 0.8 (`ExtractionOutcome` yes,
`ArbiterVerdict` no). The fifth is Task 11's stage-transitions answer.

What is genuinely still open until the tasks run, and must be reported when they do:

- **Whether the per-extractor `U` held up once every call site was typed** — specifically whether
  any extractor's real emissions did not match the set its options claim. §0.2 is one such
  mismatch found at planning time; Tasks 3, 4, 6 and 7 are where the rest would surface.
- **Whether `attempt` reads honestly at every site.** Single-shot and the inventory pass have no
  retry loop and always report `1`; `classifyWrapped` continues a leaf's attempt count across an
  escalation. If either reads as a lie in the test output, say so rather than smoothing it.
- **Whether the `usage` gaps are acceptable.** The inventory pass reports none because its seam
  does not carry it, and the on-device transport generally reports none. Both are pre-existing and
  both are now visible per-unit rather than only in a total.

## Sequencing and review points

Tasks 1 and 2 are the foundation and nothing else compiles without them; do them in order. Tasks
3, 4, 6, 7 and 8 are independent of each other once Task 1 lands and can be reviewed separately.
Task 5 depends on 3 and 4. Tasks 9 and 10 touch neither the observer nor each other and can land at
any point after Task 1. Task 11 is last by definition.

The review point that matters most is **Task 5**. It is the one the design flags as the easy one to
miss, and it is the one whose premise the code contradicted — a reviewer should check §0.3 against
what was actually built before checking anything else.
