---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": minor
---

Two new combinators over the `Extractor` seam, and a cancellation marker that
lets a combinator distinguish "the caller stopped this" from "this failed"
without depending on a transport package.

`retryExtractor` wraps any extractor with the attempt loop — transient failures
retried with full-jitter backoff, terminal errors and cancellations rethrown
untouched, `usage.calls` summed across the attempts that reported one. Its
`delay` takes the already-computed backoff result, so a caller that wants no
backoff passes a function that resolves immediately.

`timeoutExtractor` bounds one extraction to a deadline, racing the work against
a timer so a hung inner cannot hang the run, and aborting a signal the inner can
honour. Its `ExtractionTimeoutError` is deliberately not cancellation-branded:
a deadline elapsing and a caller cancelling are different events, so an outer
`retryExtractor` still retries a timeout.

The marker is a unique-symbol brand (`CANCELLATION`) with a total
`isCancellation` predicate and a `CancellationError` for core's own throws. A
foreign transport opts in by carrying the brand as a truthy own property —
`ChatError.aborted` now does exactly that, and nothing else about chat error
classification changes.
