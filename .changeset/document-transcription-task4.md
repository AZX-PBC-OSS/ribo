---
"@azx/ribo-core": patch
---

Add `fallbackTranscriber` and the transcription arbiter vocabulary.

Adds `transcription-arbitration.ts` (the transcriber-side sibling of `arbitration.ts`) with `TranscriptionOutcome`, `TranscriptionArbiterInput`, `TranscriptionArbiterVerdict`, `TranscriptionArbiter`, and the `unsupportedFallsThrough` default arbiter (D7 rules: first success accepted, exhaustion gives up retryable-first, UnsupportedItemError and TranscriberUnavailableError continue, other errors give up). Adds `fallback-transcriber.ts` — `fallbackTranscriber(transcribers, arbiter, options?)` returning a `Transcriber<S>` that calls candidates in order without consulting `capability()`, the property distinguishing it from `firstCapable`. No result stamping: `Transcript.engine` is already required. Makes `FakeTranscriber` generic over `CaptureItem` (default `Recording`, so `new FakeTranscriber()` is unchanged) and adds `failWithUnsupported`/`failNextWithUnsupported` setters; call-log fields rename from `recording`/`audio` to `item`/`bytes` to match the contract.
