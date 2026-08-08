---
"@azx/ribo-transcriber-ondevice": minor
---

Transcribe recordings longer than 30 seconds instead of silently truncating them.

`OnDeviceTranscriber` previously discarded all audio past Whisper's 30-second receptive
field with no error and no marker — a five-minute walkthrough produced a confident-looking
transcript of its first 30 seconds, which then fed the LLM field-extraction step.

Long recordings are now segmented with a voice-activity model
(`onnx-community/pyannote-segmentation-3.0`, 6 MB fp32) into non-overlapping chunks of at
most 30 seconds that, where possible, begin and end in silence — WhisperX's Cut & Merge.
Because the chunks do not overlap, their transcripts are simply concatenated: there is no
alignment step, and so no alignment step that can silently delete speech, which is the
failure mode of the obvious overlapped-sliding-window alternative.

Behaviour worth knowing:

- **Clips at or under 30 seconds are unchanged.** They bypass segmentation entirely and take
  exactly the path they always have; no voice-activity model is loaded.
- **`capability()` still reports `ready` with only the ASR weights cached.** The
  voice-activity model is a quality upgrade, not a prerequisite — an existing user who primed
  before this release keeps working, and long audio falls back to a fixed-window march that
  duplicates a little text but never loses any.
- **`prime()` now also fetches the voice-activity model**, and does not fail if that fetch
  fails. `estimateDownloadBytes` includes it; `capability()`'s `downloadBytes` reports only
  what is actually missing.
- **Inference is serialized per worker.** Concurrent `transcribe()` calls previously
  interleaved `generate()` against one shared ORT session; long audio widened that window
  considerably.

Known limitation, stated deliberately: voice-activity detection introduces its own path to
lost content — audio the model marks as non-speech never reaches Whisper, and nothing detects
that. Quiet speech in a noisy room is the case to watch. Thresholds are biased toward
over-transcribing, and short clips avoid the mechanism altogether.
