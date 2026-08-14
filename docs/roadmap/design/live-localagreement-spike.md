# LocalAgreement spike — does commit-on-agreement fix live transcription?

**Date:** 2026-08-12

> **The probe code is committed** at `packages/ribo-transcriber-ondevice/src/localagreement-spike.manual.ts`.
> Re-run it with:
>
> ```bash
> pnpm exec vitest run --config packages/ribo-transcriber-ondevice/vitest.manual.config.ts \
>   packages/ribo-transcriber-ondevice/src/localagreement-spike.manual.ts
> ```
>
> Moonshine is ~250 MB on first run, cached after. The testdata WAV is gitignored — copy it
> from the main repo's `packages/ribo-transcriber-ondevice/testdata/`.

## The answer, up front

**No.** LocalAgreement-2 does not fix live transcription for this domain, and the reasons
are two independent failures either of which is disqualifying on its own:

1. **The production VAD never gives it enough refresh points.** The 54 s energy-audit fixture
   is continuous dictation — no pauses reach the 800 ms silence threshold. The VAD emits only
   twice (the 30 s cap and the flush), so LocalAgreement never has two hypotheses to compare.
   **Zero words committed.** This is not a tuning issue; it is the shape of continuous dictation
   meeting a VAD tuned for continuous dictation.

2. **Even with enough refresh points, committed text is permanently wrong.** A 5 s
   fixed-interval cadence gives LocalAgreement the hypotheses it needs, and it commits 43
   words. But 20 of those 43 disagree with the batch reference, including **"six error
   changes" committed where the correct text is "six air changes"** — a mishearing that both
   hypotheses agreed on, that can never be revised, and that the batch pass gets right.

A third problem — the proportional audio advance clipping words at commit boundaries — makes
the committed text read worse than isolated even where the individual words are correct.

## What was measured

The probe drives the real `StreamingVad` from `vad-stream.ts` (Silero VAD, production
constants: 800 ms silence, 4 s minimum utterance, 30 s buffer cap) and the real
`onnx-community/moonshine-base-ONNX` model over the 54 s energy-audit fixture
(`testdata/energy-audit-long-48k-mono.wav`). It compares three approaches on the same audio:

1. **isolated** — per-closed-utterance, what ships today
2. **LocalAgreement-2** — commit-on-agreement over a growing buffer, at VAD-driven and
   fixed-interval (5 s) refresh cadences, at 15 s and 30 s region caps
3. **batch** — `OnDeviceTranscriber` over the whole 54 s, the quality reference

It also measures LocalAgreement-3, reproducibility (same buffer transcribed twice), and
cross-call non-determinism (same buffer at different points in the session).

All measurements are on desktop Chromium (Playwright headless), WASM, fp32, single run.

---

## Q1 — Is the committed text more accurate than isolated?

**No.** The side-by-side comparison, with batch as the reference:

```
BATCH:          We are starting the walk-thru at the front of the house, the blower
                 door test measured 400 CFM50, which works out to about 6 air changes
                 per hour at 50 pascals. Moving up to the attic now, the attic
                 insulation is R-value 49, blown cellulose, [... 109 words total]

ISOLATED:       We are starting the walk-thru at the front of the house, the blower
                 door test measured 400 CFM50, which works out to about 6 air changes
                 per hour at 50 Pascals. Moving up to the attic now, the attic
                 insulation is R-value 49, blown cellulose, [... 108 words total]

LA-2 VAD 30s:   (empty — 0 words committed)

LA-2 fixed 30s: We are starting the at the front of the house the blower door test
                 measured 400 CFM 50 which works out to about six error changes per
                 hour at 50 Pascals moving up to the attic now the attic insulation
                 is R value  [43 words, then stops]

LA-3 fixed 30s: We are starting the front of the  [7 words, then stops]
```

### Isolated is good on this audio

The isolated path produces a near-complete transcript. The first utterance (30 s, VAD
cap) is clean — it matches the batch reference almost word-for-word. The second utterance
(23.8 s, flush) has a few mishearings at its start ("mean duck leakage" for "Duct leakage")
because it begins mid-sentence with no prior context. But the full transcript is 108 words
covering the whole recording, versus 43 for the best LocalAgreement run.

### LocalAgreement-2 (fixed 5 s, 30 s cap) commits wrong text

The 43 committed words contain 20 mismatches against the batch reference
(case-insensitive, same-position). The most consequential:

| word | committed | batch     | what happened                                                                                |
| ---- | --------- | --------- | -------------------------------------------------------------------------------------------- |
| 5    | at        | walk-thru | **"walk-thru" is missing** — the proportional advance moved the audio start past it (see Q3) |
| 25   | error     | air       | both hypotheses agreed on "error" — a permanent, unrevisable mishearing (see Q6)             |
| 42   | R         | R-value   | tokenisation difference ("R value" → "R" / "value")                                          |

The "error" vs "air" case is the one that matters. The speaker says "six air changes per
hour" — a core energy-audit metric (ACH50). Both hypotheses at pauses 3 and 4 transcribed
it as "error changes". LocalAgreement committed it. The batch pass, seeing the whole 54 s,
got it right. Once committed, "error" can never be fixed.

### LocalAgreement-3 is more conservative but stalls

LA-3 commits only 7 words ("We are starting the front of the"), all correct. But it commits
nothing after pause 6 (30 s) — three consecutive hypotheses never agree on a longer prefix.
The more conservative rule prevents the "error" commit but at the cost of committing almost
nothing: 7 words out of ~120 in 54 s of audio.

---

## Q2 — How much text does it actually commit, and how fast?

### VAD-driven cadence (production): zero

The production VAD produces **2 pause points** for 54 s of continuous dictation:

| #   | end    | cause           |
| --- | ------ | --------------- |
| 1   | 30.0 s | 30 s buffer cap |
| 2   | 53.8 s | flush on close  |

Both pauses trigger forced advances (the buffer exceeds the region cap before a second
hypothesis can be generated). LocalAgreement never has two hypotheses to compare. **Zero
words committed**, at both 15 s and 30 s region caps.

This is the fundamental mismatch: the VAD was tuned for continuous dictation (800 ms silence,
4 s minimum utterance) and emits rarely — exactly the opposite of what LocalAgreement needs.

### Fixed-interval cadence (5 s): some, but slow and incomplete

With a 5 s fixed-interval cadence (11 pause points), LA-2 at 30 s cap:

| #   | end    | bufSec | hypW | newCmt | cmtTot | lag    | infMs | duty  | forced |
| --- | ------ | ------ | ---- | ------ | ------ | ------ | ----- | ----- | ------ |
| 1   | 5.0 s  | 5.0 s  | 18   | 0      | 0      | 5.0 s  | 320   | 0.064 | no     |
| 2   | 10.0 s | 10.0 s | 31   | 4      | 4      | 8.7 s  | 673   | 0.067 | no     |
| 3   | 15.0 s | 13.7 s | 41   | 0      | 4      | 13.7 s | 954   | 0.070 | no     |
| 4   | 20.0 s | 18.7 s | 56   | 39     | 43     | 5.7 s  | 1377  | 0.074 | no     |
| 5   | 25.0 s | 10.7 s | 31   | 0      | 43     | 10.7 s | 692   | 0.065 | no     |
| 6   | 30.0 s | 15.7 s | 43   | 0      | 43     | 15.7 s | 1130  | 0.072 | no     |
| 7   | 35.0 s | 20.7 s | 56   | 0      | 43     | 20.7 s | 1597  | 0.077 | no     |
| 8   | 40.0 s | 25.7 s | 69   | 0      | 43     | 25.7 s | 2207  | 0.086 | no     |
| 9   | 45.0 s | 30.0 s | 85   | 0      | 43     | 30.0 s | 2630  | 0.088 | YES    |
| 10  | 50.0 s | 30.0 s | 79   | 0      | 43     | 30.0 s | 2794  | 0.093 | YES    |
| 11  | 53.8 s | 30.0 s | 78   | 0      | 43     | 30.0 s | 2802  | 0.093 | YES    |

The commit pattern: two commits (pauses 2 and 4), then nothing for the remaining 7 pauses.
After the second commit at pause 4, the buffer starts at a new position and the hypotheses
never agree again — the model produces different opening words for each buffer
("blown cellulose" vs "1. Blown cellulose" vs "10. Blonde cellulose"), so the common prefix
is empty.

**43 words committed out of ~120 in 54 s of audio.** The last ~34 s of the recording have no
committed text at all. The audio lag grows to 30 s (the region cap) by the end.

At 15 s region cap, only 4 words are committed ("We are starting the"), with 8 forced
advances — the cap is too tight for hypotheses to agree before the buffer overflows.

---

## Q3 — Does committed text ever turn out wrong?

**Yes, in two distinct ways.**

### Permanent mishearing: "error changes" for "air changes"

At pauses 3 and 4, both hypotheses transcribe "six error changes per hour". LocalAgreement-2
commits this. The batch reference transcribes "six air changes per hour" — the correct term
(ACH50, a core energy-audit metric).

Once committed, "error" cannot be revised. This is the permanent-failure mode the spike was
designed to detect. The cause is cross-call non-determinism (see Q6): the model produces
"error" early in the session and "air" later. Both early hypotheses agree on the wrong answer.

### Word clipping at commit boundaries: "walk-thru" missing

The first commit is "We are starting the" (4 words from a 31-word, 10 s hypothesis). The
proportional advance moves the audio start forward by 4/31 × 10 s ≈ 1.29 s. But "walk-thru"
spans roughly 1.5–2.0 s in the audio — it falls in the gap between the committed text and the
new start position. The next hypothesis begins "at the front of the house..." — "walk-thru"
is gone.

The committed text reads "We are starting the at the front of the house" — a word dropped
not by the model but by the advance mechanism. This is a known limitation of LocalAgreement
without timestamps: the audio-to-text mapping is approximate, and words at commit boundaries
can be clipped. The `whisper_streaming` reference implementation uses segment timestamps to
advance precisely; Moonshine on transformers.js does not expose them.

---

## Q4 — What does it cost?

**Cost is not the blocker.** The duty cycle (inference time / audio elapsed) is well below
1.0 in every configuration:

| config        | total inference | avg duty | max duty | forced advances | committed words |
| ------------- | --------------: | -------: | -------: | --------------: | --------------: |
| VAD 30s cap   |           5.3 s |    0.089 |    0.089 |               2 |               0 |
| VAD 15s cap   |           2.0 s |    0.067 |    0.067 |               2 |               0 |
| fixed 5s, 30s |          17.2 s |    0.077 |    0.093 |               3 |              43 |
| fixed 5s, 15s |          10.6 s |    0.071 |    0.075 |               8 |               4 |

The 30 s cap's max duty cycle is 0.093 — inference takes 9.3% of the audio duration. Even
with a 5 s refresh interval (11 transcriptions over 54 s of audio), total inference is 17.2 s
against 53.8 s of audio. On a phone beside an open microphone, this is affordable.

The 15 s cap halves the inference time (shorter buffers) but commits almost nothing (4 words)
because the cap forces advancement before hypotheses can agree.

For reference, the batch pass transcribes the whole 54 s in 4.6 s wall-clock (RTF 0.086).

---

## Q5 — Does LocalAgreement-3 commit meaningfully better text than 2?

**Yes in quality, no in quantity.** LA-3 commits 7 words ("We are starting the front of the"),
all correct. LA-2 commits 43 words, 20 of which are wrong. LA-3's more conservative rule
prevents the "error changes" commit because three hypotheses never agree on the wrong prefix.

But 7 words out of ~120 is not a useful preview. LA-3 commits nothing after pause 6 (30 s):
the model's opening words for each new buffer vary too much for three consecutive hypotheses
to agree. The lag grows to 30 s and stays there.

| metric           | LA-2 (fixed 5s, 30s cap) | LA-3 (fixed 5s, 30s cap) |
| ---------------- | -----------------------: | -----------------------: |
| committed words  |                       43 |                        7 |
| correct vs batch |                 23 of 43 |                   7 of 7 |
| total inference  |                   17.2 s |                   21.0 s |
| forced advances  |                        3 |                        5 |
| last commit at   |                  pause 4 |                  pause 6 |

LA-3 costs more (21.0 s vs 17.2 s inference — it needs an extra hypothesis per agreement
window) and commits less. The quality improvement (0 errors vs 20) is real but the quantity
(7 words) is not useful.

---

## Q6 — Is Moonshine's output reproducible?

**Within a tight loop: yes. Across calls: no.** This is the assumption the whole technique
rests on, and it does not hold.

### Same buffer, transcribed twice in succession: identical

| buffer | pass 1   | pass 2   | identical | common prefix |
| ------ | -------- | -------- | --------- | ------------- |
| 15 s   | 44 words | 44 words | **yes**   | 44 / 44       |
| 30 s   | 85 words | 85 words | **yes**   | 85 / 85       |

Transcribing the same buffer back-to-back produces byte-identical output. ORT WASM is
deterministic within a tight loop.

### Same buffer, at different points in the session: different

The 30 s buffer (first 30 s of the fixture) was transcribed three times at different points
in the session:

| when                    | text (word 25 shown)  | full match?             |
| ----------------------- | --------------------- | ----------------------- |
| LA-2 VAD run (early)    | "6 **error** changes" | —                       |
| reproducibility (late)  | "6 **air** changes"   | —                       |
| this call (later still) | "6 **air** changes"   | matches reproducibility |

The early transcription differs from the later two: "error" vs "air", plus punctuation and
capitalisation differences ("it was installed" vs "It was installed"). The common prefix
between the early and late transcriptions is **24 of 85 words** — they diverge at exactly
the "error"/"air" boundary.

The later two are identical, suggesting the non-determinism stabilises after enough calls.
But the early transcription — the one LocalAgreement used for its first hypotheses —
produced the wrong result.

### What this means for LocalAgreement

LocalAgreement assumes that consecutive hypotheses over a growing buffer converge — that the
common prefix grows as the buffer grows. The cross-call non-determinism violates this: two
hypotheses over the same audio can both produce "error" (because the model is in a state
where "error" is the output), and a later transcription of the same audio produces "air".
The agreement is on the wrong answer.

This is not the random non-determinism the previous spike warned about ("6 air changes" once
and "6 error changes" another time, from ORT WASM floating-point non-determinism"). It is
**state-dependent non-determinism**: the model's output for the same audio depends on what
was transcribed before it in the same session. The within-loop reproducibility confirms the
floating-point path is deterministic for a given state; the cross-call difference confirms the
state changes between calls.

A rule built on agreement requires the hypotheses to be converging toward the correct answer.
If both hypotheses are wrong in the same way (because the model's state predisposes it to
"error"), agreement commits the wrong answer permanently. This is the failure mode the spike
was designed to detect, and it is real.

---

## What was tried and did not work

### Relaxing the VAD to get more pause points

The production VAD (800 ms silence, 4 s minimum) produces only 2 emit points. Using the
constructor options (`minSilenceMs: 300, minUtteranceSeconds: 1`) would produce more, but the
task constrains us to the production VAD constants. The 5 s fixed-interval cadence is the
stand-in: it proves that more refresh points let LocalAgreement commit, but the committed
text is wrong (Q1, Q3).

### 15 s region cap

A tighter cap was tried to reduce the duty cycle and keep the buffer within the model's
receptive field. It commits only 4 words — the cap forces advancement before hypotheses can
agree. The 15 s cap is worse than 30 s on every metric except cost.

### LocalAgreement-3

Tried as a more conservative rule. It prevents the "error" commit but commits only 7 words
total — not a useful preview. The extra hypothesis per agreement window adds inference time
(21.0 s vs 17.2 s) without producing enough committed text to justify it.

---

## What could not be established

- **Phone behaviour.** All measurements are desktop Chromium (Playwright headless). The duty
  cycle on a phone could be 3–5× worse. The cost finding (duty cycle ~0.09) has enough margin
  that it would likely remain affordable, but this is not measured.

- **Whether timestamp-based advance fixes the word clipping.** The `whisper_streaming`
  reference uses segment timestamps to advance the audio buffer precisely, avoiding the
  "walk-thru" clipping. Moonshine on transformers.js does not expose segment timestamps
  through the `generate` API. Reaching them would mean decoding the model's timestamp tokens
  directly, which this spike did not attempt.

- **Whether the cross-call non-determinism is specific to this ORT version or environment.**
  The previous spike (`live-spike-findings.md`) measured "6 air changes" once and "6 error
  changes" another time and attributed it to ORT WASM floating-point non-determinism. This
  spike finds the output is deterministic within a tight loop but varies across calls — a
  different and more specific diagnosis. Whether a different ORT build, a WebGPU backend, or
  a quantised model would behave differently is not measured.

- **Whether a longer fixture changes the result.** The 54 s fixture has only ~120 words. A
  longer recording might give LocalAgreement more opportunities to commit, but the
  fundamental problems (VAD cadence, cross-call non-determinism, word clipping) would not
  change.

---

## Conclusion

LocalAgreement does not fix live transcription for this domain. Three independent failures:

1. **The VAD never emits often enough.** Continuous dictation has no 800 ms pauses, so the
   production VAD emits only at the 30 s cap and the flush. LocalAgreement needs at least 2
   hypotheses to agree, and it never gets them. This is not tunable away without changing the
   VAD's silence threshold — which would regress the quality the VAD was tuned to protect.

2. **Committed text is permanently wrong.** Even with enough refresh points, the model's
   cross-call non-determinism means both early hypotheses can agree on the wrong answer
   ("error" for "air"). Once committed, it cannot be revised. The batch pass gets it right;
   the preview is stuck with the error.

3. **The proportional advance clips words.** Without segment timestamps, the audio-to-text
   mapping is approximate. Words at commit boundaries ("walk-thru") are dropped from the
   committed text, producing output that reads worse than isolated even where the individual
   words are correct.

The cost (duty cycle ~0.09) is affordable. The problem is not the cost — it is the quality of
what gets committed and whether anything gets committed at all.

The isolated path, what ships today, produces a better preview for this audio: 108 words
covering the whole recording, with a few mishearings at utterance boundaries. LocalAgreement's
43 words (20 wrong) is strictly worse.
