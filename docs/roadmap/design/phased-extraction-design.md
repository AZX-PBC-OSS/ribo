# Phased extraction: a pass is a value, and a strategy is a list of them

**Date:** 2026-09-16
**Status:** Draft — revised after review. No implementation plan written yet.
**Question answered:** "We have a phased extractor as an example — generalize the concept. What are
all the generally useful meta extractors, transcribers and combiners? And an agentic extractor that
plans and executes."
**Depends on:** `per-group-composition-design.md` (`groupedExtractor`, `projectTarget`, the
combinator discipline), `extractor-arbitration-design.md` (the arbiter shape and the
constructor-not-flag rule), `extraction-observability-design.md` (the unit stream and the derived
retry budget), `ondevice-extraction-design.md` §3.5 and
`docs/implementation/19-ondevice-extraction-strategies.md` (the measurement that picked
three-phase, and the pass bar this design reuses).
**Authority it corrects:** `extraction-observer.ts:16,53-59` — `UnitBase.phase` is the lifecycle
field, and `PhaseUnit.pass` is a closed union sized for exactly one strategy (§4.6).
**Acceptance bar:** **still functioning**, not byte-identical. This is a major version bump; the
ports may change requests, events and options where that produces a better library (§4.7, §7).
**Scope:** SP1 of four. SP2–SP4 are sketched in §10 and specified separately.

---

## 1. The answer, before the argument

**A multi-pass extraction strategy is three hand-rolled things in this tree, and they are the same
thing.** `threePhaseExtractor` (presence → span → classify), `scopedInstanceExtractor`
(inventory → per-instance fill) and `gapFillExtractor` (base pass → one focused follow-up) each
implement, privately: narrowing the next pass's work from the last pass's output, fanning that work
out under a bound, retrying each unit, discriminating cancellation from failure, accumulating usage,
and parsing once at the end. None of that is strategy-specific. All of it is copied.

**Recommendation: build `phasedExtractor`, one combinator, and port all three onto it.** A phase is
a value with three functions — `plan` narrows, `run` does one unit, `merge` folds back — over a
shared draft. The combinator owns scheduling, retry, abort, the deadline, the unit stream and the
trust boundary. `extractorPhase` lifts any existing `Extractor` into a phase, which is what makes
`phasedExtractor` the outer shell for the whole family rather than a fourth sibling beside them.

**The acceptance bar is that extraction still works, not that requests are unchanged.** An earlier
draft of this design leaned on byte-identical requests as its risk mitigation. That was the wrong
gate twice over: it is not achievable (§4.7 — the natural ports change request names and message
assembly), and it was never sufficient (doc 19 §6a records run-to-run variance on *identical* code,
"45/48 against 44/46 is noise"). The gate is doc 19 §6a's own pass criteria — **completions, zero
degenerations, 100% span fidelity** — structural properties that a working strategy holds and a
broken one does not, run once after every port lands (§10).

**Two small extractions land first**, because `phasedExtractor` would otherwise grow another copy of
a loop this tree already carries in `grouped-extractor.ts`, `instance-fill.ts` and four times over
in `three-phase-extractor.ts`: `retryExtractor` and `timeoutExtractor` (§4.2).

**The honest fallback, if SP4 is ever descoped.** `retryExtractor` + `timeoutExtractor` + the
existing `mapWithPool`, applied to the on-device file alone, would fix the duplication (§2.1), the
cancellation bug class (§2.4) and the missing deadline awareness — with no draft, no
`requires`/`produces`, no ports and no re-measurement. The full abstraction is justified by exactly
two things beyond that: §2.2 and §2.3 (narrowing rules and mid-strategy granularity become values a
host can compose), and SP4's need for one vocabulary to plan over. If SP4 stops being a commitment,
build the smaller thing. §8 treats this as the most likely way this design turns out wrong.

Do not build a DAG, a scheduler with phase dependencies, or a serializable plan format. §5 records
why each was declined, and §5.4 in particular, because SP4 makes the plan-as-data question look
settled when it is not.

## 2. Evidence the problem is real

### 2.1 The retry loop is copied, and the copies have drifted

`grouped-extractor.ts:385` and `instance-fill.ts:563` each carry an attempt loop over a bounded
budget. `three-phase-extractor.ts` carries one per phase plus one for the wrapped-schema fallback
path — at `377`, `464`, `556` and `596`. They are not quite duplicates, which is worse than if they
were: the core two derive their ceiling from `deriveRetryBudget` against `stepTimeoutMs`, and the
on-device four use a fixed `DEFAULT_MAX_RETRIES = 3` with no deadline awareness at all
(`ThreePhaseExtractorOptions` has no `stepTimeoutMs` member). A slow device can exhaust the relay's
step timeout inside phase 0 and be killed mid-run.

The pre-attempt `signal?.aborted` check is repeated verbatim at all four on-device sites, each with
its own comment explaining why it must precede `unit.start` — evidence that the invariant is
understood and that there is nowhere to put it.

### 2.2 The narrowing is the strategy, and it is not expressible

What distinguishes these three strategies is *what the next pass is allowed to look at*:

- three-phase: phase 1 asks only about leaves phase 0 marked present; phase 2 classifies only leaves
  whose phase-1 span survived `isSpanGrounded`.
- inventory → fill: the fill pass runs one call per `(group, instance)` slot the roster named.
- gap-fill: the follow-up asks only about leaves that came back `value === null` with a non-null
  `sourceSpan` — abstained with evidence.

Each is a filter over accumulated state, written as an inline `filter` or loop inside a file of
several hundred lines. A host that wants "presence, then spans, then *my* classifier" cannot have
it; a host that wants a fourth pass cannot have it. The narrowing rule is the valuable part of each
strategy and it is the part that is least reachable.

### 2.3 Granularity changes mid-strategy, and only the monolith can express it

Phase 0 is one call per group. Phase 1 is one call per group. Phase 2 is one call per *leaf*.
Inventory is one call for the whole document; the fill is one call per instance slot. No existing
combinator changes its unit of work partway through a run — `groupedExtractor` is per group for its
whole life — so any strategy that needs to must own its own loop, which is why all three do.

### 2.4 The cancellation bug class is present in the tree today

`three-phase-extractor.ts` has an `isCancellation` helper and a comment recording the stake: a group
whose presence call fails has its leaves nulled and the run continues, so a *cancellation* taking
that path would resolve the run with all-null fields — indistinguishable from a document that
genuinely said nothing. Phases 0 and 1 consult it. **Phase 2 does not.** `classifyLeaf` catches
everything, retries, and returns `null` on exhaustion, so a transport abort arriving before the
caller's signal flips becomes a null leaf with its `sourceSpan` retained. The invariant is
understood, strategy-private, and already violated once inside the file that documents it.

### 2.5 The two failure policies in the tree are opposites

`mapWithPool` rejects on first failure and aborts siblings; `groupedExtractor` builds on that, so one
group failing fails the extraction. `threePhaseExtractor` does the reverse: a failed group is nulled
and the loop continues. Both are correct for their context — abort suits a managed run where one
failure impugns the whole, swallow suits an on-device model that flakes on one group out of many.
Neither is expressible in the other's combinator.

### 2.6 The observability types are already too narrow to reuse

`PhaseUnit.pass` is `0 | 1 | 2`; a fourth pass cannot be reported. And `UnitBase.phase` is the
lifecycle discriminator (`"start" | "done" | "error"`), so the obvious name for a phase identifier
is taken — by an intersection, which means claiming it narrows rather than errors (§4.6).

## 3. What "phased" cannot mean

**It cannot mean `state => state`.** A pipeline of async reducers is `Array.reduce` with extra
imports. It supplies no fan-out, no bound, no retry, no abort, no unit stream, and no vocabulary for
narrowing — so every phase would reimplement §2.1 privately and the combinator would have bought
nothing. If the phase contract is one function, this design is not worth building.

**It cannot mean a DAG.** Phase dependencies, join nodes and a scheduler are the framework
`per-group-composition-design.md` §5 already declined once. Every strategy in the tree is a straight
line, and the straight line is what makes the deadline arithmetic in §4.5 tractable. A DAG also
destroys the property SP4 depends on: that a plan is a list a model can emit and a human can read.

**It cannot mean per-phase persistence.** A phase boundary is not a checkpoint. Extraction is one
relay step with one timeout, and partial-phase durability would put a third state machine beside the
two `AGENTS.md` §1 warns about. A run that dies is retried from the top.

**It cannot mean phases share typed state.** Tempting, and wrong for a reason that only shows up in
SP4: if each strategy's accumulator is its own type, phases are strategy-private and no agent can
mix a presence phase with an inventory phase. §4.3 keeps a shared draft and recovers the type safety
a different way.

## 4. Design

### 4.1 A phase is `plan`, `run`, `merge`

`plan(draft, ctx) => readonly I[]` — **synchronous and pure.** It reads accumulated state and returns
the work items for this phase. Sync is a constraint with a purpose: a phase that needs I/O to decide
its work should do that I/O in an earlier phase's `run`, which is exactly what inventory → fill
already is. Keeping it sync makes every narrowing rule in §2.2 testable with a plain object and no
model — today none of them are testable at all without a fake chat.

`run(item, draft, ctx) => Promise<PhaseOutput<C>>` — one unit of work, the only async member, opaque
to the combinator exactly as a `groupedExtractor` entry's `extract()` is.

**`PhaseOutput<C>` is `{ value: C; usage?: ExtractionUsage }`, and the usage member is why it is not
just `C`.** The combinator owns usage accumulation (§1), but the ported phase definitions do not wrap
an `Extractor` — they assemble messages and call `chat.complete` directly, and one `run` can make
several calls (the wrapped-schema fallback below). Without a usage channel the combinator
undercounts every strategy it hosts. `extractorPhase` fills it from the wrapped extractor's own
`ExtractionResult.usage`.

`merge(draft, results: readonly PhaseItemOutcome<I, C>[]) => PhaseDraft` — folds the batch back in.
It takes the whole batch rather than one result at a time because the grounding filter operates
across a group's spans, and because SP2's consensus phase needs every sample in hand.

**`merge` owns every write to the draft.** `run` receives the draft to read and must not mutate it:
items within a phase run concurrently, so a mutating `run` races its siblings, and §3's argument that
phases do not share typed state depends on the draft being written at one point per phase. The draft
handed to `plan` and `run` is the one the previous `merge` returned.

It takes outcomes, not bare contributions, so a failed item is visible to the phase that knows what
its failure means. That is what makes §2.5's two policies one mechanism instead of two (§4.4).

An empty `plan` result is a no-op: no call, no event, no usage change. `gapFillExtractor`'s
documented behaviour for the no-candidates case falls out of this rather than being coded for, which
is the strongest evidence available that the shape is right.

### 4.2 `retryExtractor` and `timeoutExtractor` land first — and retry does not always back off

Both are lifts of logic already in the tree. `retryExtractor` wraps an `Extractor` with the attempt
loop, the `TerminalQueueError`-is-never-retried rule and the `SchemaParseError`-stays-transient
rule — the semantics `grouped-extractor.ts:385` already implements. `timeoutExtractor` wraps one
with a deadline and an `AbortSignal`, which the relay already does for the whole step.

**The delay policy is injected and the on-device preset supplies zero.**
`ondevice-extraction-design.md:344-346` records as a surviving lesson that backing off is wrong for a
degenerate loop — "it should retry immediately" — which is why today's on-device loops have no delay
at all. Defaulting `retryExtractor` to `fullJitterDelay` would reintroduce exactly what that
measurement rejected, and on a transport whose calls complete in seconds the backoff would dominate
the run. Managed phases keep `fullJitterDelay`; the on-device preset passes a zero delay, and §9
pins it.

They land first because `phasedExtractor` needs both internally, and a combinator that grew its own
would make §2.1 worse while claiming to fix it. They are independently useful: `retryExtractor`
around a `singleShotExtractor` is a thing a host can want today and cannot express.

### 4.3 The draft: typed fields, typed notes, and the members that reach the result

`PhaseDraft<V, P>` carries `fields`, `statedEmptyGroups`, `raw` and `notes`.

`fields` is `DeepPartial<Enveloped<V, P>>` — a homomorphic deep partial, not `Partial<>`. The
top-level version cannot express what the strategies need: a span phase that learned one leaf's
`sourceSpan` would have to supply `value` and `confidence` for that leaf and every sibling. The deep
partial was measured against the real `Enveloped<SnuggValues>` — leaf enum unions survive, collection
groups stay arrays, `readonly` survives, a deep partial is *not* assignable to `Enveloped<V, P>` (so
the closing trust-boundary parse is structurally required rather than optional), and it costs about
3% more type instantiations on the real schema.

One consequence to state rather than discover: a leaf reads `number | null | undefined`. Three
states, and the distinction is load-bearing — "not yet asked" versus "asked, answered null" is
exactly what `provenance.ts:20-24`'s anti-hallucination rule exists to preserve. A merge helper that
collapses it with `?? null` has destroyed it.

`statedEmptyGroups` and `raw` are on the draft rather than in `notes` because both are members of
`ExtractionResult` — public outputs, not scratch. `statedEmptyGroups` must be **omitted from the
result when empty**, not emitted as `{}`: `extractor.ts` documents its absence as meaningful ("absent
for any extractor that does not use a roster"), so a phased extractor emitting `{}` would claim to
have run a roster pass it never ran.

**`notes` is the cross-phase channel, and its keys are typed.** An earlier draft made it
`Readonly<Record<string, unknown>>` and justified it by analogy to `AnnotatedTranscript`. The analogy
argues the other way: `AnnotatedTranscript<P = …>` carries the bag shape as a *type parameter*, gives
the relay's own keys a named type (`CaptureAnnotations`), and reserves a `capture.` namespace with a
documented precedence rule. An untyped bag has none of the three, and §3's own mixability
requirement means phases authored in different packages will meet in one array, where two producers
of `"presence"` silently clobber.

So a note key is branded: `NoteKey<T>` is `string & { readonly [NoteBrand]?: (value: T) => T }`,
created by `noteKey<T>(id)`, and read and written through a small `Notes` interface whose `get` and
`set` are generic in the key's type. Reading a roster key as presence data is a compile error;
storing the wrong shape under a key is a compile error. **The key is still a plain string at
runtime**, so `requires`/`produces`, the construction check below and SP4's model-emitted plan are
all unchanged, and `Phase<V, P>` gains no type parameter — §3's mixability constraint is fully
intact. `noteKey<unknown>("scratch")` remains available as the escape hatch.

**Phases declare what they require and produce, and the declaration is checked at construction**,
failing with the missing key and the phase id named. This is `groupedExtractor`'s coverage check and
`enveloped()`'s `validateProvenance` applied to a new axis: a composition error surfaces before the
first call is paid for. A second check runs at each phase boundary in development — a phase that
declares `produces` and does not write it is a silent liar, and a conditionally-written key (a
roster-driven `statedEmptyGroups` contribution) is exactly the shape that lies.

That check earns its keep twice. In SP4 it is the agent's admission control — a model cannot emit a
plan that wires phases in the wrong order, because construction rejects it and the rejection names
the key, which is also the repair prompt for the next attempt. It is a key-presence check, not a
type system; the branded keys above are what make it more than that.

### 4.4 Failure policy is per phase, and cancellation is not

`onItemFailure: "abort" | "skip"`, declared per phase, resolves §2.5 without either existing
combinator changing. An abort-policy phase lets `mapWithPool` reject exactly as it does today —
siblings aborted, run failed, `map-with-pool.ts` untouched. A skip-policy phase catches inside the
worker function, so the pool never sees a rejection, and the failed item reaches `merge` as a failed
outcome for the phase to interpret.

**"Interpret" is not one rule, and the three-phase port proves it.** A presence or span failure nulls
the group's leaves *including their spans*; a classify failure **keeps the span** and nulls only the
value (`three-phase-extractor.ts:258-265`). That difference is load-bearing downstream: gap-fill's
candidates are leaves with a null value and a non-null span, so a merge that nulled phase-2 spans
would starve the follow-up pass and strip the citation a reviewer reads. Two phases of one strategy,
two skip interpretations — which is the argument for `merge` owning the interpretation rather than
the combinator applying a uniform policy.

**Cancellation always propagates, whatever the policy.** The combinator owns the discrimination §2.4
shows is currently strategy-private and already broken in one place. The canonical signal is
`ctx.signal.aborted`, checked before an item is started and after an item fails. A transport that
rejects with its own `aborted` error while the caller's signal has *not* fired is a transport bug —
every implementation in the tree observes the signal on the way out — and core cannot see
`ChatError`, which lives in `ribo-extractor-openai`. So core exports a `CancellationError` marker
that transport errors of that kind carry, `isTransientFailure` returns false for it, and the design
claims exactly that and no more. Wording matters here: the earlier draft promised core would honour
"a transport's contractual aborted error," which core could not see.

**On the constructor-not-flag rule.** The earlier draft defended `onItemFailure` against
`race-extractor.ts`'s "concurrency is opt-in by name, not a boolean somebody can flip" and skipped
the harder case. Two corrections. First, the rule is about a combinator's *cost, timing and exposure*
profile being visible in its name — `extractor-arbitration-design.md:99` says outright that privacy
is not what makes the property structural, so that is not the axis either. Second, the flag that
actually engages the rule is **`concurrency`**, not `onItemFailure`: a per-phase concurrency bound
genuinely changes how much work runs at once. It survives because a numeric bound is not the boolean
the rule is about — `groupedExtractor.concurrency?: number` is the precedent — and because the
alternative is a constructor per value.

`onItemFailure` engages a different question, which is worth naming rather than dismissing: a phase
list with `presence: skip, span: abort` fails differently depending on which phase failed, so two
lists differing only in policy are arguably two strategies. They are kept one combinator anyway,
because all three ports need to mix policies across their own phases and `phasedAbort`/`phasedSkip`
could not express any of them.

### 4.5 The deadline, and the contract widening it needs

`deriveRetryBudget` sizes retries from a *known* call count — `batches = ceil(entries / concurrency)`
against `stepTimeoutMs` and `PER_CALL_CEILING_MS`. Phased violates that premise by construction: the
classify phase's item count depends on what the span phase produced.

The combinator records a deadline once and, at each phase boundary — the moment `plan()` has returned
and that phase's item count is known — derives that phase's budget against its share of the
**remaining** time.

**`onRetryBudget` keeps its existing meaning: it fires when a budget was *reduced*, not on every
derivation.** `retry-budget.ts:43` defines it that way and both current call sites honour it, so a
phased run emits one event per *reduced* phase — commonly zero, up to one per phase. Making it fire
unconditionally would turn a signal ("something had to be cut") into a metronome.

**A deadline-caused zero is not a configuration error, and must not be treated as one.** Today
`derived === 0` with `requested > 0` means the caller asked for retries that cannot fit *any* run of
this shape, which is why `requireRetryBudget` throws `TerminalQueueError` and sends the session to
`dead` — "no retry fixes a configuration error." Under a running deadline the same zero can be
produced by elapsed wall-clock at a late phase boundary, which is transient and may not recur on the
relay's next attempt. So the derivation distinguishes them: a budget that would be zero against the
*full* step timeout is the configuration error and still throws; a budget that is zero only against
the *remaining* time runs with no retries and reports it. Conflating the two would kill sessions on a
timing blip, and it is the kind of silent state-machine interaction this repo has been bitten by
before.

**`ExtractOptions` gains `deadline?: number`** (absolute epoch ms), forwarded like `signal` and
combined with `Math.min` by every combinator that has its own. Without it the deadline is a lie under
composition: a `phasedExtractor` nested inside another combinator starts its own clock believing it
has the whole step timeout, and with twenty sequential group entries the last one is wrong by the
elapsed time of the previous nineteen. This is the same contract widening
`per-group-composition-design.md` §4.4 performed for `signal`, and the major bump is when to do it.

**Two numbers must be tuned, or the on-device path silently derives zero retries.**
`PER_CALL_CEILING_MS` is 120 s, sized for a managed structured-output call; the on-device transport's
own bound is `DEFAULT_DEVICE_PROMPT_DEADLINE_MS = 15_000`. With the managed ceiling, a classify phase
of a dozen-plus leaves at `concurrency: 1` derives to zero retries against any plausible share of the
step timeout — against today's fixed three — and `retry-budget.ts` already warns that an on-device
preset must lower the ceiling or derive to zero. The on-device preset sets `perCallCeilingMs` from
the device deadline, and §9 pins the derived budget.

Equal slicing across phases assumes phases cost alike, and they do not — presence is one call per
group, classify is one per surviving leaf. §8 carries this as a named weakness with `onRetryBudget`
as the evidence channel; weights are the fix if the events show starvation, and they are a flag on a
combinator, so the bar is evidence rather than intuition.

**One port gets tighter, not better, and that should be said plainly.** `scopedInstanceExtractor`
today derives once, after the roster returns, against the **full** step timeout. Ported, the fill
phase derives against its share of what the inventory pass left — and the inventory is a
caller-supplied function that may run a model whose cost never reaches this extractor. A slow but
successful inventory therefore buys the fill phase fewer retries than it gets today. §4.5 is a clear
improvement for the on-device path, which modelled no deadline at all; for the managed path it is a
tightening, and the acceptance gate is what says whether the tightening matters.

### 4.6 The unit stream changes

`pass` widens to `number`, and a phase identifier joins it as **`phaseId: string`** — not `phase`,
which is `UnitBase`'s lifecycle discriminator. Because `PhaseUnit` is an *intersection* with
`UnitBase`, declaring `phase: string` would narrow to `"start" | "done" | "error"` and emitting
`phase: "presence"` would fail with an error naming neither cause; the collision is silent, which is
why it is recorded here rather than left to be rediscovered. `phaseId` is also what a consumer
rendering progress actually wants — "presence", not "0".

`pass` means position in the phase list. It previously meant the strategy's own pass index, and for
the ported three-phase those coincide; for a four-phase list they do not, and position is the only
meaning a general combinator can offer.

**The ported presets emit `PhaseUnit`, and `GapFillUnit`, `InventoryUnit` and `InstanceUnit` leave
the `ExtractionUnit` union.** The alternative — parameterising `phasedExtractor` on its unit type, or
letting phases emit through `ctx` — buys back three type names at the cost of the combinator no
longer owning its own stream. Nothing in `ribo-ui-react` or `playground/src` consumes `onUnit` today,
so the blast radius is this repo's tests.

**`attempt` needs one meaning.** `grouped-extractor.ts:420` counts outer-loop iterations;
`three-phase-extractor.ts:387` counts inner-loop iterations. Under a combinator-owned stream it
counts **combinator retry attempts of one phase item** — a call a `run` makes internally is not an
attempt, because the combinator did not make it and cannot bound it.

### 4.7 The three ports

With the acceptance bar at "still functioning," the ports take their natural shape rather than the
shape that preserved request bytes.

**`gapFillExtractor`** goes first, because it proves `extractorPhase` — the primitive that lifts any
`Extractor` into a phase. Gap-fill becomes a base extractor phase followed by the follow-up phase,
its candidate collection becomes `plan`, and its no-candidates passthrough is the empty-plan case
from §4.1. Its `targets` option, its two candidate filters and the directive its message assembly
includes only when ungrounded candidates are present all move into the follow-up phase's `plan` and
`run`; `normalize` becomes an option of the combinator, applied once before the closing parse, as it
is in `groupedExtractor` today.

**`scopedInstanceExtractor`** is two phases — inventory (one item, whole document, roster into
`notes`) then fill. The fill phase's item is a **`(group, piece, instance)` triple, not a
`(group, instance)` slot**: when a group's schema is partitioned for the nullable-union cap,
partitioning multiplies the fill calls per instance, each piece carrying its own narrowed schema and
a `-<part>`-suffixed structured-output name, and the pieces of one slot are recombined with
`mergeGroupPieces`. Items at slot granularity would serialize a slot's pieces inside one `run`
instead of interleaving them through the pool, which is both a different request sequence and a loss
of the concurrency the partitioning exists to exploit. `PhaseUnit` therefore needs the piece
coordinates alongside `phaseId` — the same `(key, instance, part)` the current `InstanceUnit`
carries.

Its `instanceCap` becomes a check in the fill phase's `plan` after reading the roster. The inventory
call returns a `Roster`, not an `ExtractionResult`, so it is a bespoke phase rather than an
`extractorPhase` lift — and it reports its one call through `PhaseOutput.usage` (§4.1). It also keeps
its one-shot semantics: the inventory phase pins `maxRetries: 0`, because today's inventory is
deliberately not retried and the combinator would otherwise re-issue whatever calls the caller's
inventory function makes.

**`threePhaseExtractor` becomes four phases, and the fourth is the interesting one.** Presence, span
and classify are as described. The wrapped-schema fallback — today an error-driven request rewrite
*inside* `classifyLeaf`'s retry loop, continuing the same unit id and attempt numbering — becomes a
separate `classifyWrapped` phase whose `plan` reads the leaves the classify phase recorded as
unsupported. That is the narrowing pattern the combinator exists for, and it needs no per-item
re-plan hook, no error-driven rescheduling, and no vocabulary growth.

This is the change the old acceptance bar made impossible: the existing test pins one unit id with
continuing attempt numbers across both request shapes, and no arrangement of an opaque `run` under a
combinator-owned retry loop could reproduce that. Under a major bump the pin is the thing that gives
way, and the result is simpler than what it replaces.

The port runs **phase-major** — every group's presence, then every group's span — rather than the
group-major order the monolith uses. Phase-major is the natural semantics, it is what allows a later
phase to narrow across groups rather than within one, and it removes the `groupedExtractor` nesting
an earlier draft needed, along with that nesting's compounding retry (an outer retry re-running a
group's already-successful phases). The on-device preset sets `concurrency: 1` on each phase, so the
device still sees one call at a time. The construction-time refusal for `"row"`/`"none"` provenance
groups moves into the presence phase's construction, keeping its before-any-call property.

### 4.8 Placement

`phasedExtractor`, `retryExtractor`, `timeoutExtractor`, `extractorPhase`, `CancellationError` and
the draft, note and phase types go in **`ribo-core`**: a phase's `run` is opaque, so no chat
vocabulary enters, the same argument that put `groupedExtractor` there.

The presence, span, classify, wrapped-classify, inventory and gap-fill phase definitions assemble
messages, so by `schema-retry.ts`'s stated rule they go in **`ribo-extractor-openai`**.
`three-phase-extractor.ts` already imports `ChatError` and `CapableChatClient` from there, so this
moves a dependency that exists rather than adding one.

They are **factories, not constants** — `presencePhase<V, P>(options): Phase<V, P>` — because a
projected per-group target instantiates at `Pick<V, K>` rather than `V`, and because SP4's vocabulary
needs to parameterise them by id and prompt.

**`ribo-extractor-ondevice` keeps `threePhaseExtractor` as a thin preset** wiring those phases to the
on-device client with `concurrency: 1`, a zero retry delay (§4.2) and a device-sized
`perCallCeilingMs` (§4.5). Its public API and the package the strategy was measured in both stay put.

## 5. Considered and rejected

### 5.1 A phase as a single `(state) => Promise<state>` function

§3 argues this at length. Recorded because it is the shape anyone reaching for "generalize the
pipeline" writes first, and because its failure mode is quiet: it typechecks, it reads well, and it
pushes every hard problem in §2.1 back into the phases.

### 5.2 Shipping `phasedExtractor` beside the three strategies

Recommended when this design was first put up, and overruled. The argument for it: the three work,
and a port risks them. The argument against, which won: a combinator that cannot express the
strategies already in the tree is not evidence of anything, and SP4 needs one vocabulary, not four
siblings. What changed since: the mitigation is no longer byte-identity but §1's structural pass bar,
which is both achievable and a better test of the thing actually at risk.

### 5.3 A DAG, a router, or per-phase persistence

§3. Each is a framework, each was declined once already in `per-group-composition-design.md` §5, and
nothing in §2 needs any of them.

### 5.4 A serializable plan format

Deliberately not built, and this needs recording because SP4 makes it look inevitable. Strategies
stay typed TypeScript composition; the win is the vocabulary, not a config language. The phase list
SP4's planner emits is an internal struct that `buildFromPlan` consumes — not a public format, not
documented as one, not stable.

The distinction is worth defending, because the two look identical from a distance. `fromPlan(plan)`
will exist in SP4 and will accept a frozen plan — but its purpose is pinning a strategy for
regression measurement. **The moment it is documented as the way a host configures extraction, this
decision has been reversed by accident.**

### 5.5 Byte-identical requests as the acceptance gate

The earlier draft's mitigation, and wrong on both counts. Not achievable: the natural ports change
`response_format.json_schema.name` and rebuild message assembly, and preserving the bytes would have
required lifting private message builders into new modules and keeping the monolith's ordering and
unit-id semantics — which is what forced §4.7's `groupedExtractor` nesting and made the
wrapped-classify fallback inexpressible. Not sufficient either: the model is non-deterministic, so
identical requests do not pin outputs. §1's structural bar replaces it.

### 5.6 Two constructors for the failure policy

§4.4. The rule was checked against properly this time, on the flag that actually engages it.

## 6. Interfaces

Described rather than typed in full; the shapes that are load-bearing:

- `phasedExtractor<V, P>(options): Extractor<Enveloped<V, P>>` where `options` carries `target`,
  `phases`, optional `normalize`, the timing knobs `maxRetries`, `stepTimeoutMs`, `perCallCeilingMs`
  and a run-level `concurrency` (the default a phase inherits when it declares none — 4, matching
  `groupedExtractor`), the injectable `delay` every retry test needs, and extends `BackoffOptions`,
  `ExtractionObserver<PhaseUnit>` and `RetryBudgetObserver` — in `ribo-core`, beside
  `grouped-extractor.ts`. `normalize` is run once, before the closing parse, as `groupedExtractor`
  runs it today; all three ported strategies expose it and the live playground wiring passes one, so
  omitting it would silently drop a configured transform. The name matches every
  extractor-side sibling (`groupedExtractor`, `fallbackExtractor`, `raceExtractor`) and its own
  options type; the bare-adjective precedents (`hedged`, `firstCapable`) are all transcriber-side.
- `Phase<V, P>` — the phase type a `phases` list holds. Its item and contribution types are
  **existentially quantified rather than cast away**: the type exposes `with: <R>(use: <I, C>(def:
  PhaseDef<V, P, I, C>) => R) => R`, with `id`, `requires`, `produces`, `concurrency` and
  `onItemFailure` on the outside where the construction check and SP4's planner read them without
  entering. The combinator writes `phase.with(def => …)` and inside that callback `I` and `C` are
  bound and correlated, so handing phase 0's items to phase 1's `run` is a compile error. An erasing
  cast would typecheck that exact mistake, in the combinator's own scheduling loop.
- `phaseBuilder<V, P>()` returns the phase constructor, curried so `V`/`P` are fixed once per
  strategy and `I`/`C` are inferred per phase. A single four-parameter constructor cannot work:
  TypeScript has no partial type-argument inference, and every V/P-generic constructor in this repo
  is called with explicit `<V, P>`.
- `PhaseDraft<V, P>` — `fields` (`DeepPartial<Enveloped<V, P>>`), `statedEmptyGroups`, `raw`, `notes`
  (§4.3). Named `PhaseDraft`, not `Draft`: "draft" already means the extraction a human reviews
  (`review.ts:20`, `outbox.ts:888`), and two meanings at one public boundary is one too many. The
  transcript and target are on the phase context, not the draft — a phase that could mutate the
  transcript would defeat `spanGroundedness`.
- `PhaseItemOutcome<I, C>` — a discriminated union on `outcome: "result" | "error"`, matching
  `arbitration.ts`'s `ExtractionOutcome` rather than inventing a second outcome vocabulary. (A
  `Settled` named after `PromiseSettledResult` would invite the wrong mental model in a file that
  also uses `Promise.allSettled`.) Its error arm is reachable only for skip-policy phases; an
  abort-policy phase's failure rejects before `merge` runs.
- `PhaseOutput<C>` — `{ value: C; usage?: ExtractionUsage }` (§4.1).
- `NoteKey<T>`, `noteKey<T>(id)`, `Notes` (§4.3).
- `extractorPhase<V, P>(id, extractor): Phase<V, P>` — lifts any `Extractor` into a one-item phase,
  forwarding the caller's `signal` and `deadline` and reporting its usage. In `ribo-core`.
- `retryExtractor<F>(extractor, options)` and `timeoutExtractor<F>(extractor, options)` — positional,
  matching `fallbackExtractor`/`raceExtractor`. `retryExtractor`'s options carry the delay policy
  (§4.2).
- `ExtractOptions` gains `deadline?: number` (§4.5). `PhaseUnit` gains `phaseId` and widens `pass`;
  `GapFillUnit`, `InventoryUnit` and `InstanceUnit` leave the union (§4.6).

## 7. Costs

- **Code and bundle.** Net smaller. The scheduling, retry and abort halves of three files collapse
  into one combinator. No new dependency.
- **Breaking, and deliberately so.** This is a major version bump. `ExtractOptions` widens,
  `PhaseUnit` changes, three unit types leave the `ExtractionUnit` union, the ported strategies'
  requests and events change, and `onRetryBudget` fires once per phase rather than once per run. A
  `major` changeset is required, and per the CI bar that means `changeset status` and
  `pack-and-consume` alongside `check.sh`. Nothing is published today, so the practical blast radius
  is this repo and the playground.
- **Tests.** The three ported suites do **not** pass unmodified — their unit-event assertions, their
  `onRetryBudget` counts (`instance-fill.test.ts` asserts exactly one event) and three-phase's
  one-unit-id wrapped-fallback assertion all encode behaviour this design changes. Amending them is
  part of each port, not a follow-up.
- **Semantics that move.** The unit of retry becomes the phase item. On the on-device path that is
  finer-grained than today: a classify leaf that fails gets its own budget rather than the whole
  group being retried from scratch. The on-device path also gains deadline awareness it did not have,
  so a run that previously exhausted `stepTimeoutMs` and was killed now degrades its retry budget
  instead.
- **Documentation.** `docs/guide/extraction.md` and `docs/guide/arbitration.md` gain phased
  composition; `three-phase-extractor.ts`'s header loses the parts describing machinery it no longer
  owns.

## 8. What would make this the wrong call

- **Nobody writes a fourth phase — the most likely failure.** The consumers of `phasedExtractor`
  today are three ports and nothing else. Every part of its surface — `notes`, `requires`/`produces`,
  the draft, the policy flag, the widened unit stream — is paid for by those three until SP4 lands.
  The sharp test is not "does anyone write a fourth phase" but **"does SP4 compose a strategy no
  preset already covers"**. If it does not, SP4 is a router over three fixed strategies, §1's smaller
  refactor was the right build, and the marketing claim the program exists to support is hollow.
- **The retry-budget and delay tuning is got wrong.** §4.5's two numbers and §4.2's delay policy are
  the difference between the on-device path keeping its retries and silently running with none. The
  repo has a documented history with silent zero-budget derivations — it is why `requireRetryBudget`
  exists — and this design multiplies the derivation sites by the phase count.
- **`notes` becomes a second schema.** The branded keys make shape errors compile errors, but not a
  dependency graph. If phases accumulate enough cross-references that `requires`/`produces` is
  something people reason about as a whole, §3's DAG has arrived through the back door.
- **The deadline slicing is too crude.** Equal shares assume equal cost and classify is the outlier.
  The fix is weights, the bar is `onRetryBudget` evidence, not intuition.
- **`phasedExtractor` grows a vocabulary.** Scheduling modes, phase dependencies, a routing hook: any
  of them and this is the framework §3 declined. New behaviour is a new constructor.
- **Two owners of one retry loop.** After SP1, `groupedExtractor` still inlines the attempt loop
  `retryExtractor` now owns. That is §2.1's smell reappearing; retrofitting it is out of scope here
  and should not stay out of scope for long.

## 9. Must-fail tests

- A phase list whose second phase `requires` a key no earlier phase `produces` throws at
  construction, with the key and the phase id named — before any call.
- A phase that declares `produces` and does not write the key fails at that phase's boundary, naming
  both.
- Reading a note key at the wrong type is a compile error; storing the wrong shape under it is a
  compile error (type-level, pinned both ways).
- Handing one phase's items to another phase's `run` is a compile error (type-level — this is what
  the existential encoding buys over a cast).
- A phase whose `plan` returns an empty array makes no call, emits no unit event, and leaves usage
  unchanged; the ported `gapFillExtractor` with no candidates passes the base result's `raw` through.
- A `run` that makes several calls reports all of them through `PhaseOutput.usage`, and the run total
  is their sum — pinned with a fake whose `run` calls twice. The ported three-phase preset still
  reports `usage.engine`, which core cannot know and a phase must supply.
- `run` receives a draft it cannot write through: a `run` that mutates what it is handed does not
  change what the next `plan` sees (type-level where possible, behavioural otherwise).
- The ported `gapFillExtractor`'s no-candidates path returns the base result's `fields` and `raw`.
  Today the suite pins `fields` by **identity** (`toBe`); the port returns an equal object rebuilt
  from the draft, so that assertion changes to a deep equality — a deliberate amendment, listed in
  §7, not an accident to discover during the port.
- The inventory phase makes exactly one call on failure as on success — it is pinned to no retries,
  where every other phase retries.
- `ExtractOptions.deadline` is forwarded to every phase item and combined with `Math.min` against the
  combinator's own; a `phasedExtractor` nested inside another combinator derives its budgets from the
  *outer* remaining time, not a fresh clock.
- The on-device preset's derived `RetryBudget` is the requested three for every phase on a fresh
  clock, with a device-sized `perCallCeilingMs` — and zero delay is observed between attempts, not
  `fullJitterDelay`.
- `onRetryBudget` fires once per phase, with the phase named.
- A skip-policy phase whose item fails sees that failure in `merge` and completes the run; an
  abort-policy phase's failure aborts in-flight siblings and fails the run.
- A run cancelled mid-phase rejects in **both** policies — a skip-policy phase must not convert a
  cancellation into a skipped item and resolve with null fields (§2.4). Pinned for a caller-aborted
  signal and for a `CancellationError` from the transport.
- The ported `threePhaseExtractor`'s classify phase records unsupported leaves, and the
  `classifyWrapped` phase plans exactly those and no others.
- A phased extractor that ran no roster pass omits `statedEmptyGroups` from its result rather than
  emitting `{}`.
- `PhaseUnit` events carry `phaseId` alongside the lifecycle `phase`, and a four-phase list reports
  `pass: 3` — impossible today.

## 10. Sequencing

1. `retryExtractor` and `timeoutExtractor` in core, with the injected delay policy (§4.2).
2. `ExtractOptions.deadline` (§4.5) and `CancellationError` (§4.4) — the two contract widenings,
   landed together since both touch every implementation.
3. `PhaseUnit` changes and the `ExtractionUnit` union (§4.6).
4. `phasedExtractor`, `phaseBuilder`, `PhaseDraft`, `Notes`, `PhaseItemOutcome`, `extractorPhase` in
   core, with every §9 test that needs no model — all against `FakeExtractor` and hand-written
   phases.
5. Port `gapFillExtractor` (proves `extractorPhase` and the usage channel), amending its suite.
6. Port `scopedInstanceExtractor` (proves `notes`, `statedEmptyGroups` and multi-granularity),
   amending its suite.
7. Port `threePhaseExtractor` as four phases (proves narrowing replaces an error-driven rewrite),
   amending its suite, and tune the on-device preset's ceiling and delay.
8. **The acceptance gate, once, after every port has landed** — doc 19 §6a's structural bar:
   completions, zero degenerations, 100% span fidelity. Two harnesses: the on-device arm through
   `spikes/ondevice-acceptance` (manual, real Chrome — it refuses Chromium's stub), the managed arm
   through `spikes/managed-three-phase/run.mjs` (needs secrets). A failure here bisects across steps
   5–7 rather than being attributed by construction; that is the accepted trade for not running a
   manual gate three times.
9. Guide updates and the `major` changeset.

Then, each on its own design: **SP2** — `validate`, `consensus`, `budget`, `cached`, the combinators
that judge or bound a result rather than produce one. **SP3** — `hedgedExtractor` and
`raceTranscriber` (lifts across the extractor/transcriber boundary), then `chunkedExtractor`,
`chunkedTranscriber` and `annotatingCombiner`, which are one story: long inputs, where chunking is
what produces annotations and the combiner is what carries them. **SP4** — the agentic layer: a
planner that emits a phase list under a closed structured-output vocabulary, a pure `buildFromPlan`,
and three drivers (`planOnce` at construction, `planPerRun` inside `extract`, `fromPlan` for pinned
measurement). SP4 depends on §4.3's construction check being the admission control that makes a
model-emitted plan safe, on the phase factories of §4.8 being parameterisable by id, and on §5.4
holding.
