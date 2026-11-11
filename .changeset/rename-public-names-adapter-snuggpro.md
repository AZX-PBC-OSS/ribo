---
"@azx/ribo-adapter-snuggpro": minor
---

Follow @azx/ribo-core's renames: `Recording` is now `AudioCapture`, `recordingSchema` is now `audioCaptureSchema` (and `baseRecordingSchema` is now `baseAudioCaptureSchema`), and `ChatRequest.response_format` is now `ChatRequest.responseFormat`. The wire schema types that model Snugg Pro's JSON keep their snake_case spelling, and persisted data is unchanged.
