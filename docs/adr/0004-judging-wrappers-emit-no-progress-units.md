# 0004. A wrapper that delegates and judges emits no progress units

Status: Accepted
Date: 2026-09-17

## Context

This repo has an `ExtractionObserver` seam: extractors report `ExtractionUnit`s so a host can show
progress. An early draft gave each judging combinator an observer that reported one `WholeUnit` per
delegated run.

That is double-counting. `validateExtractor`, `budgetExtractor` and `cachedExtractor` each delegate
**exactly one** run and do no model work of their own, so their units duplicate the inner
extractor's stream unit for unit. A host wiring both — the natural thing to do — sees every step
twice.

The distinction that matters is not "is this a combinator" but **does it do work the inner
extractor cannot report?**

## Decision

A wrapper that delegates and judges stays silent. A combinator that runs candidates of its own
reports them.

So the three single-delegate wrappers carry no observer in their options bag, and the absence is
pinned by test rather than merely described. `consensusExtractor` runs N candidates, but it still
does not emit `ExtractionUnit`s — it exposes `onContested`, a domain notification carrying a leaf
path and its samples. That escapes the rule precisely because it is **new vocabulary no inner
extractor emits**, so it cannot double-count, and it adds nothing to the `ExtractionUnit` union.

## Consequences

Progress streams stay truthful under composition, which is what makes these combinators safe to
stack.

The cost is that `onContested` is the _only_ channel for the contested count — the signal
`consensusExtractor` exists to produce. A host obtains it by counting callbacks; there is no tally
on `ExtractionResult`, because adding one is a change to a seam every extractor implements. That
trade is deliberate and is recorded on the `OnContested` type itself.

A stale doc comment claiming `validateExtractor` reported a `WholeUnit` survived the original
decision by three waves and was corrected only when a later reviewer read the file against its
tests. The pin exists so the next such drift fails rather than misinforms.
