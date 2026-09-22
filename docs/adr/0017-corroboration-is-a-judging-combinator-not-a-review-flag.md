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
P(supported), over two orthogonal checks aggregated with `max`, caught 100% of substituted values
and 97.6% of the model's own inventions. But on real extractions **identical mappings landed on
both sides of any threshold**: `natural_gas` from "a gas furnace" scored 0.38 in one transcript and
0.65 in another; the age band `11-15` scored 0.41 for "maybe twelve years old" and 0.61 for "About
fifteen years old". A flag an auditor sees on one leaf and not on its twin is a flag they learn to
ignore.

_Much of what remains is schema distance, not error._ Telling the verifier the leaf's enum members
dropped the flagged count from 16 to 10, clearing exactly the faithful-encoding cases. Six of the
ten survivors were one field, an equipment/duct axis conflation the corpus already annotates as a
schema finding rather than a model failure.

## Decision

The judgement is a **judging combinator**, `corroborateExtractor` — the second after
`validateExtractor` — and it never reaches a human.

It wraps an `Extractor`, takes a census, hands it to a synchronous policy, and either returns the
result by identity or throws a `TerminalError`, so the shipped default arbiter falls through to the
next rung (ADR 0002). The SDE cascade's escalation is then `fallbackExtractor([corroborated(cheap),
reasoning])` with no new scheduling and no arbiter change. It refuses `"row"` and `"none"`
provenance at construction, like its sibling (ADR 0003).

**The policy thresholds a fraction of committed leaves, never a single leaf.** That is the whole
consequence of the variance above: a count aggregates away noise that makes one leaf's score
unusable.

The verifier is told each leaf's enum members, because without them it reads schema encoding as
hallucination.

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

**The default rejection fraction is unmeasured.** The 10-of-124 figure is from the superseded
23-field schema. The equivalent number on the current schema is not known, and the default should
not be fixed until it is.

**The aggregate signal may be worth more than the rung.** Six of ten surviving flags converging on
one field, matching what human annotators found independently, suggests this measures schema
quality as much as extraction quality. That is a design-time use needing no runtime integration,
and it is not pursued here.
