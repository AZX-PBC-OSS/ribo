---
"@azx/ribo-core": minor
---

`phasedExtractor` — a combinator that runs a list of phases, owning everything that is
not "what to ask": scheduling, per-item retry, cancellation, the running deadline and
the `PhaseUnit` progress stream.

A multi-pass extraction strategy becomes a list of narrowing steps — each phase
declaring `plan`/`run`/`merge` over the Wave 3a vocabulary — rather than a bespoke loop.
The engine runs phases in order, fans each phase's items out through a bounded pool
(per-phase `concurrency` or a run default of 4), folds outcomes back through the phase's
own `merge`, then normalizes once and parses once at the trust boundary. Each item's
retry loop composes the extracted `retryAsync` policy (also new: the attempt loop behind
`retryExtractor`, now exported for work whose `run` is not an `Extractor`), with
per-phase `maxRetries` derived against that phase's share of the running deadline.
Failure policy is per phase (`"abort"` or `"skip"`); cancellation propagates under both.
A phase that declares `produces` but does not write the key throws at its own boundary,
making `requires`/`produces` a runtime guarantee rather than a declaration.
