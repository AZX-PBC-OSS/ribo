# Transcription: Measured

::: warning Superseded default — these figures are Whisper's, not Moonshine's
[Feasibility](/deep-dives/feasibility) picked `@huggingface/transformers` and `whisper-base.en` by
attrition; this page's numbers were measured against that configuration. The on-device default has
since moved to **Moonshine** (`onnx-community/moonshine-base-ONNX`, 2026-08-11) because Whisper pads
every input to its 30-second receptive field regardless of speech length, where Moonshine's feature
extractor runs unpadded and is 4–16× faster at short utterance lengths — see the `moonshine-default`
changeset. **No equivalent RTF/WER numbers exist yet for Moonshine on this corpus** — treat every
figure below as characterising the _then_-default, not the model Ribo ships today. Moonshine also
drops the `prompt_ids` hinting this page measures in "Hints help most exactly where jargon is
densest" — see [Feasibility](/deep-dives/feasibility) for why.
:::

[Feasibility](/deep-dives/feasibility) picked `@huggingface/transformers` and `whisper-base.en` by
attrition, ahead of any real number. This page is the measurement run that followed: our own
numbers, on our own corpus, against the production `OnDeviceTranscriber` **as configured at the
time** — plus one thing no prior test had touched: what happens when a real language-model extractor
runs on the noisy transcript that model actually produces, instead of the clean text everyone had
been testing against.

::: warning These are a floor, and they are not the field number
Every number below comes from **text-to-speech audio**: no background noise, no mic handling, no
disfluency, no cross-talk, no room acoustics. **Do not read 8.0 % WER as a field forecast.** And
separately: **word error rate against
real field speech is not yet measured at all.** The two real recordings run so far give timing only
(RTF ≈ 0.10–0.11); scoring them needs a human-corrected transcript that doesn't exist yet. See
[Real Field Audio](/deep-dives/real-audio) for what has and hasn't been checked against real speech.
:::

## Method

The corpus is 14 authored Snugg Pro dictation transcripts, synthesized to 16 kHz mono audio with
macOS `say`. Because the transcripts were written first, the ground-truth text is exact by
construction — there's no hand-transcription step and no reference ambiguity, which makes the
word-error-rate measurement exact in a way a hand-checked recording can't be. Every clip ran through
the shipped `OnDeviceTranscriber`, `device: "wasm"`, `dtype: "fp32"` (q4/q8 don't load on the pinned
runtime build) — not a reimplementation.

**Measured on WASM only.** Headless Playwright Chromium has no GPU surface, so WebGPU is unreachable
in this harness — the same constraint the feasibility spike hit. All figures below are the WASM
execution provider; WebGPU throughput remains unmeasured by this repo, and the one public data point
that exists (see [Feasibility](/deep-dives/feasibility)) has WebGPU running _slower_ than WASM for
Whisper, so a speedup there shouldn't be assumed either.

## Part A — performance and word error rate

| model             |                corpus RTF | corpus WER | warm-from-cache | peak browser RSS |
| ----------------- | ------------------------: | ---------: | --------------: | ---------------: |
| `whisper-base.en` | **0.159** (≈6× real time) |  **8.0 %** |      **0.79 s** |          ~3.5 GB |
| `whisper-tiny.en` |                     0.075 |      8.6 % |          0.64 s |          ~2.5 GB |

**Warm-from-cache** is a brand-new worker priming after the model weights are already in the Cache
API — no network, a cold ONNX Runtime session, sub-second. That's the returning-user / offline-boot
number. Cold load (first-ever download plus session build) runs 85.7 s (base) / 47.3 s (tiny) — a
genuine first-launch cost, not something users repeat. **Peak browser RSS** is a ceiling on the whole
headless-browser process (fp32's large weights make it heavy), not a measurement of the model's own
footprint — the JS heap the page can read is only ~22 MB, which excludes the WASM/ORT arena where the
model actually lives.

The errors are milder than the raw WER suggests: a large share are numeral-formatting differences
("thirty-two hundred" vs `3200`) that the extraction layer's number parser tolerates without ever
producing a wrong number. This inflates the reported WER rather than hiding errors.

## Hints help most where jargon is densest

Whisper's decoder accepts a prefix hint — a list of domain vocabulary (`R-value, CFM50, AFUE, blower
door, backdrafting,` …) biasing what it hears. On the jargon-dense combustion-safety transcript,
hints cut `base.en` WER from **22.4 % to 4.3 %** (−18 points). Averaged across the whole corpus the
effect is smaller but still positive, and it isn't free: hints occasionally bled vocabulary into
ordinary text ("attic" → "ACH"), and cost `tiny.en` 0.4 points on that same transcript.

## Part B — what a noisy transcript does to extraction

This is the interaction no earlier test could reach: the extraction spike ran on clean, authored
text, and the feasibility spike measured word error rate in isolation. Neither answered whether a
transcript with real transcription errors in it still yields the right extracted values, or yields
confidently wrong ones instead.

The `whisper-base.en` (hinted) transcripts from Part A were run through the same blind extraction
pipeline used elsewhere on this site, scored against the same ground truth, checking each
`sourceSpan` for verbatimness against the **noisy** transcript — what the model actually saw, not the
clean source.

Extraction was unchanged: no new hallucination, no new miss, no fuel axis-drop, no hallucinated
health-matrix pass. Everything the domain-jargon hint vocabulary covers — AFUE, CFM50/CFM25,
R-values, BTU figures, the health tests, the equipment/fuel axis split — survived the noisy
transcript intact.

**The one thing that broke: equipment value accuracy, ~100 % → ~96 %.** Every broken field was the
same failure mode — a mis-transcribed equipment **manufacturer or model name**:

| ground truth | what Whisper heard |
| ------------ | ------------------ |
| Trane        | "a **train**"      |
| Lennox       | "**Linux**"        |
| Weil-McLain  | "**wheel McLean**" |
| Burnham      | "**burnum**"       |

These are proper nouns the hint vocabulary doesn't cover — it's building-science jargon, not brand
names — and Whisper has no other way to know them. The obvious mitigation (adding common HVAC
manufacturer names to the hint list) is a cheap, unmeasured follow-up.

**`sourceSpan` verbatimness held at 100 % even on the noisy transcript** — but that's a narrower
guarantee than it sounds. A span is checked as a verbatim substring of whatever transcript the model
was given, so on the noisy transcript the Lennox span reads `"…a Linux, natural gas…"` verbatim and
still passes. **A verbatim span proves the model didn't invent the quote; it does not prove the audio
was heard correctly** — a review UI showing a span isn't certifying the words underneath it.

## Real field audio — timing only, so far

Two real field recordings (3 m 44 s and 19 m 14 s) have been run end to end through the production
transcribers, on-device and managed. Both comfortably beat real time — on-device RTF
0.101 and 0.108, a little faster than the TTS-corpus figure above, plausibly because real dictation
carries more silence than continuous TTS and the transcriber's VAD-based chunking skips it. **Word
error rate against real speech is not yet measured** — that needs a human-corrected reference
transcript, which doesn't exist yet. Full pilot, including what happened when the same two clips went
through extraction: [Real Field Audio](/deep-dives/real-audio).

## What this doesn't settle

Every number on this page settled the _feasibility_ question for Whisper — it was fast enough and
accurate enough on clean speech, and it integrated through extraction without opening any new
hallucination hazard. It never settled the _field-readiness_ question (real speech is louder,
messier, and more disfluent than anything synthesized here, by an amount this page did not measure),
and it does not answer the question for Moonshine, the current default, at all — that model's
accuracy and its interaction with extraction are unmeasured on this corpus. Do not plan against these
as either field numbers or Moonshine numbers.

Full harness, method, and reproduce steps:
[doc 14, the measured spike](https://github.com/AZX-PBC-OSS/ribo/blob/main/docs/implementation/14-transcription-measurement.md)
— implementation notes that live in the repo, not on this site.
