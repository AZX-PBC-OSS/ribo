# Live transcription — utterance-level preview during recording

**Status:** Design, revision 6. **Piece 2 of 2. Unblocked, ready to plan.**
**Date:** 2026-08-08, split 2026-08-10, revised 2026-08-11

> **Revision 6 is a subtraction.** Two things changed underneath this document and both made it
> smaller.
>
> - **Piece 1 has merged.** Revision 5 said piece 2 could not be planned until durable capture landed.
>   It has: capture session, capture lock, recovery and capture health are all on `main`. This design
>   is now plannable.
> - **The batch path moved to Moonshine too**, so live and batch share one model. Revision 5's longest
>   section existed to manage a live/batch model split — two downloads, two residencies, a preview
>   worse than its own transcript on domain jargon. **None of that exists now.** The section is
>   deleted rather than revised, which is the third time in this feature that the fix has been
>   removing something rather than repairing it.
>
> One fact arrives in exchange, and it is not a small one: **peak RSS roughly doubled** on the swap to
> Moonshine — 3494 MB → 6644 MB, on a _smaller_ model, unexplained. That matters far more for a
> feature that runs _during_ recording than for one that runs after it. See §Memory.

> **Revision 5 made this feature actually live.** Revision 4 resolved both blockers and then had to
> report that the result was a preview lagging **9–15 seconds** behind the speaker — technically
> useful, but not what anyone means by live. Measurement and research since have cut that to
> **roughly 0.7 s**, and the change is not a tuning exercise: it is two component swaps, neither of
> which was on the table when this document was written.
>
> - **The VAD, which was ~90 % of the latency.** pyannote-segmentation-3.0 is a 10-second-window
>   model whose probabilities are averaged across overlapping windows, so a frame's value is not
>   final until 5–10 s of later audio exists. **Silero VAD is frame-synchronous** — 512 samples
>   (32 ms) at a time, carrying its own recurrent state tensor. Settle latency goes from 5–10 s to
>   one frame.
> - **The ASR.** Whisper pads every input to 30 s before the encoder runs, so a 2-second utterance
>   costs what a 29-second one does — **measured at 1.26× across a 14.5× range of audio.**
>   Moonshine's feature extractor passes audio through unpadded; at live utterance lengths it is
>   **4–16× faster**. The numbers are below; the throwaway harness that produced them was not kept.
>
> **Revision 4's answer to U2 is withdrawn, not corrected.** It proposed recomputing the VAD pipeline
> from a committed cursor on every feed — a sound workaround for a model that cannot stream, and
> unnecessary against one that can. Silero hands back its own state; there is nothing to reconstruct.
> The whole §Rolling VAD section is gone.
>
> **U1's resolution stands unchanged** (§Worker contention): recording never waits, because `Recorder`
> has no worker at all.
>
> **One revision-4-era claim is retracted.** The spike observed Moonshine transcribing a 54-second
> clip in a single call and suggested that might make the batch chunk-planning layer unnecessary.
> Moonshine's own reference implementation caps input at 30 s (`MAX_BUFFER_DURATION = 30`) and the v2
> paper recommends external segmentation. One clip working is not a licence to delete that layer.

## The goal

An auditor dictating a walkthrough sees their words appear as they speak and pause, while standing in
the room — so a misheard reading can be corrected on the spot rather than discovered at review.

Today transcription begins only after the recording is finished: `record → stop() → enqueue → relay →
transcriber.transcribe(recording, audio)`. Nothing is visible until the whole recording is processed.

## What this is not

- **Not word-level streaming.** Utterance-level: text appears when you pause, not as each word lands.
  Moonshine v2 has a genuinely incremental encoder that could go further, but it is not reachable —
  see §Why not Moonshine v2.
- **Not live extraction.** Deliberately deferred. Every extraction call emits all 51 leaves because
  the anti-hallucination rule makes every key required and nullable, so a five-second utterance costs
  roughly what a five-minute recording does (~1,200 output tokens; **estimated** 12–20 s — extraction
  latency has never been measured). R3's per-group routing is a hard prerequisite, and even then the
  contradiction policy ("the attic is R-38 — sorry, R-49") is undecided and there is no local model
  for offline use.
- **Not diarization.** Silero does not offer it and we are not asking.
- **Not authoritative.** The batch pass after `stop()` replaces the preview entirely. See §Provisional.

## What "live" actually costs

| component         | revision 4 |  revision 5 | basis                    |
| ----------------- | ---------: | ----------: | ------------------------ |
| VAD settle        |     5–10 s | **~0.03 s** | Silero frame size, 32 ms |
| Utterance close   |  0.5–0.7 s |   **0.4 s** | reference implementation |
| ASR per utterance |     ~2.0 s | **~0.25 s** | measured, spike          |
| **total**         |    ~9–15 s |  **~0.7 s** |                          |

The ASR figure is our own measurement (moonshine-base, 4-second utterance, WASM, fp32, desktop). The
other two are the component's stated frame size and the reference implementation's constant.

### The ASR measurement, in full

Median of three runs per cell, one call each, WASM/fp32, desktop, hints off for all three (the
priming trick is Whisper-shaped, so a fair comparison cannot use it):

| utterance | whisper-base.en | moonshine-base | moonshine-tiny |
| --------- | --------------: | -------------: | -------------: |
| 2 s       |    **2 033 ms** |        **126** |         **55** |
| 4 s       |           2 068 |            254 |            114 |
| 8 s       |           2 148 |            525 |            251 |
| 16 s      |           2 302 |          1 176 |            536 |
| 29 s      |           2 560 |          2 572 |          1 243 |

**Whisper: 1.26× while the audio grew 14.5×.** That flatness _is_ the padding — cost is set by the
window, not the speech. Moonshine: 20–22×, tracking the audio as its pass-through feature extractor
predicts.

Two things this measurement does **not** establish, both load-bearing:

- **Accuracy.** Quality was eyeballed, not scored. Enough to rank moonshine-tiny last — it mangles the
  full 54 s fixture, reading "measured 449" for 400 CFM50 — and **not** enough to rank moonshine-base
  against Whisper.
- **Phone behaviour.** Desktop WASM only.

Model sizes, encoder + merged decoder: whisper-base.en 291 MB fp32 / 142 MB q4; moonshine-base 247 /
97.5; moonshine-tiny 109 / 55.4. Parakeet was eliminated without measuring — `parakeet-ctc-0.6b` is
2 435 MB fp32 and 611 MB int8.

**This is a desktop number and the target is a phone.** It is no longer the difference between
"useful" and "not useful" — 0.7 s has room to be several times worse and still feel live — but it is
still the measurement that should precede shipping, not follow it.

## Delivery: consumers already have a stream

`Outbox.watch(query)` returns `Observable<OutboxItem[]>` over an RxDB live query, and
`useOutboxItems` already subscribes. Anything written to the outbox document reaches consumers
reactively, so **no new subscription mechanism is added** and the `segments$` observable in the seam
below stays internal to core.

`OutboxItem` is a public type and adding `preview` widens it. `OutboxStatus` and the mechanism behind
it — capture session, capture lock, recovery, capture health — are all on `main` as of piece 1's
merge, so this design builds on shipped code rather than on a pending branch.

## Architecture

```
mic ─► MediaStream ─┬─► MediaRecorder ──► chunks ──► audio-chunk-NNNN attachments
                    │                                        │ (at stop) merge
                    │                                        ▼
                    │                                 AUDIO_ATTACHMENT_ID
                    └─► AudioWorklet ─► 512-sample frames ─► LiveSession.feed()
                                                       │
                                     [worker: Silero per frame, state carried]
                                                       │ 400 ms of silence closes it
                                                       ▼
                                              Moonshine ──► segments$
                                                                │
                                                    item.preview.segments[]
                                                                │
                                                      Outbox.watch() ──► useOutboxItems ──► UI

stop() ─► queued ─► relay ─► transcriber.transcribe(blob) ─► transcript (preview deleted)
```

Live is orchestrated by `ribo-core` against a seam engines implement — the same direction as
`Transcriber`. Letting the engine write to the outbox itself was rejected: it inverts the dependency
and breaks the substitutability `firstCapable` relies on. A separate `ribo-live` package was rejected
because the worker and the models live in the ondevice package.

### The live seam is NOT composed through `firstCapable`

`firstCapable` takes `Transcriber[]` and returns a composite exposing batch `transcribe`,
`capabilities` and `invalidate`. A `LiveTranscriber` is not reachable through it, and widening the
composite would drag a live concern into every batch roster.

Instead the live orchestrator takes an **optional `LiveTranscriber` directly**. If none is supplied,
or its `liveCapability()` is not `ready`, there is simply no preview and recording proceeds
untouched — which is exactly the governing rule below, so this costs nothing.

`liveCapability()` is **separate from `capability()`** and this is load-bearing: it must report on a
different model and a different VAD from the batch path, so "batch ready, live unavailable" is a real
state — and after this revision it is the _common_ state, since the two paths no longer share weights.

### Components

**`Recorder` (`ribo-core`, extended).** Gains an optional `onSamples` tap; one `getUserMedia` stream
feeds both `MediaRecorder` — still producing the durable chunks piece 1 persists — and an
`AudioWorklet` emitting **512-sample frames**. Without the callback, behaviour is identical to today.

512 is not arbitrary: it is Silero's frame size, and the reference `AudioWorkletProcessor` exists
purely to regroup the browser's 128-sample render quanta into it.

**`LiveTranscriber` / `LiveSession` (`ribo-core`, new seam).** `openSession(recording)` returns a
handle with `feed(frame)`, `segments$`, and `close()`, plus `liveCapability()` on the transcriber.

**`ribo-transcriber-ondevice` (extended).** Implements it by adding a live conversation to the worker
protocol alongside `prime` and `transcribe`.

### The frame loop

Per 512-sample frame, in the worker:

1. Run Silero, passing the previous `state` tensor and keeping the one it returns. **This is the
   entire streaming-state problem, solved by the model rather than by us.**
2. Hysteresis on the returned probability: enter speech above **0.3**, leave below **0.1**.
3. While in speech, append to a buffer capped at **30 s**.
4. Keep a small FIFO of pre-speech frames (**80 ms**) and prepend it when a region opens, so a
   consonant onset is not clipped by the frame that detected it.
5. After **400 ms** of silence, dispatch the buffer to Moonshine, emit the text, reset.
6. On buffer overflow at 30 s, dispatch and carry the overflow into the next buffer.

Every constant above is the reference implementation's, adopted rather than re-derived — with one
exception worth noting: our batch pipeline's min-speech filter is **250 ms** and so is theirs, arrived
at independently.

**Serialise inference.** transformers.js does not support simultaneous inference in one worker, so
VAD and ASR calls chain through a single promise. This is the same constraint the batch path already
lives under, and it is why §Worker contention matters even with a fast model.

### One model, both paths

Live and batch both run **Moonshine**, because the default on-device model changed while this design
was being written. Revision 5 planned a split — Moonshine for live, Whisper for batch — and spent its
longest section on the resulting tension: two downloads, two residencies, a load-on-record question
with no measurement behind it, and a preview systematically worse than its own final transcript on
exactly the domain terms an auditor checks first.

**All of that is gone.** There is one model, already resident because batch uses it, and the preview
and the transcript now differ only in how much audio each saw.

Two consequences worth stating rather than leaving implied:

- **Neither path has jargon priming.** Whisper's `decoder_input_ids` trick needs a trained
  prior-context token and Moonshine has none — `all_special_tokens` is empty, and a prefix is
  transcribed instead of the audio. So `OnDeviceTranscriber` now refuses hints rather than ignoring
  them. This is a real accuracy cost on the _record_, not just the preview, and it is accounted for
  where it belongs: `docs/implementation/14`, once that document is updated to describe the model this
  package actually ships.
- **`liveCapability()` is weaker than revision 5 claimed.** It called the split from `capability()`
  "load-bearing" because the two paths reported on different weights. They no longer do. It still
  earns its place — live additionally needs Silero, and "ASR cached but VAD missing" is a real state —
  but the justification is now the VAD, not the model.

### Memory

**The swap to Moonshine roughly doubled peak RSS: 3494 MB → 6644 MB**, measured across the 14-transcript
corpus on desktop Chromium. That is a _smaller_ model by weights (247 MB fp32 against Whisper's 291 MB),
so the likeliest cause is that Moonshine processes the full unpadded waveform where Whisper processes a
fixed 30-second mel window — longer sequences, larger attention buffers. **That explanation is a
hypothesis and has not been tested.**

It lands harder here than it did on the batch path. Batch transcription runs after `stop()`, with the
recorder torn down; live inference runs _concurrently with an open microphone, an `AudioWorklet`, and
`MediaRecorder` writing chunks to disk_. The peak is the sum, on the device least able to absorb it.

Two things follow, neither of which this document can settle:

- **Measure per-utterance peak on a phone before planning depth.** Live feeds 2–8 second buffers, not
  54-second ones, so the figure that matters may be far below the corpus peak — or may not be.
- **If it is a wall, moonshine-tiny is the lever** (109 MB fp32 against base's 247 MB) and it is
  plausible _specifically_ for live: its quality collapsed on the full 54-second fixture but was
  comparable to base at 2–8 seconds, which is the only length live produces. That would reintroduce a
  two-model split — but for a measured reason, which is the opposite of the situation revision 5 was in.

### Why not Moonshine v2

Moonshine v2 is an "ergodic streaming encoder" with genuinely incremental encoding — the thing that
would take this from utterance-level to word-level. Our pinned `@huggingface/transformers@4.2.0`
registry contains `moonshine` only; there is no `moonshine_streaming`. Reaching it means a runtime
upgrade, and this design deliberately does not depend on one.

## Data model

The `recording` status, the recording-metadata lifecycle, and the `workSafety` / `audioReady`
contract are specified in [piece 1](durable-capture-design.md). This document adds exactly one field.

### `preview: { segments: string[] }`

An append-only array of utterance texts — no timings, no per-segment engine, no confidence. Index keys
stay stable for incremental rendering; the joined form is `segments.join(" ")`. Timings are excluded
because `transcript.ts` warns that _"a shape nobody consumes is a shape nobody keeps honest"_, and
rendering a growing list needs no offsets.

**No lease, owner or generation token lives here.** Revision 2 put a heartbeat in `preview` and that
was wrong twice: shallow patches let a heartbeat carrying a stale nested object erase a sibling field,
and it made "no preview when live is unavailable" internally false. Revision 9 of piece 1 then deleted
the ownership machinery entirely, so there is nothing left to put anywhere.

`Transcript` itself is untouched: segments live on the preview, so `isSpanGrounded` still validates
spans against exactly the text the model saw.

### Provisional, not authoritative

After `stop()` the whole recording is re-transcribed by the existing batch path and the result replaces
the preview. Chosen so the batch path stays the single source of truth and `Transcript` semantics do
not change.

**The rewrite is user-visible and must be designed for, not hidden** — and revision 5 makes it more
visible, not less: the preview now comes from a _different model_ with _no jargon priming_, so the
final text will differ in wording and, specifically, on domain terms. A UI that presents the preview
as provisional is doing honest work; one that presents it as the transcript will look like it changed
its mind.

### The handoff, and the late-reply race

`preview` is deleted in the same modification that writes `transcript`. A single RxDB modification is
one committed revision, so no subscriber observes half of it. Two requirements, both confirmed sound in
review:

- **Use `incrementalModify` + `delete`, not `patch`.** `Outbox.patch` is an `incrementalPatch`, and
  setting an optional property to `undefined` does not delete the persisted key.
- **A stale live reply must not restore `preview` after the transcript is written.** Every live request
  carries a **session id**; replies from a closed session are discarded, and the append modifier
  additionally **rejects when `status !== "recording"` or `transcript` exists**. Both are required.

A "neither populated" window is legitimate before the first utterance closes. At ~0.7 s it is now
brief enough to read as normal latency rather than as a broken screen — but tests must still permit it
and UI must not treat it as an error.

## Ownership: nothing to add

Revision 3 said the one thing piece 2 adds is _"a live session's generation must be tied to the
recording session's owner token"_. **There is no owner token.** Piece 1 revision 9 replaced ownership
with plain Web Locks exclusion and made recovery write a new row, so nothing ever takes over a
recording and nothing needs authorising.

What remains is ordinary lifecycle: the live session is opened by the capture session and closed by
it. If capture ends — stop, abort, failure, or the tab losing the capture lock — the live session
closes and its in-flight replies are discarded by session id. A lost race costs a discarded preview
reply, which costs nothing.

## Failure handling

**Live must never degrade recording.** A preview is a nicety; the audio is the product.

| Failure                                               | Behaviour                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------- |
| No `LiveTranscriber`, or `liveCapability()` not ready | No preview. Recording and chunk persistence proceed normally.        |
| `AudioWorklet` unavailable                            | No preview. Everything else unaffected.                              |
| Silero or Moonshine fails to load                     | No preview. Recording continues; the batch path is unaffected.       |
| Live transcription throws                             | Preview stops for that session. Recording continues; error surfaced. |
| Worker busy with a batch item                         | Preview starts late. Utterances buffer; see below.                   |
| Transcription falls behind, unbounded                 | Drop closed utterances awaiting transcription, never buffered PCM.   |
| Second tab tries to record                            | Refused by the capture lock (piece 1).                               |
| Crash mid-recording                                   | Piece 1 recovers the audio into a new row. Preview is simply lost.   |

### Worker contention: recording never waits, the preview does

**Revision 3's U1 asked the wrong question.** It sought a way for live to preempt batch so that
"the auditor may have to wait to start recording" could be avoided — and considered a cancellation
boundary inside the inference loop, a second 314 MB worker, and a shared admission lock.

None is needed, because **recording does not use the worker.** `Recorder` contains no reference to
`Worker` at all: `getUserMedia`, `MediaRecorder` and `AnalyserNode` run in the browser's own media
pipeline. Whisper cannot delay the record button, and no design decision here can change that.

The only thing that can wait is the preview. So:

- **The relay stops admitting new items while anything is `recording`.** Revision 2's rule, still
  correct — it was never wrong, only insufficient alone.
- **An in-flight batch item runs to completion.** Live queues behind it.
- **Recording starts instantly, always.**

**Buffer the closed utterances during that wait; do not drop them.** The general backpressure rule
drops closed utterances under load, which is right for _sustained_ overload — but this delay is
bounded by a single item, and a minute of 16 kHz mono PCM is a few megabytes. Buffering lets the
preview catch up in a burst instead of silently missing the opening of the walkthrough.

Never drop buffered **PCM** in either regime: removing PCM would let VAD join speech across the hole
into one false utterance.

## Testing

Four that **must be able to fail**, each easy to write so it does not:

- **Silero's returned state is carried into the next frame.** Pass the initial zero state every time
  and speech detection still broadly works on clean audio, which is exactly why this needs an explicit
  test: the bug is silent and shows up as clipped onsets in noise. Assert the state tensor fed to call
  N+1 is the one returned by call N.
- **A region opening includes the pre-speech FIFO.** Without it the frame that _detected_ speech is the
  first frame transcribed, and the consonant before it is gone. Red if the padding is dropped.
- **A stale live reply after the transcript is written does not restore `preview`.** The naive "never
  both populated" test passes without this and misses the race entirely.
- **`workSafety` must not report `safe` with a recording in progress.** Owned by piece 1 (PR #9);
  restated because live must not regress it.

Also: a legitimate "neither populated" window before the first utterance is permitted; a 30-second
overflow dispatch carries its remainder into the next buffer rather than dropping or duplicating it;
and a manual run where text appears while speaking.

## Open questions

- **Per-utterance peak memory on a real phone.** The one that could stop this feature. See §Memory.
- **Extraction hazard rates on Moonshine transcripts.** WER is measured (7.5 % → 9.2 % mean, +1.7 pp);
  what it does to extracted fields is not, because `score-partb.mjs` reads a clean-text baseline the
  corpus v2 reconciliation replaced with per-transcript files. The harness needs repairing before that
  question can be asked at all.

Two questions revision 5 listed here are now **answered**, and by measurement rather than argument:
Moonshine against Whisper on our corpus (+1.7 pp mean WER, 2× faster, and _better_ than Whisper
unhinted on the jargon-dense transcript — 6.3 % against 22.4 %), and whether Moonshine can be primed
(no; it transcribes the prefix instead of the audio).

- **q8/q4 decoders.** The reference implementation runs Moonshine with a q8 decoder on WASM and q4 on
  WebGPU. `docs/implementation/14` records that q4/q8 do not load on our pinned ORT build — that
  finding was made against Whisper and may not generalise. If it does not, moonshine-base is ~97 MB.
- **WebGPU.** Every figure in the spike is WASM, because the headless harness cannot reach WebGPU. The
  reference implementation prefers it with a WASM fallback, so real-device numbers may be materially
  better than anything measured here.
- Whether utterance boundaries ever need exposing, which would add timings to `preview`.
