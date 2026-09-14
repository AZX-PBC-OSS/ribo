---
"@azx/ribo-core": major
"@azx/ribo-extractor-openai": major
"@azx/ribo-extractor-ondevice": major
---

`Extractor.extract` takes an optional `ExtractOptions` second parameter, carrying an
`AbortSignal`.

The signal is threaded to the transport, not just through the signature: `singleShotExtractor`,
`perGroupExtractor`, `gapFillExtractor`, `schemaRetryExtractor`, `scopedInstanceExtractor` and
`threePhaseExtractor` all forward it to `ChatClient.complete`, so an abort cancels the in-flight
request rather than merely rejecting the promise while the request completes unseen.

In `perGroupExtractor` the caller's signal is combined with the run's own sibling-failure
controller via `AbortSignal.any` rather than replacing it — they are independent reasons to stop,
and substituting one for the other silently disabled sibling abort whenever a caller passed a
signal.

This exists because `raceExtractor`'s losing candidates and the relay's timed-out calls kept
running after nobody wanted their answer, and because a group that is an opaque `Extractor` has no
other way to be cancelled. The plugin-storage handle is deliberately not in this bag; an options
object can grow a field without breaking, and that one is not designed yet.
