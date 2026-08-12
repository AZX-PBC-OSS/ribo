# Live-model comparison spike

**Question:** is Whisper's fixed 30-second window the live-latency floor it looks like, and does a
variable-length model escape it?

**Answer: yes to both, decisively — and it still does not make live transcription live**, because
the VAD, not the ASR, is where the latency actually is.

Every figure here comes from a run in this directory. Reproduce with:

```bash
node spikes/live-model-comparison/run.mjs
```

Prereqs: `pnpm install`, network (models download from the Hub), and the audio fixture — which is
**gitignored** (`.gitignore`: `**/testdata/*.wav`), so a fresh git worktree does not have it:

```bash
cp <main-checkout>/packages/ribo-transcriber-ondevice/testdata/*.wav \
   packages/ribo-transcriber-ondevice/testdata/
```

## Latency against utterance duration (ms, median of 3)

| utterance | whisper-base.en | moonshine-base | moonshine-tiny |
| --------- | --------------: | -------------: | -------------: |
| 2 s       |       **2 033** |        **126** |         **55** |
| 4 s       |           2 068 |            254 |            114 |
| 8 s       |           2 148 |            525 |            251 |
| 16 s      |           2 302 |          1 176 |            536 |
| 29 s      |           2 560 |          2 572 |          1 243 |

**Flatness — longest ÷ shortest, while the audio grew 14.5×:**

| model           | ratio     |
| --------------- | --------- |
| whisper-base.en | **1.26×** |
| moonshine-base  | 20.40×    |
| moonshine-tiny  | 22.52×    |

Whisper's 1.26× over a 14.5× range **is** the padding signature: a 2-second utterance costs
essentially what a 29-second one costs, because `WhisperFeatureExtractor` pads to `n_samples` before
the encoder ever runs. Moonshine's cost tracks the audio, as its pass-through feature extractor
(`[1, audio.length]`) predicts.

At the 2–8 s lengths live transcription actually produces, **moonshine-base is 4–16× faster and
moonshine-tiny 8–37× faster** than Whisper.

## Quality at utterance length

All three are comparable on 2–8 s clips — the lengths live cares about:

```
4s   whisper-base.en   "…the front of the house, the blower door test measure"
     moonshine-base    "…the front of the house, the blower door test mesha."
     moonshine-tiny    "…the front of the house, the blower door test mesh awe."
8s   whisper-base.en   "…the blower door test measured 400 CFM"
     moonshine-base    "…the blower door test measured 400 CF"
     moonshine-tiny    "…the blower door test measured 400 CFM"
```

**But moonshine-tiny falls apart on the full 54 s fixture**, where it drops most of the opening and
mangles figures ("measured 449" for 400 CFM50). moonshine-base handles the whole clip in one call and
stays close to Whisper's text. So tiny is usable _only_ as a live-only model, never for batch — and a
live-only model is a second model resident in memory.

**No WER was computed.** The 54 s fixture has no committed source text, and the authored corpus lives
in `../transcription-measurement` behind a Whisper-shaped harness. The quality column above is an
eyeball comparison, which is enough to rank tiny below base and not enough to rank base against
Whisper. **Measuring WER properly is the obvious next step before acting on any of this.**

## What this does to the live latency budget

`docs/roadmap/design/live-transcription-design.md` §What "live" actually costs estimated ~9–15 s.
Substituting the measured ASR term:

| component         | with Whisper | with moonshine-base |
| ----------------- | -----------: | ------------------: |
| VAD settle        |       5–10 s |          **5–10 s** |
| Utterance close   |    0.5–0.7 s |           0.5–0.7 s |
| ASR per utterance |       ~2.0 s |         **~0.25 s** |
| **total**         |    ~7.5–13 s |         **~6–11 s** |

**The ASR swap is real and large, and it barely moves the total.** After it, VAD is roughly 90 % of
the remaining latency. The design already said the VAD was the bigger lever; this measures how much
bigger. Anyone reading the 16× headline should read this table before concluding live is solved.

## Secondary finding, possibly the more valuable one

**moonshine-base transcribed the entire 54-second fixture in a single call, correctly, with no VAD
segmentation at all** (RTF 0.122; Whisper truncated the same input to 30 s, per
`feature_extraction_whisper.js`).

If that holds at realistic recording lengths, it puts the _batch_ path in question too — the 6 MB VAD
model, `segmentation.ts`'s 359 lines, and the whole chunk-planning layer exist to work around a
30-second window Moonshine does not have. That is a much larger simplification than the live feature
that prompted this spike.

**It is not established.** Attention is quadratic in sequence length, so 54 s working says nothing
about five minutes; that is the next measurement, and it is cheap.

## Also eliminated, without measuring

**Parakeet.** `onnx-community/parakeet-ctc-0.6b-ONNX` is **2 435 MB fp32** and 611 MB even int8,
against a repo that already treats a second 314 MB model as likely fatal on a phone. Size rules it
out before quality is worth asking about. (transformers.js 4.2.0 ships `ParakeetForCTC` only — the
streaming transducer is not available through it regardless.)

Model sizes, encoder + merged decoder, from the Hub API:

| model           | fp32     | q4       |
| --------------- | -------- | -------- |
| whisper-base.en | 291.0 MB | 142.4 MB |
| moonshine-base  | 247.0 MB | 97.5 MB  |
| moonshine-tiny  | 109.1 MB | 55.4 MB  |

`docs/implementation/14` records that q4/q8 do not load on the pinned ORT build, so the q4 column is
informational only.

## Caveats

- **Desktop, WASM, fp32.** A phone is the target device and is unmeasured. The design already names
  per-utterance phone latency as the measurement that gates planning; this spike does not supply it.
- **Hints are off for both.** `OnDeviceTranscriber`'s jargon priming is a Whisper-shaped
  `decoder_input_ids` trick with no Moonshine equivalent, so the comparison runs through a bare
  `pipeline()` for both. Whether Moonshine can be primed at all is unknown, and for R-value / CFM50 /
  ACH50 that is a real feature to lose.
- **Load times are cold downloads** (31–84 s), not steady-state cache reads.
- **Peak RSS (4 256 MB) is a ceiling across all three models loaded in sequence**, inflated further by
  `ps` double-counting shared pages. It is not a per-model figure and must not be quoted as one.
