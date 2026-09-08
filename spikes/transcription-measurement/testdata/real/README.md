# Real field recordings

Asana: "Add audio files (and their results) to extraction accuracy documentation." Every number in
[`14-transcription-measurement.md`](../../../../docs/implementation/14-transcription-measurement.md)
was measured on TTS audio — a floor, not a forecast. This directory is where real recordings go so
that floor can finally be checked against real speech.

**Nothing in this directory is committed except this file.** The audio is real speech recorded by an
auditor — not the public repo's problem to carry, regardless of who holds the rights to it — so both
the raw files and any transcript text derived from them are git-ignored (see the repo `.gitignore`).
Only aggregate numbers (WER, RTF — no quoted text) make it into a commit, via `results/real/metrics-real.json`.

## Layout

```
testdata/real/
  <slug>.m4a | .mp3 | .wav      the raw recording, named real-NN-slug.<ext>
  ground-truth/
    <slug>.txt                   verbatim, human-corrected transcript — the actual ground truth
    <slug>.draft-ondevice.txt    starting draft from the on-device engine (written by score-real.mjs)
    <slug>.draft-managed.txt     starting draft from the managed engine (written by score-real.mjs)
results/real/
  _raw/ondevice.json             on-device engine's raw output + timing (git-ignored, has text)
  _raw/managed.json              managed engine's raw output + timing (git-ignored, has text)
  metrics-real.json              COMMITTED — RTF/WER numbers only, no transcript text
  extract/<source>/<slug>.json   extraction output per transcript source (git-ignored, real form
                                  content) — see "Extraction" below
```

## Extraction

Transcription is only half the ticket — "add audio files (and their results) to extraction accuracy
documentation" means the filled-in Snugg Pro form, not just the transcript. That's a SEPARATE step
from everything above, using the **current production extraction path**
(`singleShotExtractor` + `snuggProAdapter` + `normalizeFields`), not the `extraction-snuggpro` spike's
own `schema.ts`/`prompt.md` — those are a stale, pre-rebuild 23-flat-field schema; see
[`ground-truth-format.md`](../../../extraction-snuggpro/ground-truth-format.md) for why the real
corpus moved to the 51-leaf `snuggpro-instances-v3` shape.

```
REAL_EXTRACT_SOURCE=ondevice REAL_EXTRACT_BACKEND=claude \
pnpm exec vitest run --config packages/ribo-adapter-snuggpro/vitest.acceptance.config.ts extract-real
```

See [`extract-real.manual.ts`](../../../../packages/ribo-adapter-snuggpro/acceptance/extract-real.manual.ts)
for the full option contract (`REAL_EXTRACT_SOURCE`: `ondevice` | `managed` | `clean`;
`REAL_EXTRACT_BACKEND`: `claude` | `codex` | `openai`).

**Extraction can run today, without ground truth** — it only needs a transcript (the ASR drafts
already qualify). **Scoring it cannot** — that needs a Snugg Pro ground-truth file per clip
(`leaves`/`instances`, same format as the 14-transcript corpus), which itself needs the verbatim
`ground-truth/<slug>.txt` from the step above. Nothing here authors that file yet.

## Adding a recording

1. Drop the file in here as `real-NN-slug.<ext>` (m4a/mp3/wav all work — the on-device decoder and
   Azure's Fast Transcription endpoint both take the container as recorded, no transcode needed).
2. `node spikes/transcription-measurement/run-real-ondevice.mjs` — runs the real, unmodified
   `OnDeviceTranscriber` over every file in this directory. Unlike the synthetic corpus, no
   harness-level chunking is needed: the transcriber now segments audio past Whisper's 30 s window
   itself (`worker.ts`'s VAD-based `planChunks`).
3. `node spikes/transcription-measurement/transcribe-managed-real.mjs` — same files, through the real
   `ManagedTranscriber` against Azure (reads `AZURE_AI_FOUNDRY_API_KEY` /
   `AZURE_AI_FOUNDRY_OPENAI_BASE_URL` from `.env.local` at the repo root — copy it into a fresh
   worktree first, it isn't checked out).
4. `node spikes/transcription-measurement/score-real.mjs` — for any file with no
   `ground-truth/<slug>.txt` yet, this writes the two draft transcripts and stops there for that file
   (RTF is still reported; WER needs the correction below). For files that do have a ground truth, it
   computes WER for both engines and writes `results/real/metrics-real.json`.
5. **Listen to the recording and correct the better-sounding draft into `ground-truth/<slug>.txt`.**
   This is the one step nothing here can do for you — WER needs a transcript nobody's guessed at. Copy
   whichever draft is closer, fix it by ear against the audio, and re-run step 4.
