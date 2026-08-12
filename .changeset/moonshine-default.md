---
"@azx/ribo-transcriber-ondevice": major
---

The default on-device model is now **Moonshine**, not Whisper.

Whisper pads every input to its 30-second receptive field before the encoder runs, so cost is set by
the window rather than by the speech — measured at 1.26× across a 14.5× range of audio. Moonshine's
feature extractor passes audio through unpadded and is 4–16× faster at short utterance lengths, which
is what live transcription needs.

Breaking:

- `DEFAULT_MODEL_ID` is `onnx-community/moonshine-base-ONNX`. Pass `modelId: "Xenova/whisper-base.en"`
  to keep the previous behaviour.
- **`hints` now THROW on a model that cannot be primed**, rather than being ignored. Domain-jargon
  priming injects a decoder prefix, which needs a trained prior-context token (Whisper's
  `<|startofprev|>`). Moonshine has none — `all_special_tokens` is empty — so a prefix is transcribed
  instead of the audio: it echoes the jargon, emits a comma, and stops. Silently ignoring hints would
  leave a caller believing they were primed; silently applying them would return that comma as
  somebody's transcript.

Accuracy on our corpus is **not yet re-measured**. `docs/implementation/14` recorded hints at up to
−18.1 pp WER on the jargon-dense combustion-safety transcript, so the figures in that document
describe a configuration this package no longer ships by default.
