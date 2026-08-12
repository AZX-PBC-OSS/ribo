---
"@azx/ribo-core": minor
"@azx/ribo-transcriber-ondevice": minor
---

Add the live-transcription seam: `LiveSession` and `LiveTranscriber` in
`ribo-core`, with an on-device implementation in `ribo-transcriber-ondevice`.

`LiveSession.feed(frame)` is synchronous — it posts the frame to a worker
and returns before inference — so the audio callback that calls it is never
blocked. `segments$` emits one transcribed utterance at a time as the
streaming VAD closes regions. `close()` marks the session closed; late
replies from a closed session are discarded by `sessionId`, not by
"the observable has no subscribers".

`LiveTranscriber.liveCapability()` is separate from `capability()` because
live additionally needs the streaming VAD (Silero): "ASR cached but VAD
missing" is a real state the batch probe cannot express.

The worker protocol gains `liveOpen`/`liveFeed`/`liveClose` (main→worker)
and `liveOpened`/`liveSegment`/`liveError` (worker→main). VAD and ASR
calls chain through the existing `serialize` queue so they never interleave
with a batch `transcribe` — transformers.js does not support simultaneous
inference in one worker.
