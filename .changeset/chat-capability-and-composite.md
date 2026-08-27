---
"@azx/ribo-extractor-openai": minor
---

The chat transport seam gains a capability contract, and a composite extractor that selects
between transports per extraction.

`ChatCapability` (`ready` / `needs-download` / `unavailable`) and `CapableChatClient` are declared
beside `ChatClient`, at the layer both transports implement. They live here rather than in the
on-device package because `helixChat` and the composite are here, and putting the contract in a
package that depends on this one would invert the dependency.

`compositeExtractor` takes an ordered list of `{ chat, extractor }` entries, probes capability,
and runs the first ready one for a whole extraction. It is the extraction sibling of
`firstCapable`, with one deliberate difference: **the preference order is inverted.** Transcription
puts on-device first because it is free and private; extraction puts the managed path first,
because a small local model is worse and is accepted only when the alternative is nothing.

`helixChat` now reports capability from a live connectivity subscription rather than a snapshot,
so a dead uplink is recognised as soon as the model sees it. Passing no connectivity source keeps
today's unconditional `ready`, so existing callers are unaffected.

`perGroupExtractor` gains `perCallCeilingMs`, defaulting to the previous fixed 120,000 ms. The
retry budget is derived from it, and a transport whose calls take seconds rather than minutes
needs an honest figure or the derivation grants it zero retries.
