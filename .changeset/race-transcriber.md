---
"@azx/ribo-core": minor
---

Add the `raceTranscriber` combinator — start every capable transcriber at once and let the existing transcription arbiter decide which transcript to take.

The transcription-side counterpart of `raceExtractor`. The policy vocabulary is not new: it reuses `TranscriptionArbiter`, `TranscriptionOutcome` and `applyTranscriptionVerdict` from `transcription-arbitration.ts`, whose `outcomes` contract is settlement order precisely so a concurrent combinator would not need to change it. Outcomes reach the arbiter in settlement order after each lane settles, with `exhausted` true only once every lane has settled.

New exports:

- `raceTranscriber(transcribers, options)` — returns a `CompositeTranscriber`, so it is drop-in interchangeable with `firstCapable` and `hedged`: `capabilities()` reports the roster and `invalidate()` keeps working.
- `RaceTranscriberOptions` — `engine` (defaults to `"race"`), `arbiter` (defaults to `unsupportedFallsThrough`), `ttlMs`, `now`.
- `CapabilityCache` / `CapabilityCacheOptions` — the TTL-keyed capability cache extracted from `firstCapable`'s private copy now that a third combinator needs the shape. `firstCapable` and `hedged` deliberately keep their own copies for now — no shipped behaviour changes.

One new arbiter default ships beside this: `preferEngineOrder(ranking)`. Under a sequential ladder settlement order IS preference order, so `unsupportedFallsThrough`'s "first success wins" means "best success wins"; a race breaks that identity, and without this a worse engine that settles first would win. `preferEngineOrder` accepts the best-ranked success once nothing better-ranked can still arrive, waits while one can, and at exhaustion gives up with the first error. `unsupportedFallsThrough` stays the default.

**The cost is real, and it is the dispatch model: every capable engine is started at once, so a race that includes a managed engine uploads the audio every time** — exactly what `firstCapable`'s selection-before-dispatch design avoids. Capability gating excludes engines that are not `ready` before anything is sent (a managed engine that cannot serve the item does not receive the upload), but every engine that _is_ ready gets the audio. A deployment that will not pay for that composes `firstCapable`; concurrency is opt-in by name, not a flag.

Losers are cancelled: each lane gets its own `AbortController` composed with the caller's signal via `AbortSignal.any`, and is aborted when the race settles. A cancelled loser contributes no outcome to the arbiter; a caller abort rejects the run as a cancellation and is never shown to the arbiter. Every lane promise carries a rejection handler, so a losing failure never surfaces as an unhandled rejection. There is no deadline option — `TranscribeOptions` has no such member, so one would be an option no transport honours.
