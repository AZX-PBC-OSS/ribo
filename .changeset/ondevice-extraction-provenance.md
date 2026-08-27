---
"@azx/ribo-core": major
---

`ExtractStep` now returns `{ fields, engine? }` instead of a bare field map, and the outbox
records which engine produced an extraction.

**This is a breaking change for anyone who implements `ExtractStep` directly.** The step used to
resolve to `ExtractedFieldMap`; it now resolves to an object carrying that map under `fields`,
plus an optional `engine`. A bare-map-or-wrapper union was considered and rejected:
`ExtractedFieldMap` is `Record<string, unknown>`, so a legitimate field map could itself carry a
`fields` key and no runtime check could tell the two apart. One shape, always.

`toExtractStep` handles the wrapping for anyone composing an `Extractor`, so implementations that
go through it need no change beyond the type.

Why it exists: an extractor that chooses between transports — a managed model when online, an
on-device one when not — knows something the reviewer needs. By review time that extractor is long
gone, and the reviewer's question is not "which engine produced field 12" but "should I trust this
card less than usual". `ExtractionResult.usage` gains an optional `engine`, the step carries it,
and the relay persists it as `extractedBy`.

The outbox schema moves to **version 4** with an identity migration. Existing documents have no
engine to name, which is the correct state for them; nothing reads `extractedBy` to decide
behaviour, so its absence degrades a review badge rather than the state machine.

---

Also adds **`compositeExtractor`** — the extraction sibling of `firstCapable`. It takes an ordered
list of `{ source, extractor }` entries, probes each source's capability, and runs the first
`ready` one for a whole extraction, stamping its engine onto `usage.engine`.

It lives here, beside the `Extractor` seam it composes, for the same reason `firstCapable` lives
beside `Transcriber`. An earlier revision put it in `@azx/ribo-extractor-openai` on the grounds
that it needed a `ChatClient`; it does not. It reads exactly two things from an entry — an engine
id and a `capability()` — and never sends a request, so it takes a structural `CapabilitySource`
and stays free of any transport concept. `CapableChatClient` satisfies that without declaring it.

One deliberate difference from `firstCapable`: **the preference order is inverted.** Transcription
puts on-device first because it is free and private; extraction puts the managed path first,
because a small local model is worse and is accepted only when the alternative is nothing.
