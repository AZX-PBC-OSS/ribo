---
"@azx/ribo-ui-react": minor
---

Add `liveTranscriber` to `RiboInstances` and `UseRecorderOptions` so a host
can supply a `LiveTranscriber` through `RiboProvider`. `useRecorder` exposes
it in its result so a UI can indicate whether live preview is available.
