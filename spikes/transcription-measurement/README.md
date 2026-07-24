# On-device transcription measurement spike (Phase 3, Task 4)

The central technical bet of Phase 3 — _"a real transcript, computed on the device"_ — checked with
**our own measured numbers**. Nothing here is cited from elsewhere; every figure comes from a run in
this directory. The written-up results live in
[`docs/implementation/14-transcription-measurement.md`](../../docs/implementation/14-transcription-measurement.md).

## What it measures

- **Part A — quality + performance.** Synthesize speech (macOS `say`) from the 14 authored Snugg Pro
  transcripts, run it through the real `OnDeviceTranscriber` (WASM device, fp32), and measure
  real-time factor (RTF), Word Error Rate (WER) against the authored source text, cold/warm model
  load, and peak browser memory. Plus a hinted-vs-unhinted WER delta.
- **Part B — the transcription→extraction interaction.** Feed the **on-device (noisy)** transcripts
  through the same blind extraction pipeline the extraction spike uses, and diff the hazard rates
  against the committed **clean-text** baseline (`spikes/extraction-snuggpro/results/*-score.json`).
  This is what the clean-text extraction spike could not test.
- **Part C — the floor caveat.** TTS audio is clean (no noise, mic handling, disfluency, cross-talk).
  These numbers are a **FLOOR, not a forecast**, and not a substitute for the real-recording gate
  (still gated on recording consent — out of scope).

## Why chunking (and why it is at harness level)

At `say -r 155` (~2.85 words/s) all but the shortest corpus transcript exceeds Whisper's 30 s window,
and the transcriber does not chunk yet (`worker.ts`: audio beyond 30 s is silently clipped). So
`synth.mjs` splits each transcript into ≤~24 s segments at sentence boundaries and the browser harness
transcribes each segment and concatenates the text. **The transcriber itself is unchanged and still
30 s-bound** — the chunking lives entirely in the spike.

## Reproduce

Prereqs: `pnpm install`, macOS (`say`/`afconvert`/`afinfo`), and — for Part B — the `codex` and/or
`opencode` CLIs on `PATH`. None of this runs in `./check.sh` (it downloads a real model and runs
minutes of inference).

```bash
# 0. Synthesize the audio fixtures (git-ignored WAVs + manifest under testdata/).
node spikes/transcription-measurement/synth.mjs

# 1. Part A — measure a model end-to-end. Args: <modelId> [unhintedSlugsCsv] [limit] [tag].
#    Writes results/ondevice/<modelSlug>/*.txt and results/metrics-<modelSlug>.json.
node spikes/transcription-measurement/run.mjs Xenova/whisper-base.en \
  01-attic-r-value-shell,05-full-walkthrough,07-combustion-safety,12-wrong-field-old-unit
node spikes/transcription-measurement/run.mjs Xenova/whisper-tiny.en \
  01-attic-r-value-shell,05-full-walkthrough,07-combustion-safety,12-wrong-field-old-unit

# 2. Part B — extract from the on-device transcripts, then score vs the clean-text baseline.
node spikes/transcription-measurement/extract-ondevice.mjs opencode whisper-base.en
node spikes/transcription-measurement/score-partb.mjs   opencode whisper-base.en
# (repeat with `codex` for the second extractor)

# self-check for the WER implementation (standalone; not in ./check.sh)
node spikes/transcription-measurement/wer.test.mjs
```

The browser half (`measure.manual.ts`) runs under its own Vitest config
(`vitest.measure.config.ts`, headless Chromium via Playwright) and emits `@@MEASURE@@` /
`@@MODELMETA@@` JSON lines that `run.mjs` captures from stdout — while `run.mjs` samples the
Playwright-Chromium RSS for the peak-memory figure.

## Files

| file                         | role                                                                 |
| ---------------------------- | -------------------------------------------------------------------- |
| `synth.mjs`                  | TTS → 16 kHz mono WAV segments + `testdata/manifest.json`            |
| `wer.mjs` / `wer.test.mjs`   | Word Error Rate (stated normalization) + self-check                  |
| `vitest.measure.config.ts`   | manual-only browser config (NOT wired into `./check.sh`)             |
| `measure.manual.ts`          | browser harness: real `OnDeviceTranscriber` over the corpus          |
| `run.mjs`                    | driver: runs the harness, samples RSS, computes WER, writes metrics  |
| `extract-ondevice.mjs`       | Part B: blind extraction from the on-device transcripts              |
| `score-partb.mjs`            | Part B: score vs ground truth (noisy spans) + diff vs clean baseline |
| `results/metrics-*.json`     | committed measured summaries (RTF/WER/load/memory)                   |
| `results/partb-*-score.json` | committed Part B interaction deltas                                  |

`testdata/*.wav`, `testdata/manifest.json`, and the raw `results/ondevice/` + `results/extract/`
outputs are git-ignored (regenerable); the `*-score.json` / `metrics-*.json` summaries are committed.
