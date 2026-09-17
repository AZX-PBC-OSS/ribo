# SP2 — Judging and bounding: four combinators that do not produce a result

**Date:** 2026-09-17
**Status:** Draft — for review. No implementation plan written yet.
**Question answered:** "What are the generally useful meta-extractors?" — SP2 of four, the combinators
that judge or bound a result rather than produce one.
**Depends on:** `phased-extraction-design.md` (SP1: the phase vocabulary, `phasedExtractor`,
`retryAsync`), `extractor-arbitration-design.md` (the arbiter shape and the injected-policy
discipline), `provenance.ts` (`spanGroundedness`, and the recorded finding that confidence does not
discriminate).
**Scope:** SP2 of four. SP3 (parity and scale) and SP4 (the agentic layer) are separate.

---

## 1. The answer, before the argument

**Every combinator this repo has produces a result. None of them judges one.** `fallbackExtractor`
and `raceExtractor` choose _between_ results on whether a strategy threw; `groupedExtractor` and
`phasedExtractor` assemble one. Nothing looks at a returned result and says "this is not good
enough" — even though the library already computes the evidence to say it.

**Recommendation: four small combinators over the existing `Extractor` seam.**

- **`consensusExtractor`** runs a list of candidates, compares them leaf by leaf, and nulls the
  leaves they disagree about while keeping the span. It is the only substantial one.
- **`validateExtractor`** turns `spanGroundedness` into an accept-or-reject decision an arbiter can
  act on, so a hallucinating strategy falls through to the next rung instead of being written back.
- **`budgetExtractor`** bounds what a run may spend.
- **`cachedExtractor`** memoises a result by transcript and target.

Three of the four are wrappers of a few dozen lines. The design work is in `consensus`, in one
decision inside `budget` (§4.3), and in the cache key (§4.4).

**The policy is injected in all four, not configured.** This repo has made that choice twice —
`ExtractionArbiter` and `TranscriptCombiner` are both caller-supplied functions where the engine owns
iteration and the policy owns the decision. A quorum integer is the special case of a function, so
the function ships and the integer does not. Named defaults are exported the way
`terminalFallsThrough` and `acceptAnySuccess` already are, so choosing a policy is an import rather
than a flag.

Do not build a scoring framework, a confidence calibrator, or a cross-run statistics store. §5
records why.

## 2. Evidence the problem is real

### 2.1 Confidence is a constant, and the library says so

`provenance.ts:49` records it outright: "Uniform-high confidence is not calibration, it is a
constant." A review rule of the form "flag anything under 0.8" flags nothing, because the model
reports high confidence for fabricated values as readily as for grounded ones. The on-device
strategy's own classify step writes `confidence: 1` when a leaf got a value and `0` when it did not,
with a comment saying it is a placeholder and that the repo already knows confidence does not
discriminate hallucinations.

So the library has a per-leaf trust signal that carries no information, and a reviewer's attention is
finite. **Agreement between independent samples is a signal the library does not currently compute**,
and unlike confidence it is not something the model can assert about itself.

### 2.2 The grounding evidence exists and reaches no decision

`spanGroundedness` returns `"grounded" | "near-miss" | "ungrounded"` and is used at review time to
render a leaf's citation state. Nothing consults it _before_ review. A strategy that returns a full
set of confidently-stated, entirely ungrounded fields is indistinguishable, to every combinator in
the tree, from one that returns well-cited ones — so an arbitration ladder cannot fall through on
quality, only on failure. `gapFillExtractor`'s `"ungrounded"` target re-asks such leaves, but that is
a repair pass, not a gate: it still returns the result either way.

### 2.3 A strategy's cost is unbounded and unbindable

`phasedExtractor` derives a retry budget from a step timeout, which bounds _wall clock_. Nothing
bounds _calls_. A per-group strategy over a twenty-group schema with retries can issue sixty calls,
and the only thing that stops it is the relay's timeout. This matters more after SP4, where the
number of calls is chosen by a model rather than by a person.

### 2.4 Re-running an identical extraction costs full price

Development iteration, accuracy sweeps, and a relay retry after a non-extraction failure all re-issue
the same requests against the same transcript. There is no memoisation anywhere in the extraction
path.

## 3. What these cannot mean

**`consensus` cannot mean "average the answers".** There is no metric on an enum leaf, and averaging
a fabrication with a fact produces a fabrication with a confident-looking provenance. It compares and
abstains; it never synthesises a value no sample returned.

**`validate` cannot mean "score the result".** A score invites a threshold, a threshold invites
tuning, and tuning invites a calibration story this repo has no measurement to support. It returns a
decision, and the decision is the caller's function.

**None of them may inspect a strategy's internals.** They wrap an `Extractor` and see what an
`Extractor` returns. A combinator that needed to know a strategy was phased, or per-group, would be
coupling a judging layer to a producing one — and the whole point of the seam is that they do not
know about each other.

**`cached` cannot be transparent about staleness.** A cache that returns a result computed against a
different schema is worse than no cache, because the failure is silent and arrives as field data. §4.4
makes the schema part of the key rather than trusting a caller to invalidate.

## 4. Design

### 4.1 `consensusExtractor`

**Candidates are a list**, so "the same extractor sampled three times" is `[x, x, x]` and "three
engines" is `[a, b, c]`. One shape covers both, and the second is the more interesting one: sampling
the same model three times finds its instability, while three engines find a systematic error that
any one of them would report with full confidence.

**All candidates run.** Unlike `raceExtractor`, there is no first-accept — a consensus of one is not a
consensus. They run concurrently through the existing `mapWithPool`, bounded, with the caller's signal
and deadline forwarded.

**A failed candidate contributes no samples**, and the run continues as long as at least
`minSamples` (default 2) survived. Below that the run fails: reporting agreement between one sample
and nothing is a lie, and it is exactly the case where a caller would most want to know.

**Comparison is per leaf, over values only.** The runtime walk over `Enveloped<V, P>` that
`gapFillExtractor` already owns is reused rather than rewritten. Spans are deliberately **not**
compared: two samples can quote different sentences and mean the same value, and requiring span
equality would null nearly everything. The surviving span is taken from the first sample whose value
matches the accepted one, so the citation belongs to an answer that was actually given.

**The decision is a `ConsensusArbiter`** — a caller-supplied function receiving one leaf's samples and
returning **an envelope of the same type it was shown**, on either arm. `unanimousValues` is the
default and `majorityValues` ships beside it, so majority is an import rather than a flag.

The type symmetry is the point, and an earlier draft got it wrong: it took envelopes and returned a
bare value, leaving the combinator to pick the span by a "first sample whose value matches" rule. That
split value selection from citation selection, so a policy author could choose an answer but not the
quote supporting it — the shape that produces a leaf whose span belongs to a different answer than its
value. `ExtractionArbiter` does not make that mistake: it is shown `ExtractionResult<F>` and returns
`ExtractionResult<F>`. This follows it.

**Both arms carry an envelope**, rather than the rejection being a bare marker, so a rejecting policy
still chooses which span survives. A rejected leaf is conventionally `value: null, confidence: 0` with
a span the policy picked — but the combinator does not impose that, because a policy that wants to
keep a different citation on a contested leaf has a better claim to know than the combinator does.

**Two arms rather than one**, even though `=> Extracted<unknown>` would be smaller: the combinator has
to know a leaf was contested in order to count them, and the contested count is the headline signal
this combinator exists to produce. It is not recoverable from the envelope, because a leaf the samples
agreed was `null` and a leaf they fought over are byte-identical afterwards.

That shape is not arbitrary: it is exactly a `gapFillExtractor` candidate — a null value with a
non-null span — so consensus and gap-fill compose into "sample three times, then re-ask about
whatever they disagreed on", and review already renders a null leaf as needing a human.

**Usage sums across every candidate**, because they all ran. The cost is N times a single extraction
and the doc comment says so in the first paragraph; a combinator that tripled a bill without
announcing it would be a trap.

### 4.2 `validateExtractor`

Wraps an `Extractor`. After it returns, walks the leaves, computes each one's `spanGroundedness`, and
hands the census to a caller-supplied policy. The policy returns ok, or a rejection carrying a reason.

**A rejection is an error, not a flag**, because the arbiter contract already acts on errors: a
`fallbackExtractor` rung that rejects falls through to the next strategy with no new mechanism. A flag
would need a channel through `ExtractionResult` that every consumer would then have to check, and
most would not.

The error is a new `ValidationRejectedError` carrying the census, and it is **transient** by
`isTransientFailure`'s default — a resample may well do better, and the arbiter decides whether to
fall through.

**The default policy rejects when any leaf holds a non-null value whose span is `"ungrounded"`**, and
tolerates `"near-miss"`. That is the strict reading of the repo's own anti-hallucination rule: a
committed value citing text that is not in the transcript is the failure mode the provenance envelope
exists to catch. It is strict enough that some hosts will want to relax it, which is why it is a
function.

### 4.3 `budgetExtractor` — and the decision this design has to make

A wrapper can only see what an `Extractor` _returns_. So a post-hoc budget can report that a run cost
too much; it cannot stop it. **The money is already spent by the time the wrapper sees the usage.**

Two honest options, and this design picks the first:

**(a) A post-hoc detector.** `budgetExtractor` checks the returned usage against a ceiling and rejects
when it is exceeded. Useless for preventing the current spend, useful for the _next_ one: an arbiter
falls through to a cheaper strategy, and a host learns that a strategy's cost profile changed.
Zero contract change, a few dozen lines.

**(b) A real governor.** A meter on `ExtractOptions`, alongside `signal` and `deadline`, that
cooperating extractors decrement and consult before each call — so the ceiling actually stops work.
This is the shape that genuinely bounds cost, and `deadline` is the precedent for adding it.

**Recommendation: build (a) now and name (b) as the thing to build when there is a caller for it.**
(b) is a contract widening every implementation must honour, and its value is highest precisely where
it is hardest to verify — a third-party extractor that ignores the meter looks identical to one that
respects it. The design's own §8 for SP1 warned about advisory contracts nothing enforces; a meter is
another one. (a) is not a fake version of (b): detection and prevention are different jobs, and the
detector composes with an arbiter to do something useful today.

Say this plainly in the doc comment, so nobody ships (a) believing they have (b).

### 4.4 `cachedExtractor`

Memoises by a key over **the transcript text and the target's identity**, where identity means the
target's `name` _and_ a hash of its `extractionSchema`. The schema must be in the key: a cache that
serves a result computed against a different field set returns data that parses and is wrong, and
nothing downstream can tell. Trusting a caller to invalidate is the same bet, made worse by being
implicit.

**Failures are never cached.** A transient failure cached for the session turns one bad minute into a
permanent one.

**The store is injected**, with an in-memory `Map` default. Worth recording: `PluginStorage` looks
like the obvious backing and is the wrong lifetime — its scope is documented as "entries die when the
capture does", so it cannot serve the re-run-the-same-transcript case a cache exists for. A host that
wants persistence supplies its own.

### 4.5 Placement

All four go in **`ribo-core`**, beside the combinators they sit with. None needs message assembly, a
chat client, or a provider concept: they wrap an `Extractor` and read `ExtractionResult`.
`consensusExtractor` needs the runtime leaf walk currently private to `gapFillExtractor` in
`ribo-extractor-openai` — that walk moves to core, where a core combinator can reach it, and the
openai package imports it rather than keeping a copy.

## 5. Considered and rejected

**A scoring framework.** A number per result, thresholds, weights. There is no measurement in this
repo that would justify any particular weighting, and a score invites exactly the false precision
`provenance.ts:49` already warns about for confidence.

**Calibrating confidence.** Tempting, since the field exists and is useless. It needs labelled data
this project does not have, and the honest alternative — agreement between samples — needs none.

**A cross-run statistics store.** "This strategy has been rejected 40% of the time this week" is a
different product with a persistence story, and the two persisted state machines in this repo are
already the thing `AGENTS.md` §1 warns about growing a third of.

**A quorum integer on `consensus`.** The function subsumes it, and the repo's own precedent is an
injected policy. Shipping both would be two ways to say one thing.

**`consensus` routing disagreements to review as a new contested state.** Strictly more useful than
nulling — a human picking between "Gas" and "Propane" beats being told nothing was found. It is also a
new envelope member, a new `ReviewField` state, a session-schema migration and playground UI: a
cross-package sub-project rather than a combinator. Nulling-with-span reaches review through the
existing null-leaf path and composes with gap-fill for free. Revisit if reviewers ask for it.

## 6. Interfaces

Described rather than typed in full; the shapes that are load-bearing:

- `consensusExtractor<V, P>(candidates, options): Extractor<Enveloped<V, P>>` where `options` carries
  the `ConsensusArbiter`, `minSamples`, `concurrency`, and the observer — in `ribo-core`.
- `ConsensusArbiter` — `(input: { path: string; samples: readonly Extracted<unknown>[] }) =>
{ accept: Extracted<unknown> } | { reject: Extracted<unknown> }`. Type-symmetric: shown envelopes,
  returns an envelope, exactly as `ExtractionArbiter` is shown and returns `ExtractionResult<F>`.
  Two arms rather than `ArbiterVerdict`'s three — there is no `continue`, because every sample is
  already in hand when this is called, and no `giveUp`, because one leaf's disagreement is a result
  rather than a failure. Untagged, following `arbitration.ts`'s recorded reasoning that distinct
  required key names narrow correctly under `in` and a tag would buy no safety.
- `unanimousValues` and `majorityValues` — the shipped policies.
- `validateExtractor<F>(extractor, policy, options): Extractor<F>`, `ValidationPolicy`,
  `ValidationRejectedError`, and `groundingCensus` — the pure function producing the per-leaf
  groundedness tally, exported because it is useful on its own.
- `budgetExtractor<F>(extractor, options): Extractor<F>` with `maxCalls` and the token ceilings, and
  `BudgetExceededError`.
- `cachedExtractor<F>(extractor, options): Extractor<F>` with an injected `ExtractionCache` (get/set
  over a string key) and an in-memory default.

## 7. Costs

- **Code and bundle.** Four small modules in core plus one walk moved into it. No new dependency.
- **Breaking.** None. All four are additive, and the moved leaf walk keeps its export from the openai
  package as a re-export so no consumer breaks.
- **Runtime.** `consensus` multiplies calls by the candidate count. That is the point, and it is the
  one thing in SP2 a host can misuse expensively.
- **Documentation.** `docs/guide/arbitration.md` gains the judging layer beside the choosing one.

## 8. What would make this the wrong call

- **Agreement turns out not to discriminate either.** The premise is that independent samples
  disagree where a model is fabricating and agree where it is reading. Untested here. The cheapest
  refutation is running `consensus` with three samples over the existing corpus and seeing whether
  the nulled leaves correlate with the known-wrong ones — if they do not, `consensus` is an expensive
  way to lower fill rate and should be dropped rather than tuned.
- **Nobody composes a judging combinator.** These are only useful inside an arbitration ladder or
  before a write. If every host runs one strategy and writes the result, `validate` has no consumer.
- **The default validation policy is too strict to ship with.** If a real corpus rejects most runs on
  a single ungrounded leaf, the default is wrong even if the mechanism is right — and the fix is a
  different default, not a threshold nobody can justify.
- **`budget` (a) gets mistaken for (b).** If anyone ships a cost guarantee on top of the post-hoc
  detector, the doc comment failed and the meter should be built.

## 9. Must-fail tests

- Three candidates agreeing on a leaf keep its value and one of their spans; three disagreeing null
  the value and keep a span; two agreeing and one dissenting null it under `unanimousValues` and keep
  it under `majorityValues`.
- A policy that returns a **different sample's envelope** than the combinator would have chosen gets
  that envelope, span included — the pin that value and citation are selected together rather than by
  two different parties.
- The contested-leaf count reflects rejections and not agreed-upon nulls: a run where every sample
  said `null` for a leaf reports zero contested, and a run where they disagreed reports one.
- A leaf where one sample committed and another abstained is a **disagreement**, not a
  commitment — the model contradicting itself is the case this exists to catch.
- A candidate that rejects contributes no samples and does not fail the run while `minSamples`
  survive; dropping below `minSamples` fails it, naming the count.
- `consensus` sums usage across every candidate, and forwards the caller's signal and deadline to all
  of them.
- `validate`'s default policy rejects a result holding a committed value with an `"ungrounded"` span,
  tolerates `"near-miss"`, and passes a fully grounded one; the rejection is classified transient, and
  a `fallbackExtractor` with a rejecting first rung reaches its second.
- `budget` rejects a result whose usage exceeds the ceiling and passes one that does not — and its
  doc comment says it cannot prevent the spend, pinned by a test asserting the inner extractor ran.
- `cached` serves a second identical call from the store without invoking the inner extractor;
  a changed transcript misses; **a changed `extractionSchema` with an identical transcript misses**;
  a rejection is not cached, so the next call retries.

## 10. Sequencing

1. Move the runtime leaf walk from `gapFillExtractor` into core, re-exported, with its tests.
2. `validateExtractor` + `groundingCensus` — the smallest, and it proves the reject-as-error shape.
3. `budgetExtractor` and `cachedExtractor` — independent, either order.
4. `consensusExtractor` last: it needs the moved walk, and it is the one whose behaviour is worth
   having the other three's patterns settled before writing.
5. Guide updates and a `minor` changeset.

Then **SP3** — `hedgedExtractor`, `raceTranscriber`, and the long-input trio. Then **SP4**, the
agentic layer, whose action space these four widen: a planner that can compose "sample three times
and abstain on disagreement, reject if ungrounded, under a call ceiling" is choosing between
strategies that differ in more than which model they call.
