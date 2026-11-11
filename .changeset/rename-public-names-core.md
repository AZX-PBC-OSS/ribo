---
"@azx/ribo-core": minor
---

Rename four public names to read better next to the rest of the API. The packages are 0.x, so this ships as a minor with no deprecation alias.

- `Recording` is now `AudioCapture` (it pairs with `DocumentCapture`); `recordingSchema` is now `audioCaptureSchema` and `baseRecordingSchema` is now `baseAudioCaptureSchema`. Persisted data is unchanged — the `kind: "audio"` literal and every storage field name stay as they were.
- `hedged` is now `hedgedTranscriber`, matching `hedgedExtractor`; its option type `HedgedOptions` is now `HedgedTranscriberOptions`.
- `ChatRequest.response_format` is now `ChatRequest.responseFormat`, matching `maxTokens`. Only the TypeScript member changed: each transport still sends its current wire body, so OpenAI's chat surface keeps the `response_format` wire field.
- `createSequentialExtractor` and `createConcurrentExtractor` are no longer exported from the barrel. They stay as the internal engines behind `fallbackExtractor` and `raceExtractor` — use those instead.
