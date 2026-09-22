# 0017. Corroboration is a judging combinator, not a review flag

Status: Accepted
Date: 2026-09-21

## Context

A System One model (TypeSafe's Jev, or a self-hosted kev) answers typed questions about a text and
returns calibrated probabilities. It has no primitive that fills a schema, so it cannot replace an
extractor. The question was where its judgement belongs.

The attractive design is a per-leaf flag on `ReviewField`, beside `isGrounded` and `groundedness`:
the extractor commits a value, a verifier scores whether the transcript supports it, and the review
card shows the result. `groundedness` answers "is this citation real"; the missing axis is "does
this citation support this value", and nothing computes it today.

A spike measured the idea against the annotated corpus and against the recorded single-shot
extractions. Four results decided it.

_The model's own confidence cannot detect silence._ Asked to choose an enum member for 61 leaves
per transcript, mean confidence was 0.929 on leaves the auditor actually spoke and **0.939 on
leaves nobody mentioned** — silence scored higher. Gating at 0.95 still admitted 77% of the
invented values. This independently reproduces why `confidence` was abandoned; `provenance.ts`
already records the field-side half of the same finding.

_Groundedness discriminates almost nothing in practice._ Across 124 committed leaves of real
single-shot output, **124 were `grounded`** — no near-misses, no ungrounded. There is no
grounded x supported 2x2 to merge into; there is one column.

_A verification question does work, but only in aggregate._ Asking P(wrong) rather than
P(supported) caught 100% of substituted values and 97.6% of the model's own inventions. But on
real extractions **identical mappings landed on both sides of any threshold**: `natural_gas` from "a gas furnace" scored 0.38 in one transcript and
0.65 in another; the age band `11-15` scored 0.41 for "maybe twelve years old" and 0.61 for "About
fifteen years old". A flag an auditor sees on one leaf and not on its twin is a flag they learn to
ignore.

_Much of what remains is schema distance, not error._ Telling the verifier the leaf's enum members
dropped the flagged count from 16 to 10, clearing exactly the faithful-encoding cases. Six of the
ten survivors were one field, an equipment/duct axis conflation the corpus already annotates as a
schema finding rather than a model failure.

_One three-way choice beats two nouls._ The first formulation asked two orthogonal nouls —
"is this unsupported?" and "does the source report this field at all?" — aggregated with `max`.
TypeSafe's own citation-check cookbook instead asks ONE choice over three outcomes: the source
`supports` the value, `contradicts` it, or `says_nothing` about it. Measured on the same cells,
at a matched false-escalation rate of 8.4%, the choice caught **97.9%** of substituted values
against the two nouls' 87.4%, with invented values a tie (92.1% vs 92.4%). Two structural reasons
sit behind the number: a choice returns a distribution and a confidence rather than a maximum over
two independent probabilities, and it cannot produce the incoherent states two nouls can — both
high, or both low.

The cookbook's step 1 is a string match with normalisation, which is `spanGroundedness`; the
limitation it names — that a truncated or reworded quote reads as fabricated — is what this repo's
`near-miss` tier already solves. Only its step 2 was missing.

## Decision

The judgement is a **judging combinator**, `corroborateExtractor` — the second after
`validateExtractor` — and it never reaches a human.

It wraps an `Extractor`, takes a census, hands it to a synchronous policy, and either returns the
result by identity or throws a `TerminalError`, so the shipped default arbiter falls through to the
next rung (ADR 0002). The SDE cascade's escalation is then `fallbackExtractor([corroborated(cheap),
reasoning])` with no new scheduling and no arbiter change. It refuses `"row"` and `"none"`
provenance at construction, like its sibling (ADR 0003).

**The judgement is one `choice` per committed leaf, over `supports` / `contradicts` /
`says_nothing`**, told the leaf's enum members — without them the verifier reads schema encoding
as hallucination. A verdict other than `supports` is what counts against the ratio.

**The census carries the verdict, not just a number.** `contradicts` and `says_nothing` mean
different things and invite different repairs: a contradicted value is wrong where the field WAS
discussed, which a re-ask can fix; an unsupported one was never mentioned, and the honest repair
is null. The combinator exposes the distinction so a consumer can act on it. **No consumer is
required to.** Gap-fill's candidate selection reads a leaf's score and needs to know nothing about
these three outcomes, so its contract does not mention them and does not change when they do.

**The policy thresholds a ratio of committed leaves, never a single leaf.** That is the whole
consequence of the variance above: a count aggregates away noise that makes one leaf's score
unusable.

**The ratio is a required argument with no default.** Nothing measured here justifies a number.
The old-schema figure (10 of 124 committed leaves) is from a superseded 23-field schema, and
producing current-schema extractions to replace it is credential-limited rather than merely
expensive: one `perGroupExtractor` run carries the 467-leaf schema through 20 groups for ~376k
input tokens, which exhausts the Helix dev token's burst spend budget in a single transcript. A
default would therefore be a guess wearing a measurement's clothes, and a wrong one is silent —
too high and the rung never falls through, too low and every result escalates at full price.
Requiring the ratio puts the choice at the call site, where the host knows what a wasted
escalation costs it.

Nothing is added to `ReviewField`, to `BuildReviewRequestOptions`, or to the envelope. In
particular the score does **not** go on `Extracted<T>`: that envelope holds the model's own claims,
and a check on those claims does not belong in the same bag — which is the mistake `confidence`
embodies. Avoiding it also avoids a migration on persisted data.

## Consequences

**ADR 0004 does not transfer.** A judging wrapper emits no progress units because it "delegates
exactly one run and does no work of its own". `corroborateExtractor` does work of its own — one or
more verification calls — so that reasoning does not cover it, and whether it reports units is an
open question this ADR does not settle.

**`groundingCensus` stays pure; the combinator does not.** The census is documented as pure, no
I/O, and `ValidationPolicy` is synchronous. Corroboration needs a network call between census and
policy, so it extends the census asynchronously and leaves the policy synchronous. That asymmetry
is why this is a sibling combinator rather than an option on `validateExtractor`.

**An auditor is never told a value looks uncorroborated.** The signal picks a rung; it does not
annotate a card. A host that wants to show a reviewer why a value is suspect has to wait for
evidence that per-leaf scores are stable enough to act on, which this spike did not find.

**Online only, and proxied.** `api.typesafe.ai` returns no `access-control-allow-origin` for any
origin tested, so a browser host cannot call it directly. Corroboration is a rung that exists when
the host has a proxy and connectivity, never on the offline path.

**Every call site must choose a ratio it cannot yet justify from data.** That cost is accepted
rather than hidden: a required argument makes the guess visible and revisable, where a default
would be inherited silently. The one current-schema data point measured — 23 committed leaves,
5 uncorroborated, ratio 0.217, on one transcript from one model — is recorded as a magnitude, not
a recommendation.

**Groundedness stays near-useless on the current schema too.** The same run had 22 of its 23
committed leaves `grounded`, reproducing on the shipped 467-leaf schema what was measured on the
superseded one. The premise this ADR rests on is not an artifact of the old field set.

**The aggregate signal may be worth more than the rung.** Six of ten surviving flags converging on
one field, matching what human annotators found independently, suggests this measures schema
quality as much as extraction quality. That is a design-time use needing no runtime integration,
and it is not pursued here.
