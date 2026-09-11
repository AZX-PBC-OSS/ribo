# Transcription: Measured

[Feasibility](/deep-dives/feasibility) picked `@huggingface/transformers` and `whisper-base.en` by
attrition, ahead of any real number. This page is the measurement run that followed: our own
numbers, on our own corpus, against the real production `OnDeviceTranscriber` — plus the one thing
no prior test had touched, what happens when a real language-model extractor runs on the noisy
transcript that model actually produces, instead of the clean text everyone had been testing against.

::: warning These are a floor, and they are not the field number
Every number below comes from **text-to-speech audio**: no background noise, no mic handling, no
disfluency, no cross-talk, no room acoustics. TTS audio has no noise, mic handling, disfluency, or
cross-talk — **do not read 8.0 % WER as a field forecast.** And separately: **word error rate against
real field speech is not yet measured at all.** The two real recordings run so far give timing only
(RTF ≈ 0.10–0.11); scoring them needs a human-corrected transcript that doesn't exist yet. See
[Real Field Audio](/deep-dives/real-audio) for what has and hasn't been checked against real speech.
:::

## Method

The corpus is 14 authored Snugg Pro dictation transcripts, synthesized to 16 kHz mono audio with
macOS `say`. Because the transcripts were written first, the ground-truth text is exact by
construction — there's no hand-transcription step and no reference ambiguity, which is a genuinely
better word-error-rate measurement than a hand-checked real recording would give. Every clip ran
through the real `OnDeviceTranscriber` the app ships, `device: "wasm"`, `dtype: "fp32"` (q4/q8 don't
load on the pinned runtime build), not a reimplementation.

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

Errors concentrate less than raw WER suggests: a large share are numeral-formatting differences
("thirty-two hundred" vs `3200`) that the extraction layer's number parser tolerates without ever
producing a wrong number — a deliberate, honest inflation of the reported WER, not a hidden
undercount.

## Hints help most exactly where jargon is densest

Whisper's decoder accepts a prefix hint — a list of domain vocabulary (`R-value, CFM50, AFUE, blower
door, backdrafting,` …) biasing what it hears. On the jargon-dense combustion-safety transcript,
hints cut `base.en` WER from **22.4 % to 4.3 %** (−18 points). Averaged across the whole corpus the
effect is smaller but still positive, and it isn't free: hints occasionally bled vocabulary into
ordinary text ("attic" → "ACH"), and cost `tiny.en` 0.4 points on that same transcript. They help
where they're needed most, not everywhere.

## Part B — what a noisy transcript does to extraction

This is the interaction no earlier test could reach: the extraction spike ran on clean, authored
text, and the feasibility spike measured word error rate in isolation. Neither answered whether a
transcript with real transcription errors in it still yields the right extracted values, or yields
confidently wrong ones instead.

The `whisper-base.en` (hinted) transcripts from Part A were run through the same blind extraction
pipeline used elsewhere on this site, scored against the same ground truth, checking each
`sourceSpan` for verbatimness against the **noisy** transcript — what the model actually saw, not the
clean source.

**All four headline extraction hazards were unchanged: no new hallucination, no new miss, no fuel
axis-drop, no hallucinated health-matrix pass.** Everything the domain-jargon hint vocabulary
covers — AFUE, CFM50/CFM25, R-values, BTU figures, the health tests, the equipment/fuel axis
split — survived the noisy transcript intact.

**The one thing that broke: equipment value accuracy, ~100 % → ~96 %.** And every single broken
field was the same failure mode — a mis-transcribed equipment **manufacturer or model name**:

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
was heard correctly.** Span verbatimness and transcription correctness are different guarantees, and
a review UI showing a span shouldn't be read as certifying the words underneath it.

## Real field audio — timing only, so far

Two real field recordings (3 m 44 s and 19 m 14 s) have been run end to end through the real
production transcribers, on-device and managed. Both comfortably beat real time — on-device RTF
0.101 and 0.108, a little faster than the TTS-corpus figure above, plausibly because real dictation
carries more silence than continuous TTS and the transcriber's VAD-based chunking skips it. **Word
error rate against real speech is not yet measured** — that needs a human-corrected reference
transcript, which doesn't exist yet. Full pilot, including what happened when the same two clips went
through extraction: [Real Field Audio](/deep-dives/real-audio).

## What this doesn't settle

Every number on this page retires the _feasibility_ question — on-device Whisper is fast enough and
accurate enough on clean speech, and it integrates through extraction without opening any new
hallucination hazard. It does not retire the _field-readiness_ question. Real speech is louder,
messier, and more disfluent than anything synthesized here, by an amount this page has not measured.
Do not plan against these as field numbers.

Full harness, method, and reproduce steps:
[doc 14, the measured spike](https://github.com/AZX-PBC-OSS/ribo/blob/main/docs/implementation/14-transcription-measurement.md)
— implementation notes that live in the repo, not on this site.
