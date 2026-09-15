---
"@azx/ribo-core": minor
---

Split transcript combination into a pluggable, pure contract.

`joinSessionTranscript` used to fuse two unrelated jobs: listing a session's transcribed captures from the database, and deciding how their texts combine. The combination policy could not be tested without a database, and could not be replaced at all.

`TranscriptCombiner` — `(parts: AnnotatedTranscript[]) => AnnotatedTranscript` — is the pure policy. The relay keeps the I/O (`listSessionTranscriptParts` lists, filters, sorts by `seq`, and builds parts with `seq`/`kind`/`id` in each part's annotations bag), then calls the combiner. Inject a custom combiner through `RelayOptions.combineTranscripts`; the default (`createDefaultTranscriptCombiner`) reproduces the previous output byte-for-byte and accepts `{ markCaptures: true }` for per-capture attribution markers.

This supersedes the narrow `RelayOptions.joinOptions` field (removed): there is now one way to reach a combination policy through the relay, not two. `JoinSessionTranscriptOptions` is removed; `joinSessionTranscript` now takes an optional `TranscriptCombiner` as its third parameter instead.
