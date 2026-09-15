---
"@azx/ribo-core": minor
---

The relay's session extract step now has a cancellation channel — the gap
Task 9's `ExtractOptions` changeset named as a motivation and deferred.

`SessionExtractStep` takes the same optional `ExtractOptions` second parameter
`Extractor.extract` does — the same type in the same position, because
`toSessionExtractStep` collapses one contract onto the other and forwards the
bag whole. The relay passes a signal it aborts when the step timeout fires, so
a session extraction that exceeds `stepTimeoutMs` has its in-flight request
cancelled instead of running to completion behind the rejection.
`withTimeout` grew an `onTimeout` hook that fires before the rejection.
