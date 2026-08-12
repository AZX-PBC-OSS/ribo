# Live transcription — utterance-level preview during recording

**Status:** Design, revision 4. **Piece 2 of 2.** Not yet planned.
**Date:** 2026-08-08, split 2026-08-10, revised 2026-08-11

> **Revision 4 unblocks this document.** Revision 3 ended with two problems marked *"must be settled
> before this piece is planned"*, and both are settled here — neither by adding a mechanism. Each was
> the wrong mechanism, and naming the right one made the problem disappear.
>
> - **U1 (worker exclusion) was mis-framed.** It asked how live and batch share the Whisper worker
>   "without making recording wait". **Recording never waits.** `Recorder` has no worker: it is
>   `getUserMedia` + `MediaRecorder` + `AnalyserNode`, all browser-native. Whisper cannot block it.
>   Only the *preview* can wait, and a late preview is the degradation this design already blesses.
>   See §Worker contention.
> - **U2 (`VadStreamState`) was the wrong shape.** Carrying binarizer hysteresis across feeds cannot
>   work, because the *probabilities themselves* are not final near the tail — VAD averages
>   overlapping inference windows. Recomputing from a committed cursor needs **no carried state at
>   all**. See §Rolling VAD.
>
> **Revision 4 also rebases this document onto durable capture revision 9.** Revision 3 depended on
> piece 1's lock document, fencing token, lease expiry, owner token and interruption state table.
> Revision 9 **deleted all of them** — every one of those words now appears in that document only in
> its table of deletions. The dependency shrinks rather than needing replacement: with nothing taking
> over, a live session needs no fence.
>
> **And it states a latency budget for the first time.** "Live" here means roughly **9–15 s behind the
> spoken word on desktop**, and that is a derived floor, not a target to optimise toward later. See
> §What "live" actually costs. If that number is unacceptable, this feature needs rethinking rather
> than tuning — which is exactly why it belongs at the top of a design rather than in a retrospective.

## The goal

An auditor dictating a walkthrough sees their words appear shortly after they speak and pause, while
standing in the room — so a misheard reading can be corrected on the spot rather than discovered at
review.

Today transcription begins only after the recording is finished: `record → stop() → enqueue → relay →
transcriber.transcribe(recording, audio)`. Nothing is visible until the whole recording is processed.

**Read §What "live" actually costs before anything else.** The goal above is achievable; "as they
speak" is not, and the difference is large enough to change whether this is worth building.

## What this is not

- **Not word-level streaming.** Whisper is an encoder–decoder over a fixed 30-second mel spectrogram;
  the encoder is bidirectional, so there is no incremental state to advance. Every "live Whisper"
  system re-runs the model, and because input is padded to 30 s regardless, a 3-second buffer costs
  the same encoder pass as a 30-second one. There is no cheap short call. Utterance-level fits the
  model's shape and the measured RTF 0.158 (`docs/implementation/14`); word-level does not.
- **Not live extraction.** Deliberately deferred. Every extraction call emits all 51 leaves because
  the anti-hallucination rule makes every key required and nullable, so a five-second utterance costs
  roughly what a five-minute recording does (~1,200 output tokens; **estimated** 12–20 s — extraction
  latency has never been measured). R3's per-group routing is a hard prerequisite, and even then the
  contradiction policy ("the attic is R-38 — sorry, R-49") is undecided and there is no local model
  for offline use.
- **Not diarization.** The VAD model can do it; we are not asking.
- **Not authoritative.** The batch pass after `stop()` replaces the preview entirely. See §Provisional.

## What "live" actually costs

Three latencies compose, and none of them is an implementation detail that better code removes.

**1. VAD settle: 5–10 s.** `speechTimeline` runs pyannote over **fixed 10-second windows advancing
50%**, and averages the overlapping frames — a frame's probability is provisional until every window
covering it has run. With window `W = 10 s` and advance `a = 5 s`, a frame at time `s` is covered by
windows starting in `(s − W, s]`; the last of them starts at `⌊s/a⌋·a` and completes once audio
reaches `⌊s/a⌋·a + W`. So:

```
settle(s) ∈ (s + 5 s,  s + 10 s]
```

This is a property of the model's 10-second training duration, not of our code. A **larger** advance
lowers the lag (toward `s + W − a`) at the cost of less averaging; a smaller advance raises it toward
the full `s + 10 s` while buying more. Ten seconds is the floor set by `W` regardless.

**2. Utterance close.** A region is emitted only once trailing silence exceeds `minSilence`. **The
batch default of 100 ms is wrong for live** and this is easy to miss: batch does not care about
utterance granularity because `mergeRegions` immediately merges everything up to 30 s, so 100 ms only
protects against splitting inside a word. Live emits what the binarizer produces, so at 100 ms it
would emit fragments at inter-word gaps. Live needs its own `minSilenceMs` — **500–700 ms** is the
usual conversational-boundary range — and it needs measuring, not assuming.

**3. Whisper inference: ~3–4 s per utterance on desktop.** Every utterance is padded to the full 30 s
window, so cost is per-call and nearly independent of utterance length. Derived from RTF 0.158 over a
54 s clip (2–3 chunks, ~3–4 s each), measured **on a development machine**. A phone is plausibly 2–4×
that and **has never been measured** — the single most important unmeasured number in this design.

**Total: ~9–15 s on desktop.** Longer on the target device.

That still supports the goal — the auditor is in the room for far longer than fifteen seconds — but
it is not "words appearing as you speak", and any UI built on this must not imply that it is. A
preview that lags a sentence or two behind reads as *thinking*; one that claims to be live and lags
reads as *broken*.

## Delivery: consumers already have a stream

`Outbox.watch(query)` returns `Observable<OutboxItem[]>` over an RxDB live query, and
`useOutboxItems` already subscribes. Anything written to the outbox document reaches consumers
reactively, so **no new subscription mechanism is added** and the `segments$` observable in the seam
below stays internal to core.

**This is not the same as "no API change", which revision 1 wrongly claimed.** `OutboxItem` is a
public type and adding `preview` widens it. `OutboxStatus` already carries `recording` on `main`, so
this document no longer adds it — but the mechanism behind that status (capture session, capture
lock, recovery, capture health) is **open on PR #9, not merged**. Piece 2 cannot be planned against
it until that lands.

## Architecture

```
mic ─► MediaStream ─┬─► MediaRecorder ──► chunks ──► audio-chunk-NNNN attachments
                    │                                        │ (at stop) merge
                    │                                        ▼
                    │                                 AUDIO_ATTACHMENT_ID
                    └─► AudioWorklet ─► PCM ────► LiveSession.feed()
                                                       │
                                        [worker: VAD from cursor + Whisper]
                                                       │ utterance settles
                                                       ▼
                                          segments$ ──► item.preview.segments[]
                                                                │
                                                      Outbox.watch() ──► useOutboxItems ──► UI

stop() ─► queued ─► relay ─► transcriber.transcribe(blob) ─► transcript (preview deleted)
```

Live is orchestrated by `ribo-core` against a seam engines implement — the same direction as
`Transcriber`. Letting the engine write to the outbox itself was rejected: it inverts the dependency
and breaks the substitutability `firstCapable` relies on. A separate `ribo-live` package was rejected
because the worker and VAD model live in the ondevice package.

### The live seam is NOT composed through `firstCapable`

`firstCapable` takes `Transcriber[]` and returns a composite exposing batch `transcribe`,
`capabilities` and `invalidate`. A `LiveTranscriber` is not reachable through it, and widening the
composite would drag a live concern into every batch roster.

Instead the live orchestrator takes an **optional `LiveTranscriber` directly**. If none is supplied,
or its `liveCapability()` is not `ready`, there is simply no preview and recording proceeds
untouched — which is exactly the governing rule below, so this costs nothing.

`liveCapability()` is **separate from `capability()`** and this is load-bearing: the on-device
transcriber deliberately reports batch `ready` when only the ASR weights are cached, because long
audio falls back to a fixed-window march without VAD. Live has no such fallback — VAD is the
mechanism — so "batch ready, live unavailable" is a real state the existing probe cannot express.

### Components

**`Recorder` (`ribo-core`, extended).** Gains an optional `onSamples` tap; one `getUserMedia` stream
feeds both `MediaRecorder` — still producing the durable chunks piece 1 persists — and an
`AudioWorklet` emitting 16 kHz PCM. Without the callback, behaviour is identical to today.

**`LiveTranscriber` / `LiveSession` (`ribo-core`, new seam).** `openSession(recording)` returns a
handle with `feed(pcm)`, `segments$`, and `close()`, plus `liveCapability()` on the transcriber.

**`ribo-transcriber-ondevice` (extended).** Implements it by adding a live conversation to the worker
protocol alongside `prime` and `transcribe`.

### Rolling VAD: recompute from a cursor, carry no state

**Revision 3 proposed a `VadStreamState` carrying `inSpeech` and `openRegionStart` across feeds, and
flagged it as under-specified. It is worse than under-specified — it is the wrong mechanism**, and
extending it would have produced a contract that passes tests while still losing speech.

Carried hysteresis assumes the per-frame probabilities are settled and only the *binarizer* needs
continuity. They are not. `speechTimeline` averages overlapping inference windows, so a frame near the
tail has been seen by **one** window and its value will change when the next window arrives. No amount
of binarizer state fixes an input that is still moving. Revision 3's own list of things that must
survive a boundary — a not-yet-`minSilence` silence run, a preceding region awaiting a retrospective
fill decision, consumed padding, the model's overlap context, the cursor's relation to padded audio —
is a list of five symptoms of that one cause.

**So live does not stream the pipeline. It re-runs it.**

The session keeps a single piece of state: **`committedSamples`**, the offset past which every
utterance has already been emitted. On each feed:

1. Run VAD over `[committedSamples − lookback, now]`, where `lookback` covers the settle window
   (≥ `W` = 10 s) so the recomputed region begins from settled probabilities.
2. Run the **existing whole-buffer pipeline** over that span, unchanged: `binarizeSpeech` →
   `fillShortSilences` → `dropShortSpeech` → `padRegions` → `cutLongRegions`. Live skips
   `mergeRegions` alone, which exists to build 30-second batch chunks and would destroy utterance
   granularity. `cutLongRegions` is kept — it is what bounds the tail, below.
3. Emit only regions that are **entirely settled** — ending before `now − W` — and that closed with
   trailing silence ≥ live's `minSilence`. Advance `committedSamples` to the end of the last emitted
   region.
4. A region still open at the settled boundary is not emitted; it waits for more audio.

This is idempotent: re-feeding the same tail emits nothing new, because `committedSamples` did not
move. Every one of revision 3's five boundary hazards is gone — not handled, absent — because no
decision is ever carried across a boundary. The functions in `segmentation.ts` are reused verbatim
rather than gaining a streaming variant.

**Bounding the recomputation.** If nobody pauses, the uncommitted tail grows without limit and each
feed re-runs VAD over all of it. `cutLongRegions` already force-closes any region exceeding 30 s at
its quietest interior frame, so the cursor advances at least every 30 s and the tail stays bounded at
roughly `30 s + lookback` — about six to eight VAD windows, which is cheap beside one Whisper pass.

**The cost is redundant VAD passes.** A frame is re-examined on every feed until it commits. That is
deliberate: VAD is a 6 MB model over 10-second windows, Whisper is 314 MB padded to 30 s, and trading
the cheap one to delete an entire class of silent correctness bug is the right direction. It should
still be measured on a phone before this ships.

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
the preview — roughly 2× inference, and the text visibly rewrites. Chosen so the batch path stays the
single source of truth and `Transcript` semantics do not change.

**The rewrite is user-visible and must be designed for, not hidden.** Batch merges utterances into
30-second chunks with different boundaries and more context, so the final text will differ from the
preview in wording, not only in layout.

### The handoff, and the late-reply race

`preview` is deleted in the same modification that writes `transcript`. A single RxDB modification is
one committed revision, so no subscriber observes half of it. Two requirements, both confirmed sound in
review:

- **Use `incrementalModify` + `delete`, not `patch`.** `Outbox.patch` is an `incrementalPatch`, and
  setting an optional property to `undefined` does not delete the persisted key.
- **A stale live reply must not restore `preview` after the transcript is written.** Every live request
  carries a **session id**; replies from a closed session are discarded, and the append modifier
  additionally **rejects when `status !== "recording"` or `transcript` exists**. Both are required.

A "neither populated" window is **legitimate** before the first utterance settles — and given the
latency budget it lasts on the order of ten seconds, so it is the normal opening state rather than an
edge case. Tests must not forbid it and UI must not treat it as an error.

## Ownership: nothing to add

Revision 3 said the one thing piece 2 adds is *"a live session's generation must be tied to the
recording session's owner token"*. **There is no owner token.** Piece 1 revision 9 replaced ownership
with plain Web Locks exclusion and made recovery write a new row, so nothing ever takes over a
recording and nothing needs authorising.

What remains is ordinary lifecycle: the live session is opened by the capture session and closed by
it. If capture ends — stop, abort, failure, or the tab losing the capture lock — the live session
closes and its in-flight replies are discarded by session id. A lost race costs a discarded preview
reply, which costs nothing.

## Failure handling

**Live must never degrade recording.** A preview is a nicety; the audio is the product.

| Failure                                              | Behaviour                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| No `LiveTranscriber`, or `liveCapability()` not ready | No preview. Recording and chunk persistence proceed normally.        |
| `AudioWorklet` unavailable                           | No preview. Everything else unaffected.                              |
| Live transcription throws                            | Preview stops for that session. Recording continues; error surfaced. |
| Worker busy with a batch item                        | Preview starts late. Utterances buffer; see below.                   |
| Transcription falls behind, unbounded                | Drop closed utterances awaiting transcription, never buffered PCM.   |
| Second tab tries to record                           | Refused by the capture lock (piece 1).                               |
| Crash mid-recording                                  | Piece 1 recovers the audio into a new row. Preview is simply lost.   |

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
- **An in-flight batch item runs to completion.** Live queues behind it. Worst case is one item:
  ~47 s for a five-minute recording at RTF 0.158, and only when a drain happened to be running.
- **Recording starts instantly, always.**

**Buffer the closed utterances during that wait; do not drop them.** The general backpressure rule
below drops closed utterances under load, which is right for *sustained* overload — but this delay is
bounded by a single item, and 47 s of 16 kHz mono PCM is about 3 MB. Buffering lets the preview catch
up in a burst instead of silently missing the opening minute of the walkthrough, which is the part an
auditor is most likely to be watching. Dropping remains the rule when the backlog is unbounded.

Never drop buffered **PCM** in either regime: removing PCM would let VAD join speech across the hole
into one false utterance.

## Testing

Five that **must be able to fail**, each easy to write so it does not:

- **Re-feeding the same uncommitted tail emits nothing twice.** The idempotence the cursor buys is the
  whole correctness argument for recomputation; a test that only feeds forward never exercises it.
- **A region still open at the settled boundary is not emitted**, and *is* emitted once later audio
  closes it. Both halves — the first alone passes against code that never emits.
- **A silence shorter than live's `minSilence` spanning two feeds does not split an utterance.** This
  is the test revision 3 could not pass without more carried state; under recomputation it should pass
  with none, which is the claim worth checking.
- **A stale live reply after the transcript is written does not restore `preview`.** The naive "never
  both populated" test passes without this and misses the race entirely.
- **`workSafety` must not report `safe` with a recording in progress.** Owned by piece 1 (PR #9);
  restated because live must not regress it.

Also: a legitimate "neither populated" window before the first utterance is permitted; a forced 30-second
cut advances the cursor and does not duplicate the audio either side of it; and a manual run where text
appears while speaking, timed against §What "live" actually costs rather than against "instantly".

**One measurement gates planning:** per-utterance Whisper latency on a real phone. The budget above is
derived from a desktop figure, and if the device number is 4× rather than 2×, the total lands near
half a minute and the feature does not deliver its goal. That is a spike, not a task.

## Open questions

- **Live's `minSilenceMs`** needs measuring against real dictation. The batch default of 100 ms is
  certainly wrong; 500–700 ms is the starting range, not an answer.
- **Whether the 5–10 s VAD settle can be traded away.** A tail-anchored window — run VAD over the last
  10 s ending at *now*, rather than on the global grid — would give an immediate unaveraged probability
  and remove most of that lag, at the cost of noisier boundaries near the tail. It is the obvious
  optimisation if the field lag proves unacceptable, and it is deliberately not taken now: it trades a
  correctness margin for latency, and that trade should be made against a measurement.
- Whether utterance boundaries ever need exposing, which would add timings to `preview`.
