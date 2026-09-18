---
"@azx/ribo-core": minor
---

Add `hedgedExtractor(primary, hedge, options)` — start a primary extraction; if it has not settled
within a delay, start a hedge and take whichever finishes first, cancelling the loser so the usual
case bills for one. The extraction counterpart of `hedged`, mapping its resolution rules onto the
`Extractor` seam: a caller cancellation is never a hedge trigger (rule 0), a non-cancellation
primary rejection fails over immediately without waiting out the remaining delay (rule 5), both
rejecting propagates the primary's error (rule 7), and each lane gets its own `AbortController`
composed with the caller's signal via `AbortSignal.any` so the loser is actually cancelled. The
delay is required and core ships no default — core has no model of how long an extraction takes.

**The cost, stated plainly:** whenever the hedge fires, two extractions are dispatched, and
cancellation limits but does not eliminate the waste — a provider may already have billed a
cancelled call by the time its abort lands. `onHedge` exists so a host can measure how often that
happens: it fires once at settlement with the winner (`"primary"`, `"hedge"`, or `undefined` when
both failed), separating the hedge's fire rate from its win rate. The returned `usage` is the
winner's only — the loser's is not added — because `usage` describes the result that was returned,
as in every other combinator; counting `onHedge` fires is the honest measure of what hedging costs.
