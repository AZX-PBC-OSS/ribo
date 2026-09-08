# Real Field Audio

Every number on the [Transcription](/deep-dives/transcription-measurement) and
[Extraction](/deep-dives/accuracy) pages was measured against **TTS** — synthesized speech with no
noise, mic handling, disfluency, or cross-talk. Both pages call that a floor, not a forecast. This
page is the first check against the real thing: two field recordings, run through the actual
production pipeline end to end.

::: warning This is a pilot, not a corpus
Two clips is not a statistically meaningful sample — this page reports what changed running real
audio through real code, not an accuracy benchmark. Treat every number here as a data point, not a
threshold.
:::

## What ran

Both clips went through the **real, unmodified** `OnDeviceTranscriber` and `ManagedTranscriber` —
the same classes the app ships, not a reimplementation — with no hand-holding:

- **No manual chunking.** A 19-minute recording is far past Whisper's 30 s window, but the
  transcriber now segments long audio itself (VAD-based), so it went in whole.
- **No transcoding.** The files arrived as `.m4a` and `.mp3` — neither is the
  `audio/webm;codecs=opus` the app records in production — and both engines took them as recorded.

| clip    | duration | on-device RTF | managed RTF | on-device ↔ managed word-diff |
| ------- | -------: | ------------: | ----------: | ----------------------------: |
| real-01 |    3m44s |         0.101 |       0.030 |                          7.5% |
| real-02 |   19m14s |         0.108 |       0.015 |                         11.5% |

**RTF** — both engines run comfortably faster than real time. On-device lands close to the
[TTS-corpus figure](/deep-dives/transcription-measurement) (0.16), a little faster — real dictation
carries more silence than continuous TTS, and the VAD-based chunking skips it. Managed's RTF here is
mostly network round-trip, not model speed — not a compute comparison.

**Word-diff rate** is not accuracy — it's how far apart the two engines' transcripts land on the
_same_ real clip, which had never been measured before (the two engines had never transcribed the
same audio). Neither transcript is ground truth here, so read it as a disagreement measure: a floor
on how much the choice of engine can move the transcript, nothing more.

Full method, reproduce steps, and the underlying numbers: [doc 14, Part D](/implementation/14-transcription-measurement#part-d-real-field-audio).

## Extraction: ran, not yet scored

The same two clips' transcripts also went through the real extraction path — `singleShotExtractor`
against the production Snugg Pro adapter, the same code behind the
[extraction accuracy report](/deep-dives/accuracy) — and came back as well-formed, plausible filled
forms with real, traceable source spans.

What's missing is a **verdict**. Scoring needs a human-corrected ground-truth transcript and a
Snugg Pro ground-truth form for each clip, and both are on hold: the extracted field set is being
expanded right now, and annotating ground truth against a field set that's about to change would be
work thrown away. This page gets a scored section once that lands.

## Why this exists

An auditor's real value depends on what happens end to end — real speech in, a filled form out —
and every number measured before this was a best case. This pilot is step one of closing that gap:
prove the real pipeline runs clean on real audio before spending the (real) hours it takes to
ground-truth it.
