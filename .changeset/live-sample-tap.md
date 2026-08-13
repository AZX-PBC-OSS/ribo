---
"@azx/ribo-core": minor
---

Add an optional `onSamples` tap to `Recorder` for live transcription.

When `onSamples` is supplied, the same `getUserMedia` stream also feeds an
`AudioWorklet` that emits 512-sample frames of 16 kHz mono PCM — the frame size
Silero VAD consumes. Without the callback, behaviour is byte-for-byte what it is
today: the stream feeds only `MediaRecorder`, and no worklet is created.

The worklet ships as a separate build entry (`@azx/ribo-core/worklet`), loaded by
`new URL("./worklet.js", import.meta.url)` — the same packaging pattern
`@azx/ribo-transcriber-ondevice` uses for its `./worker` subpath. A consumer's
bundler emits the worklet as a separate asset.

The tap is best-effort: if the worklet fails to load or throws, recording
continues and the audio still reaches disk. A preview is a nicety; the audio is
the product.

New exports: `SampleTapOptions`, `SampleTapTeardown` (types for the
`createSampleTap` injection seam on `RecorderOptions`).
