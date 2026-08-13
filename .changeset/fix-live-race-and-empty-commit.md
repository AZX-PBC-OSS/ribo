---
"@azx/ribo-transcriber-ondevice": patch
"@azx/ribo-core": patch
---

Fix a session leak when `liveClose` arrives before `liveOpen` completes, and
stop dropping empty commit segments silently.

- A `liveClose` that arrives while `openLiveSession` is still loading the Silero
  model no longer leaks the session. The close is recorded as pending and
  processed when the open completes — the session is closed and `liveClosed` is
  posted so the main thread can tear down its listener. This is the race that
  `prime()` hits on every call, but it is legitimate traffic in general: a user
  who stops recording immediately hits the same path.
- An empty transcription on a commit is now posted as a `liveSegment` with
  `kind: "commit"` and `text: ""`, rather than silently dropped. The region
  buffer has already advanced on a commit, so an empty ASR result means that
  audio's text is gone from the preview with no trace. Posting the empty segment
  gives the host a signal that a commit happened. The tail path keeps its
  `text.length > 0` guard — an empty tail just means "no speech yet".
- Corrected stale comments in `worker.ts`, `protocol.ts`, and `ribo-core/live.ts`
  that had drifted from the code. The VAD-exclusion comment now states what is
  guaranteed (serialize for ASR-with-ASR/ASR-with-batch, RegionVad's internal
  chain for VAD-with-VAD) versus what is assumed (VAD and ASR do not overlap,
  which holds for the WASM backend but is a known risk under WebGPU).
