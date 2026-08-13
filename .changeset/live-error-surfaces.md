---
"@azx/ribo-core": patch
"@azx/ribo-transcriber-ondevice": patch
---

Fix a mid-session live-transcription error being silently dropped, and one failed
utterance killing the preview for the entire remaining recording.

**The dropped error.** `feedLiveFrame` in the worker posted `liveError` on any failure,
but `OnDeviceLiveSession`'s message listener only forwarded `liveSegment` — the
`liveError` listener lived in `openSession`'s promise and was removed by `cleanup()` as
soon as `liveOpened` arrived. After open, a worker error was posted into the void: no
console output, no host signal, no error on any observable. `LiveSession` gains an
`errors$` observable (separate from `segments$`, which stays clean so a per-utterance
failure does not end the segment stream and a subscriber without an error handler does
not get an unhandled rejection), and `OnDeviceLiveSession` now forwards `liveError` to
it.

**The killed session.** `feedLiveFrame` deleted the session from `liveSessions` on any
error — VAD failure or a single bad `transcribe` call alike. The deletion meant every
subsequent frame no-op'd on the map lookup forever, so one transient OOM two minutes
into a 30-minute audit silenced the preview for the rest of the recording. The error
boundary is now split: VAD failures are session-fatal (the VAD processes every frame;
if it throws, every future frame will too), but per-utterance transcription failures
skip that utterance, surface the error, and keep the session alive — the next utterance
may transcribe fine.
