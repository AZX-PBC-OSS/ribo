# SP2 — Judging and bounding: four combinators that do not produce a result

**Date:** 2026-09-17
**Status:** Draft — revised after review. No implementation plan written yet.
**Question answered:** "What are the generally useful meta-extractors?" — SP2 of four, the combinators
that judge or bound a result rather than produce one.
**Depends on:** `phased-extraction-design.md` (SP1), `extractor-arbitration-design.md` (the arbiter
contract and the injected-policy discipline), `provenance.ts` and `enveloped.ts` (grounding, and the
provenance granularities these combinators can and cannot serve).
**Scope:** SP2 of four. SP3 (parity and scale) and SP4 (the agentic layer) are separate.

---

## 1. The answer, before the argument

**Every combinator this repo has produces a result. None of them judges one.** `fallbackExtractor`
and `raceExtractor` choose _between_ results on whether a strategy threw; `groupedExtractor` and
`phasedExtractor` assemble one. Two strategies do make grounding decisions internally — gap-fill's
ungrounded target and the on-device span phase's merge — but both are private to the strategy that
owns them and invisible to an arbiter, so a ladder still cannot fall through on quality.

**Recommendation: four small combinators over the existing `Extractor` seam.**

- **`consensusExtractor`** runs a list of candidates, compares them leaf by leaf, and nulls the
  leaves they disagree about while keeping a citation. It is the only substantial one.
- **`validateExtractor`** turns grounding evidence into a rejection an arbiter acts on.
- **`budgetExtractor`** detects a run that spent more than a ceiling.
- **`cachedExtractor`** memoises a result by transcript and target.

**The policy is injected in all four.** This repo has made that choice twice — `ExtractionArbiter`
and `TranscriptCombiner` are caller-supplied functions where the engine owns iteration and the policy
owns the decision. Named defaults ship the way `terminalFallsThrough` and `acceptAnySuccess` do, so
choosing a policy is an import rather than a flag.

**Two scope limits are load-bearing and are stated here rather than discovered later.**
`consensus` and `validate` both work by walking per-leaf provenance envelopes, so they can only serve
groups derived at `"leaf"` granularity and **refuse `"row"` and `"none"` groups at construction**
(§4.5). And `budget` is a **detector, not a governor** — a wrapper cannot prevent a spend it only
learns about afterwards, and it is honest around one strategy but not around a ladder (§4.3).

Do not build a scoring framework, a confidence calibrator, or a cross-run statistics store. §5
records why.

## 2. Evidence the problem is real

### 2.1 Confidence is a constant, and the library says so

`provenance.ts:49` records it: "Uniform-high confidence is not calibration, it is a constant." A
review rule of the form "flag anything under 0.8" flags nothing. The on-device classify step writes
`confidence: 1` when a leaf got a value and `0` when it did not, with a comment saying it is a
placeholder and that the repo already knows confidence does not discriminate hallucinations.

So the library has a per-leaf trust signal carrying no information, and a reviewer's attention is
finite. **Agreement between independent samples is a signal the library does not compute**, and
unlike confidence it is not something a model can assert about itself.

### 2.2 Grounding reaches decisions, but only strategy-private ones

Two places already consult grounding before review: `gapFillExtractor`'s `findUngroundedLeaves`
selects re-ask candidates from it, and the on-device span phase's merge **gates on
`isSpanGrounded`**, dropping a leaf whose quote is not verbatim. So the claim is not that grounding
reaches no decision — it is narrower, and still holds:

**No composable judging layer exists.** Both decisions are internal to the strategy that makes them
and invisible from outside it. A `fallbackExtractor` cannot fall through because a rung returned
confident, well-formed, entirely ungrounded fields; nothing it can see distinguishes that from a good
result. The span phase is in fact the precedent `validate` generalises — the same decision, lifted to
where an arbiter can act on it.

### 2.3 Nothing bounds a run's call count

`phasedExtractor` bounds wall clock through the step timeout, and a phase's item count and
`maxRetries` bound its own calls. What does not exist is a **ceiling** — a number a caller sets that
the run is measured against. A twenty-group strategy with retries can issue sixty calls and nothing
says whether that was expected. This matters more after SP4, where the call count is chosen by a
model rather than a person.

### 2.4 Re-running an identical extraction costs full price

Development iteration, accuracy sweeps, and a relay retry after a non-extraction failure all re-issue
the same requests against the same transcript. There is no memoisation in the extraction path.

## 3. What these cannot mean

**`consensus` cannot mean "average the answers".** There is no metric on an enum leaf, and averaging
a fabrication with a fact produces a fabrication with confident-looking provenance. It compares and
abstains, and §4.1's signature makes "never synthesises a value no sample returned" a property of the
type rather than a promise in prose.

**`validate` cannot mean "score the result".** A score invites a threshold, a threshold invites
tuning, and tuning invites a calibration story this repo has no measurement to support.

**None may inspect a strategy's internals.** They wrap an `Extractor` and see what one returns.

**`cached` cannot be casual about the key.** A cache serving a result computed against different
instructions, examples or schema returns data that parses and is wrong, and nothing downstream can
tell.

## 4. Design

### 4.1 `consensusExtractor`

**Candidates are a list**, so "the same extractor sampled three times" is `[x, x, x]` and "three
engines" is `[a, b, c]`. The second is the more interesting: sampling one model finds its
instability, while three engines find a systematic error any one of them would report confidently.

**Every candidate runs to settlement, and a failure is a missing sample rather than a failed run.**
This is explicitly **not** `mapWithPool`: that helper rejects on the first failure and aborts every
sibling, which is the opposite of what consensus needs. Candidates settle independently under a
concurrency bound, each receiving the caller's `signal` and `deadline` through its own
`ExtractOptions` — `mapWithPool` has no channel for forwarding a caller's signal, and would abort the
survivors on the first rejection.

The run continues while at least `minSamples` candidates survived (default 2), and fails below that,
naming the count: agreement between one sample and nothing is not agreement.

**Comparison is per leaf, over values only.** Spans are deliberately not compared — two samples can
quote different sentences and mean the same value, so requiring span equality would null nearly
everything.

**A path present in fewer samples than survived is contested, not unanimous.** This is the rule that
closes the collection-group hole: two samples can disagree about _how many instances exist_, so
`hvac.2.fuel` may appear in one sample and not another. Treating a single-sample path as unanimous
would accept a hallucinated instance — with citations — from exactly the disagreement consensus
exists to catch. Sample counts are therefore per **path**, not per candidate, and a path seen by
fewer than all survivors is contested before the arbiter is consulted.

**The decision is a `ConsensusArbiter`**, and it returns an **index into the samples it was
handed**:

- Written `(input: { path: readonly (string | number)[]; samples: readonly Extracted<unknown>[] })
=> { accept: number } | { contested: number }`. An index closes every fabrication hole at once
  and needs no rank-2 generic: the policy never constructs an `Extracted` at all, so whatever
  comes back is provably one of the envelopes it was handed. §3's "never synthesises a value no
  sample returned" becomes the signature. It is also far easier to author against, and `samples`
  can be plain `Extracted<unknown>[]` because a policy that only compares and points has no need
  to name the value's type.
- **An earlier envelope-returning encoding bought one guarantee out of three.** It was generic in
  the leaf's value type — `<T>(… samples: readonly Extracted<T>[]) => { accept: Extracted<T> } …`
  — on the claim that `T`'s opacity made fabrication a compile error. That holds for exactly one
  member. `Extracted<T>` is `{ value: T | null; confidence: number; sourceSpan: string | null }`
  (`provenance.ts`, via `inner.nullable()`), so `null` is in the union for every `T`, and
  `sourceSpan` and `confidence` never mention `T` at all: a cast-free conforming policy returning
  `{ value: null, confidence: 1, sourceSpan: null }` compiles clean, and so does
  `{ ...samples[0], sourceSpan: "a sentence nobody said" }` — a policy could keep a real value
  and invent the citation, the worst of the three on a combinator whose entire output contract is
  "keeps a citation". Only the fabricated non-null literal was refused. The index-returning
  signature refuses all three, which is why it replaced the encoding.
- **The path is structured, never a formatted string.** `gap-fill.ts` records the rule: nothing parses
  a formatted path back apart. A `string` path would push every consumer toward exactly that parse.
- **The second arm is `contested`, not `reject`**: the combinator must know a leaf was contested to
  count them, and the contested count is the headline signal this produces. It is unrecoverable
  afterwards, because a leaf the samples agreed was `null` and one they fought over are
  byte-identical. On `contested`, the named index supplies the **citation**; the combinator writes
  `value: null, confidence: 0` over it. The policy picks the span; the combinator does only what
  the index cannot say.
- **The range is checked by the combinator, not the compiler.** An index outside `samples` is a
  policy bug; the combinator throws on it rather than clamping, because silently accepting sample 0
  when the policy said 7 hides the bug forever.

`unanimousValues` is the default; `majorityValues` ships beside it. **`majorityValues` is defined
only over paths every survivor produced** — with unequal instance counts there is no meaningful
majority over an index only some samples reached, and the per-path rule above has already contested
those.

**The type-level pins the earlier encoding promised are gone with it.** An index-returning policy
is never handed the materials to build an envelope, so there is no fabricated-literal return to
`@ts-expect-error` against; the pin that replaces those is runtime — every index a policy returns
must resolve by identity to an envelope drawn from `samples`.

**Usage sums `calls` and tokens across every candidate**, because they all ran, and the cost is N
times a single extraction — the doc comment says so first, since a combinator that triples a bill
without announcing it is a trap. `engine` and `strategy` are **omitted**: they identify one producer
and a consensus has several, so reporting the first would name a transport that produced only part of
the result.

### 4.2 `validateExtractor`

Wraps an `Extractor`, walks the leaves, computes each one's `spanGroundedness`, hands the census to a
caller-supplied policy, and either returns the result untouched or throws.

**The rejection is terminal, and an earlier draft had this exactly backwards.** It said transient, on
the reasoning that a resample might do better. But `terminalFallsThrough` — the conservative default
arbiter — **continues on a terminal error and gives up on a transient one**, because a transient
failure means the transport is down and the next strategy shares it. Classifying a validation
rejection transient therefore produces the opposite of the advertised behaviour: the ladder gives up,
the relay classifies the step failure transient, and re-runs the **whole extract step including the
hallucinating rung**, on backoff, until `dead`. A hallucination detector that becomes a full-price
retry loop.

Terminal is also the honest reading. "This strategy produced ungrounded output" is a property of the
strategy, not a blip — retrying _it_ is what transient means, and that is not this. So
`ValidationRejectedError` extends `TerminalError`, the shipped default arbiter falls through with no
new arbiter needed, and a ladder that exhausts reaches `dead` rather than looping, which is correct
for output no strategy could ground.

**The default policy rejects when any leaf holds a non-null value whose span is `"ungrounded"`**, and
tolerates `"near-miss"` — the strict reading of the repo's own anti-hallucination rule. It is strict
enough that some hosts will want to relax it, which is why it is a function.

### 4.3 `budgetExtractor` — a detector, and where it is honest

A wrapper sees only what an `Extractor` returns, so it reports an overspend it cannot prevent. Real
prevention needs a meter on `ExtractOptions` that every implementation honours — another advisory
contract nothing enforces, whose value is highest exactly where it is least verifiable. Build the
detector; name the governor; say in the doc comment which one this is.

**And say where the detector is honest, because it is not everywhere.** An error outcome carries no
usage, and an arbitration engine returns only the accepted candidate's result. So a `budgetExtractor`
wrapped **around a ladder** sees only the winning rung's usage — every rejected candidate's calls are
invisible, and the ceiling under-counts precisely when strategies are being skipped for cost. That is
the composition an earlier draft recommended, and it was wrong. The detector belongs **around a
single strategy**, where the usage it reads is the usage that was spent.

**`maxCalls` is the member that works everywhere.** Token ceilings measure managed extractors only:
`calls` is `ExtractionUsage`'s one required member, the on-device phases report no tokens, and
several paths report `{ calls: 1 }` and nothing else. A token ceiling on an on-device strategy is
vacuous, and the doc comment says so rather than letting a host discover it.

### 4.4 `cachedExtractor`

The key covers **the transcript text and the whole target**: `name`, `instructions`, `examples` and
the schema. Instructions and examples are the prompt — two targets identical in name and schema but
differing in examples produce different output, and a key omitting them serves one's result for the
other. That is the same silent-wrong-data failure the key exists to prevent, introduced by the key.

**The schema is hashed via `z.toJSONSchema`**, the serialization this repo already uses to send a
schema to a model, with a stable stringification and a `crypto.subtle` digest — core is browser-side,
so the Node `crypto` used in the acceptance harness is not available. The plan specifies the exact
recipe; "a hash of its extractionSchema" is a placeholder, not a spec.

**Failures are never cached.** A transient failure cached for the session turns one bad minute into a
permanent one.

**The store is injected**, in-memory `Map` by default. `PluginStorage` looks like the obvious backing
and is the wrong lifetime — its scope is documented as "entries die when the capture does", so it
cannot serve the re-run-the-same-transcript case a cache exists for.

### 4.5 Both judging combinators refuse row and none granularity, at construction

`consensus` and `validate` work by walking per-leaf provenance envelopes. A `"row"` group has no such
envelopes — it is plain nullable values plus one row-level span — and a `"none"` group has none
either. A walk that identifies a leaf by its `value` and `confidence` members passes both straight
through, so a naive implementation would **compare nothing and count nothing** in exactly those
groups, while returning a result that looks judged.

That is the worst available outcome, because row provenance exists _because_ per-cell citations were
measured 37% fabricated. Being silently blind there inverts the sub-project's purpose.

So both **throw at construction** when the target declares a `"row"` or `"none"` group, naming the
group and saying why — the same refusal `threePhaseExtractor` already makes for the same reason, with
the same shape of message. A host with such a target learns before any call is made.

Extending the walk to carry the schema, so row spans are judged too, is the right end state and is
deliberately not this sub-project: review's own walk already reads row spans, so the mechanism exists
to copy when there is a consumer asking for it.

### 4.6 Placement

All four go in **`ribo-core`**. None needs message assembly or a provider concept. `consensus` needs
the runtime leaf walk currently **module-private** inside `gapFillExtractor` — so this is a move into
core plus a new export, not a re-export of something already public.

## 5. Considered and rejected

**A scoring framework.** No measurement here justifies any weighting, and a score invites the false
precision `provenance.ts:49` already warns about for confidence.

**Calibrating confidence.** Needs labelled data this project does not have; agreement between samples
needs none.

**A cross-run statistics store.** A different product with a persistence story, and `AGENTS.md` §1
warns about growing a third state machine.

**A quorum integer on `consensus`.** The function subsumes it.

**`consensus` routing disagreements to review as a contested state.** Strictly more useful — a human
picking between "Gas" and "Propane" beats being told nothing was found. Also a new envelope member, a
new `ReviewField` state, a session-schema migration and playground UI: a cross-package sub-project.
Nulling-with-citation reaches review through the existing null-leaf path and composes with gap-fill
for free. Revisit if reviewers ask for it.

**`validate` rejecting transiently.** §4.2. It produces the opposite of the intended behaviour under
the shipped default arbiter, and a retry loop at the relay.

## 6. Interfaces

- `consensusExtractor<V, P>(candidates, options): Extractor<Enveloped<V, P>>` — options carry the
  `ConsensusArbiter`, `minSamples`, `concurrency` and `onContested`. `onContested` is not an
  `ExtractionObserver`, and that is deliberate: the wave-2 rule holds that a wrapper which
  delegates and judges stays silent, because an observer stream over delegated runs duplicates the
  inner extractors' own units unit-for-unit and double-counts. `onContested` escapes that rule
  because it is new vocabulary **no inner extractor emits** — it reports consensus's own verdicts,
  the leaves the samples fought over — so there is nothing in an inner stream for it to be counted
  twice against.
- `ConsensusArbiter` — `(input: { path: readonly (string | number)[]; samples: readonly
Extracted<unknown>[] }) => { accept: number } | { contested: number }` — an INDEX into `samples`
  (§4.1), so a policy cannot fabricate: whatever it names is an envelope it was handed. Two arms,
  untagged, following `arbitration.ts`'s recorded reasoning that distinct required key names narrow
  under `in`. The call site resolves the index at runtime; the guarantee is that the named sample
  exists, which the combinator checks rather than the compiler.
- `unanimousValues`, `majorityValues` — the shipped policies.
- `validateExtractor<F>(extractor, policy, options): Extractor<F>`, `ValidationPolicy`,
  `ValidationRejectedError extends TerminalError`, and `groundingCensus` — the pure per-leaf tally,
  exported because it is useful alone.
- `budgetExtractor<F>(extractor, options): Extractor<F>` with `maxCalls` and token ceilings, and
  `BudgetExceededError`.
- `cachedExtractor<F>(extractor, options): Extractor<F>` with an injected `ExtractionCache` and an
  in-memory default.

## 7. Costs

- **Code and bundle.** Four small modules plus one walk moved into core. No new dependency.
- **Breaking.** None; all additive. The moved walk was private, so nothing depended on it.
- **Runtime.** `consensus` multiplies calls by the candidate count — the one thing in SP2 a host can
  misuse expensively.
- **Documentation.** `docs/guide/arbitration.md` gains the judging layer beside the choosing one.

## 8. What would make this the wrong call

- **Agreement does not discriminate either.** The premise is that samples disagree where a model
  fabricates and agree where it reads. Untested. The cheapest refutation is running `consensus` with
  three samples over the existing corpus and checking whether the contested leaves correlate with the
  known-wrong ones. If they do not, `consensus` is an expensive way to lower fill rate and should be
  dropped rather than tuned.
- **Nobody composes a judging combinator.** These are useful inside a ladder or before a write. If
  every host runs one strategy and writes it, `validate` has no consumer.
- **The default validation policy is too strict to ship.** If a real corpus rejects most runs on a
  single ungrounded leaf, the default is wrong even if the mechanism is right — and the fix is a
  different default, not a threshold nobody can justify.
- **The row/none refusal is the wrong trade.** If the targets people actually run are mostly row
  granularity, SP2 refuses the majority of real work and the walk extension was the thing to build.
- **Index alignment over collections is assumed, never enforced.** Comparing collection instances
  by index presumes every candidate enumerates instances in the same order, and nothing checks
  that. Two samples that both found the same three rooftop units but listed them in a different
  order are compared unit-1-against-unit-3 and reported as three disagreements — data every sample
  agreed on, nulled. That is the safe direction (disagreement nulls, nothing fabricated reaches
  review), but it is a real limitation, and a caller meeting it will think the combinator is
  broken rather than misordered.
- **`majorityValues` has the unsafe version of the same problem.** With samples `[A,B,C]`, `[A,C]`
  and `[A,B,C]`, the path `hvac.1.fuel` exists in all three, so it is compared — B, C, B — and the
  majority accepts **B**, a value for an entity the second sample does not have, carrying a
  citation from a sample that was quoting a different unit. The whole-collection contest closes
  this particular case — the second sample falls short of the first survivor's length at
  `hvac`, so every leaf under the collection is contested without consulting the arbiter. (A
  survivor LONGER than the first is not contested: the shared indices still pair like-for-like,
  and the extra instances never enter a walk that is over the first survivor.) But an equal-length
  reordering defeats it, and no rule here fixes that. `unanimousValues` fails safe under any
  reordering and is the default for this reason; a host pointing `majorityValues` at unordered
  collections has accepted that hole. The real fix is content-addressed instance matching — a
  design question (what identifies an instance?) rather than an implementation one — and is
  deliberately out of scope.
- **The contested count under-reports structural disagreement, in one direction only.** A
  candidate that invents an extra instance is caught when it is placed _first_ (the other
  survivors fall short, and the whole collection is contested) and is **silently dropped** when it
  is placed anywhere else — the walk is over the first survivor, so the invented instance is never
  visited, never compared, and never notified through `onContested`. The output is right either
  way, which is what matters most, but the _signal_ is ordering-dependent: a host must not read
  "zero contested" as "the candidates agreed on how many there are." This is the strongest
  argument for content-addressed matching, and the cheapest thing that would prove this section
  wrong is running three candidates over a multi-instance corpus and counting how often their
  instance counts differ at all.

## 9. Must-fail tests

- Three candidates agreeing keep the value and a citation; three disagreeing null the value and keep
  one; two agreeing with one dissenting null under `unanimousValues` and keep under `majorityValues`.
- A leaf one sample committed and another abstained on is a **disagreement**.
- **A path present in fewer samples than survived is contested** — a sample producing a fourth `hvac`
  instance the others do not see has it nulled, not accepted.
- Every index a policy returns resolves by IDENTITY to an envelope drawn from the `samples` it was
  handed — the pin that replaced the earlier encoding's two `@ts-expect-error` type-level pins,
  which the index-returning signature made first false and redundant (§4.1).
- A policy returning a **different sample's envelope** gets that envelope, span included.
- The contested count reflects rejections, not agreed-upon nulls.
- A candidate that rejects contributes no samples and does not fail the run while `minSamples`
  survive; below it the run fails, naming the count. A candidate's rejection does **not** abort its
  siblings.
- `consensus` omits `engine` and `strategy` from its usage, and sums `calls`.
- Constructing `consensus` or `validate` against a target with a `"row"` group throws, naming it.
- `validate`'s rejection is **terminal**, and a `fallbackExtractor` with `terminalFallsThrough` and a
  rejecting first rung **reaches its second** — the pin that §4.2's correction is real.
- `budget` rejects a result exceeding the ceiling; its doc comment says it cannot prevent the spend,
  pinned by asserting the inner extractor ran.
- `cached` misses on a changed transcript, a changed schema, **changed instructions**, and **changed
  examples**; serves an identical call without invoking the inner; never caches a rejection.

## 10. Sequencing

1. Move the leaf walk into core with its tests, and add the `"leaf"`-granularity guard both judging
   combinators use.
2. `validateExtractor` + `groundingCensus` — smallest, and it proves the terminal-rejection shape
   end to end through a real `fallbackExtractor`.
3. `budgetExtractor` and `cachedExtractor` — independent, either order.
4. `consensusExtractor` last: it needs the moved walk, and its behaviour is worth writing after the
   other three's patterns have settled.
5. Guide updates and a `minor` changeset.

Then **SP3**, then **SP4**, whose action space these widen: a planner able to compose "sample three
times and abstain on disagreement, reject if ungrounded, under a call ceiling" is choosing between
strategies that differ in more than which model they call.

## Reviewed

Reviewed by OpenCode (`glm-5p3-flash`, run 6819) before any plan was written. All findings applied;
three changed the design rather than its wording.

**`validate`'s error classification was backwards.** The draft said transient so an arbiter could
fall through. `terminalFallsThrough` does the opposite — it continues on terminal and gives up on
transient, because the next strategy shares the transport. The review traced the consequence: the
ladder gives up, the relay classifies the step transient, and re-runs the whole extract step
including the hallucinating rung until `dead`. §4.2 now makes the rejection terminal, which is both
the working behaviour and the honest reading.

**Both judging combinators would have been blind to `"row"` and `"none"` groups.** The reused walk
identifies a leaf by its `value` and `confidence` members; a row group has neither, so `consensus`
would compare nothing and `validate` count nothing there — precisely the wide tables where per-cell
citations were measured 37% fabricated. They now refuse those targets at construction, following
`threePhaseExtractor`'s precedent.

**`consensus` had a hole that admitted the fabrication it exists to catch.** Sample counts were
per candidate, so a path only one sample produced was trivially unanimous — meaning a hallucinated
extra instance would be accepted, with citations. Counts are now per path.

Four mechanism errors: `mapWithPool` cannot implement the stated failure semantics (it rejects on
first failure, aborts siblings, and has no channel for a caller's signal); `budget` reads only the
winning rung's usage, so the ladder composition the draft recommended is exactly where it
under-counts; the cache key omitted `instructions` and `examples`, which _are_ the prompt; and the
schema hash was a placeholder rather than a recipe.

Two evidence claims were overstated and are now narrowed: grounding does reach pre-review decisions
(gap-fill's finder, the span phase's merge gate) — the real claim is that no _composable_ judging
layer exists, and the span-phase gate is a precedent supporting `validate` rather than a
counterexample. And the leaf walk is module-private, so moving it is a move, not the re-export the
draft claimed.
