# Transcription: Measured

On our own measured corpus, `whisper-base.en` (fp32, WASM) transcribes at **RTF 0.16** (≈6× faster than
real time) with **8.0 % WER** on clean authored audio, and a warm, offline start rebuilds the pipeline
from cache in **~0.8 s**. These are a **floor**, established on TTS audio with no noise — not a field
forecast.

::: info Content coming
The full measured tables and the transcription→extraction interaction are repackaged in the content
pass.
:::
