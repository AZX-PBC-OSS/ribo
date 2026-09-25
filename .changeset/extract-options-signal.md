---
"@azx/ribo-core": major
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

`fallbackExtractor`, `raceExtractor` and `compositeExtractor` forward it too, through both
arbitration engines, and `FakeExtractor` now records the options it was handed so a combinator
test can assert the signal arrived rather than assuming it.

Two motivations are only partly served and are honest about it. A group that is an opaque
`Extractor` can now be cancelled, which is what the per-group work needs. But the relay still
wraps its extract step in `withTimeout` with no signal channel, so a timed-out session extraction
does not yet cancel its request, and `threePhaseExtractor` resolves with all-null fields on abort
rather than rejecting. Both are recorded as follow-ups.

The plugin-storage handle is deliberately not in this bag; an options object can grow a field
without breaking, and that one is not designed yet.
