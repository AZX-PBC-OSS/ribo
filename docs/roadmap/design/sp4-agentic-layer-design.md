# SP4 — The agentic layer: a model composes the strategy

**Date:** 2026-09-18
**Status:** **BLOCKED on `sp4a-composable-phases-design.md`. Do not build from this.** Two adversarial reviews found seven defects, enumerated in §10. Four are mechanical; two established that a planner over today's seven phases can express only subsets and repeats of two linear chains — the "router over three fixed strategies" SP1 §8 named as this program's failure mode. Widening the phase vocabulary comes first; the sections below are the draft the findings were filed against, left unedited so each can be read against what it refers to.
**Question answered:** "What are the generally useful meta-extractors?" — SP4 of four, and the only
one where a model chooses the composition rather than a person.
**Depends on:** `phased-extraction-design.md` (SP1 — `Phase`, `validatePhases`, the engine),
`sp2-judging-combinators-design.md` (SP2 — `budgetExtractor` is how a bad plan's cost is detected),
`sp3-parity-and-scale-design.md` (SP3 — instance identity, and the record of a combinator deleted
after measurement).
**Scope:** SP4 of four, and the last.

---

## 1. The answer, before the argument

**A planner emits a phase list; a pure function turns it into an extractor; three drivers differ
only in when the planning happens.** You hand it a schema and LLM options, and it composes the
strategy itself.

- **`PlannedPhase`** — the closed vocabulary a plan is written in: a phase `kind` drawn from the
  caller's registry, an `id`, and a narrow typed argument set. Nothing else.
- **`PhaseRegistry`** — caller-supplied map from `kind` to a factory. **Injected, because core
  cannot import a single phase factory**: every one lives in `ribo-extractor-openai` or
  `ribo-extractor-ondevice` and the dependency runs the other way.
- **`buildFromPlan(plan, registry, target)`** — pure, synchronous, no I/O. Plan in, `Extractor`
  out, or a throw.
- **Three drivers**: `planOnce` (plan at construction, once, ever), `planPerRun` (plan inside every
  `extract`, seeing the transcript), `fromPlan` (no planning; execute a frozen plan).

**The safety argument is that four independent gates stand between a model's output and a running
extraction**, and the first is the strongest: the plan's `kind` field is a **structured-output enum
built from the registry's own keys**, so the model cannot name a phase that does not exist. It is
not a runtime check that catches a bad kind; it is a constraint that prevents one.

## 2. Evidence the problem is real

### 2.1 Composing a strategy currently requires knowing the strategy vocabulary

SP1 turned a multi-pass strategy into a list of phases, which is what makes this possible at all.
But composing one still means knowing that an inventory pass must precede a fill, that gap-fill
reads `ungroundedTarget`, that a span phase needs a presence phase's output. That knowledge lives in
three design docs and the heads of the people who wrote them.

### 2.2 The schema is not always known when the code is written

This is the honest technical case, and it is narrower than the marketing one. `planOnce` over a
schema that ships with the binary is composing something a developer could have composed by hand
and tested. It earns its place when the schema arrives at runtime — a host with many tool adapters,
or a schema assembled per customer. Ribo has one adapter today, so **this justification is
prospective, and §8 says so.**

### 2.3 The pieces SP4 needs already exist and were built for it

`validatePhases` rejects an empty list, a duplicate id, non-integer or non-positive concurrency,
negative retries, and a `requires` not satisfied by an **earlier** phase — with a phase unable to
satisfy its own requirement. That is admission control for a model-emitted plan, and it was written
before any planner existed.

## 3. What this cannot mean

**The plan format is not a configuration surface.** SP1 §5.4 is explicit, and it is the easiest
decision in this program to reverse by accident: "The moment `fromPlan` is documented as the way a
host configures extraction, this decision has been reversed." `fromPlan` exists to pin a strategy
for regression measurement. It is not in the guide, and its doc comment says why.

**The planner does not write prompts.** The vocabulary carries a phase kind and typed arguments.
Model-authored text reaching a second model's prompt is the widest injection surface available and
buys expressiveness nobody has asked for.

**The planner does not see the schema.** It sees a **digest** — group keys, which are collections,
leaf counts, provenance granularity. The full extraction schema serialises to ~303KB against the
platform's 32KB cap (SP3 §4.3 found this the hard way); handing it to a planner would fail before
it did anything.

**A valid plan is not a good plan.** Every gate in §4.5 is structural. None of them knows that
filling `hvac` four times is waste. `budgetExtractor` detects the cost afterwards; nothing prevents
it.

## 4. Design

### 4.1 The plan vocabulary

```ts
interface PlannedPhase {
  readonly kind: string; // a key of the registry — enum-constrained at the model
  readonly id: string; // unique within the plan; validatePhases enforces
  readonly groups?: readonly string[];
  readonly maxRetries?: number;
  readonly concurrency?: number;
}
interface ExtractionPlan {
  readonly phases: readonly PlannedPhase[];
}
```

**`kind` is enum-constrained, not validated.** The planner's structured-output schema is built at
construction from `Object.keys(registry)`, so `kind` is a `z.enum([...])` of exactly the kinds this
caller supplied. A model cannot emit `"delete_everything"` because the grammar has no such token.
Runtime lookup still happens — a defence that costs one line — but the constraint is the primary.

**`id` is separate from `kind` because a plan may use a kind twice.** "Fill, then fill again with
what the first pass learned" is a legitimate strategy, and `validatePhases` rejects duplicate ids,
so the planner must name them apart. This is what Wave 1 unblocks.

**Arguments are narrow on purpose.** `groups`, `maxRetries`, `concurrency` — things the engine
already validates. Everything else about how a phase behaves is the factory's, fixed by the host.
The model chooses **which phases and in what order**, never **how one works**.

### 4.2 The phase registry

```ts
type PhaseFactory<V, P> = (args: PlannedPhase) => Phase<V, P>;
type PhaseRegistry<V, P> = Readonly<Record<string, PhaseFactory<V, P>>>;
```

The host writes the adapters, closing over its own transport and options:

```ts
const registry = {
  inventory: (a) => inventoryPhase({ chat, model, target, id: a.id }),
  fill: (a) => fillPhase({ chat, model, target, id: a.id, groups: a.groups }),
  gapfill: (a) => gapFillPhase({ chat, model, target, id: a.id }),
};
```

**This is the only shape that works**, not a style preference: core defines `Phase` and every
factory lives in a package that depends on core. A registry in core naming `fillPhase` would invert
the dependency. It also means the set of things a planner can compose is **exactly what the host
chose to expose**, which is a security property as much as an architectural one.

An empty registry throws at construction — a planner with no vocabulary can only fail.

### 4.3 `buildFromPlan` — pure

```ts
function buildFromPlan<V, P>(
  plan: ExtractionPlan,
  registry: PhaseRegistry<V, P>,
  options: BuildFromPlanOptions<V, P>,
): Extractor<Enveloped<V, P>>;
```

Synchronous, no I/O, no model call. Looks up each `kind`, calls the factory, runs `validatePhases`,
hands the list to `phasedExtractor`. Every failure is a throw with the offending phase named.

Pure because all three drivers share it and because it is the only part that can be tested
exhaustively without a model — every rejection case is a unit test.

### 4.4 The three drivers

|              | Plans                  | Sees                          | Cost                             |
| ------------ | ---------------------- | ----------------------------- | -------------------------------- |
| `planOnce`   | once, at construction  | the schema digest             | one planning call, ever          |
| `planPerRun` | inside every `extract` | digest **and the transcript** | one planning call per extraction |
| `fromPlan`   | never                  | —                             | none                             |

**`planOnce` is `async` and returns a promise of an `Extractor`.** Construction that makes a network
call cannot be synchronous, and pretending otherwise with a lazily-planned first call would make the
first extraction mysteriously slow and move a planning failure to a surprising place.

**`planPerRun` sees the transcript, and that is the whole point.** It is the adaptive story: read
the dictation, notice it never mentions HVAC, skip those phases. It costs a call per extraction and
the plan may differ run to run, which makes it the harder one to debug and the one whose failures
are least reproducible. Both are stated in its doc comment.

**`fromPlan` is the measurement seam.** Per §3 it is not documented as configuration.

### 4.5 Admission control, in order

1. **Structured output** — `kind` is an enum of the registry's keys. The model cannot name a phase
   that does not exist.
2. **Schema parse** — the plan is parsed with zod at the trust boundary. Shape, types, `min(1)`.
3. **`maxPhases`** — a cap, default 12. Not a safety property; a cost one. A model that emits forty
   phases has misunderstood, and the failure should be loud rather than expensive.
4. **Registry lookup** — belt and braces behind gate 1.
5. **`validatePhases`** — duplicate ids, `requires`/`produces` ordering, concurrency, retries.

Gate 5 is the one that catches an incoherent plan, and it was not written for this.

### 4.6 Phase ids become parameterisable

All seven factories hardcode their id (`gapfill`, `fill`, `inventory`, `span`, `presence`,
`classify`, `classify-wrapped`). Each gains an optional `id` defaulting to today's literal, so no
existing caller changes and a plan can use a kind twice. This is Wave 1 and it is a prerequisite,
not a nicety: without it §4.1's `id` field is unusable.

## 5. What this cost, stated plainly

**A planning call per extraction, for `planPerRun`.** On a short dictation the planner may cost a
meaningful fraction of the extraction it is planning.

**Non-reproducibility.** Under `planPerRun` two runs over the same transcript may execute different
strategies, so an accuracy regression cannot be attributed without knowing which plan ran. The plan
should be logged; this design does not specify where, which is a gap §8 records.

**A new failure mode with no precedent: a valid, coherent, stupid plan.** Every gate is structural.
Nothing catches a plan that fills the same group three times, and the cost lands on the caller.

**Surface area.** Three drivers, a registry type, a plan type, a builder, plus an optional `id` on
seven factories. This is the largest single addition in the program, and it exists to serve a case
(§2.2) that is currently prospective.

## 6. What changes where

| Where                                              | Change                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/ribo-core/src/extraction-plan.ts`        | New: `PlannedPhase`, `ExtractionPlan`, the zod schema, `PhaseRegistry`, `PhaseFactory` |
| `packages/ribo-core/src/build-from-plan.ts`        | New: `buildFromPlan`                                                                   |
| `packages/ribo-core/src/schema-digest.ts`          | New: the compact schema view a planner is shown                                        |
| `packages/ribo-core/src/plan-drivers.ts`           | New: `planOnce`, `planPerRun`, `fromPlan`                                              |
| `packages/ribo-extractor-openai/src/*-phase.ts`    | Optional `id` on three factories                                                       |
| `packages/ribo-extractor-ondevice/src/phases/*.ts` | Optional `id` on four factories                                                        |
| `docs/guide/extraction.md`                         | The agentic layer — **`fromPlan` documented as measurement only**                      |
| `docs/adr/`                                        | One ADR per decision, at the end                                                       |

## 7. Sequencing

1. **Wave 1 — optional `id` on all seven phase factories.** Prerequisite; behaviour-preserving.
2. **Wave 2 — the plan vocabulary, the registry, and `buildFromPlan`.** Pure, no model.
3. **Wave 3 — the schema digest**, and the planner's structured-output schema built from a registry.
4. **Wave 4 — the three drivers.**
5. **Wave 5 — guide, ADRs, changeset.**

Waves 2 and 3 are where the design risk is; waves 1 and 4 are mechanical.

## 8. How this could be wrong

- **The planner may be worse than a fixed list, and nothing here measures that.** The obvious
  experiment is the one SP3 ran on chunking: plan-vs-fixed over the real corpus, scored the same
  way. SP3 deleted a combinator on that evidence, and SP4 should expect the same standard. **This
  is the single most likely outcome to change the design.**
- **`planOnce` may have no honest use** until a schema arrives at runtime (§2.2). If the answer is
  "we only ever have one adapter", `planOnce` is a demo.
- **The plan is not logged anywhere**, so a `planPerRun` regression cannot be attributed. Deciding
  where it goes (usage? a notification? the session record?) is unresolved and touches a seam.
- **`maxPhases: 12` is a guess.** No measurement suggests it.
- **The registry makes the vocabulary the host's**, which is right for safety and means the agentic
  story is only as good as what a host bothered to register. A host exposing one phase kind has an
  agent that can only compose one thing.

## 9. Must-fail tests

- A plan naming a `kind` absent from the registry is rejected, naming the kind.
- A plan with duplicate ids is rejected — `validatePhases`, reached through `buildFromPlan`.
- A plan whose phase `requires` something no earlier phase produces is rejected.
- A plan longer than `maxPhases` is rejected before any factory runs.
- An empty registry throws at construction.
- The planner's structured-output schema contains **exactly** the registry's keys as its `kind`
  enum — the pin that the vocabulary is closed by construction and not by a later check.
- `buildFromPlan` makes **no** model call: pin it with a registry whose factories record invocation
  and a planner that would throw if called.
- `planOnce` plans exactly once across several `extract` calls; `planPerRun` plans once per call.
- `planPerRun` passes the transcript to the planner; `planOnce` does not (it has none).
- A planning failure under `planPerRun` propagates unchanged — it is not a degraded extraction.

---

## 10. Review findings

Two adversarial reviews, both verifying claims against source. Both returned "revise first".

### 10.1 The two that blocked the sub-project

**F1 — the motivating example for `id` ≠ `kind` is factually wrong.** §4.1 justifies separating
them with "fill, then fill again with what the first pass learned". `fillPhase.plan` reads the
roster note, `options.prepared` and the transcript — **never `draft.fields`** — so a second fill
plans identical jobs and its merge overwrites the first. Only `gapfill` re-runs meaningfully. Over
today's vocabulary a planner can compose subsets and repeats of two linear chains.

**F2 — `[gapfill]` alone is a silent vacuous success.** `gapFillPhase` declares no `requires` and
no `produces`; its real dependency is the shape of `draft.fields`, which `PhaseMeta` cannot
express. The plan passes all five gates, no-ops on an empty draft, and `{}` parses clean: a
successful extraction with zero calls and zero fields. §3 framed bad plans as a _cost_ problem;
this is a _correctness_ one, and gate 5 is blind to it by construction.

Both are addressed by `sp4a-composable-phases-design.md`.

### 10.2 Mechanical, to fix when this reopens

**F3 — all three plan arguments are dead, and forwarding them would be harmful.** `groups`,
`maxRetries` and `concurrency` have no consumer: no factory accepts a runtime group filter, and the
engine reads retries and concurrency off the phase's own metadata. The only way plan values could
reach it is a spread-override, which would **re-enable retries on `inventoryPhase` and
`gapFillPhase`, both of which pin `maxRetries: 0` deliberately** — inventory because the engine's
default of 2 would re-issue whatever calls the caller's inventory function makes. The vocabulary
should be `kind` + `id` and nothing else.

**F4 — `planOnce`'s `Promise<Extractor>` composes with nothing.** `toSessionExtractStep`,
`createRelay`'s `sessionExtract`, `compositeExtractor` and the playground's extractor store are all
synchronous, and the store's comment celebrates that construction does no network work. §4.4
explicitly rejected lazy planning, which removes the only workaround, then never says where the
`await` goes. Needs a memoised-promise adapter or an explicit async host seam, and a test.

**F5 — three smaller holes.** The model-chosen `id` is free text reaching the relay's _persisted_
`lastError` with no charset constraint. §4.3's build order contradicts §9's own pin that
`maxPhases` rejects before any factory runs. And under `planPerRun` the **transcript is prompt
input to the planner**, so transcript content can steer which phases run — §3 considers only the
reverse direction.

**F6 — four of the seven phases are not exported.** `@azx/ribo-extractor-ondevice` exposes only
`threePhaseExtractor`, so no host can register an on-device phase and the agentic layer would be
managed-only. §6's change table listed barrel work for neither package. Moved into SP4a wave 4.

**F7 — the `Planner` contract is missing entirely.** No type, no transport, no position on whether
planning runs under the step deadline and signal, no statement on whether its tokens reach
`ExtractionResult.usage`, and — the one that blocks Wave 3 — **no per-kind descriptions**. The
structured-output enum gives the model tokens with no semantics; a planner that does not know what
"inventory" means cannot compose with it, and `Record<string, PhaseFactory>` has no field to carry
that.

### 10.3 Raised and rejected

**"The registry cannot carry caller-supplied functions like `inventoryPhase`'s `inventory`."**
It can: a registry entry is a closure, and closing over the caller's roster function is exactly how
it is supplied. `(a) => inventoryPhase({ inventory: myRosterFn, prepared, instanceCap, id: a.id })`
satisfies `(args: PlannedPhase) => Phase`. §4.2's abbreviated example caused this and should show a
factory with caller-supplied dependencies when this reopens.

### 10.4 Verified clean

The 303KB/32KB citation; that all seven factories hardcode exactly the ids listed; that
`validatePhases` does everything §2.3 claims including the own-requirement exclusion; that all
seven factories are pure at construction; and that adding an optional `id` is behaviour-preserving
— phase ids reach only transient unit events and error text, and nothing persisted carries them.
