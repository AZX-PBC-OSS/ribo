---
"@azx/ribo-transcriber-ondevice": minor
---

Add a streaming Silero VAD that turns a flow of 512-sample audio frames into closed
utterances during recording.

`StreamingVad` runs Silero VAD per frame, carrying the model's recurrent state tensor
forward — the entire streaming-state mechanism, solved by the model rather than by us.
Hysteresis on the returned probability (enter 0.3 / exit 0.1) bins frames into speech
and silence; a pre-speech FIFO (80 ms) prevents clipped onsets; 400 ms of trailing
silence closes an utterance; a 30 s buffer cap emits and carries the overflow; and
regions shorter than 250 ms of speech are discarded as noise. Every constant is adopted
from `transformers.js-examples/moonshine-web`.

A `ProbabilityDetector` seam keeps the frame-loop logic testable in node unit tests
against a fake probability source — the model is not the thing under test. The real
Silero detector (`createSileroDetector`) is exercised only by a manual browser test
that downloads the 2.14 MB fp32 model.

The batch-path VAD (`pyannote-segmentation-3.0`) is unchanged — this is a second,
streaming VAD used only by live transcription, not a replacement.
