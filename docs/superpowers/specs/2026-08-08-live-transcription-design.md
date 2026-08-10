# Live transcription — utterance-level preview during recording

**Status:** Design, revision 3. **Piece 2 of 2 — BLOCKED on piece 1.** Not yet planned.
**Date:** 2026-08-08, split 2026-08-10

> **Revision 3 splits this design in two.** Revisions 1 and 2 were each reviewed and each found not
> implementable; across both rounds **every critical finding landed in durability and ownership, none
> in the live preview itself**. So that half is now its own document —
> [`2026-08-10-durable-capture-design.md`](2026-08-10-durable-capture-design.md) — which ships on its
> own merits (a crash mid-recording stops losing the audio) and is a **hard prerequisite** for this
> one.
>
> **Moved out of this document into piece 1:** incremental chunk persistence, the `recording` status,
> the lock document and fencing token, the crash-interruption state table, decode-verified recovery,
> the metadata lifecycle, schema v2, and the `workSafety` / `hasAudio` contract changes.
>
> **What stays here, and what changed in this revision:** the `AudioWorklet` tap, the `LiveTranscriber`
> seam, rolling VAD, and the preview field. Two things were corrected by review round two and are now
> **unresolved open problems** rather than settled design — see §Unresolved. The heartbeat that
> revision 2 put inside `preview` has moved to piece 1's lock document, where it belongs: ownership is
> a lifecycle concern, not preview content.

## The goal

An auditor dictating a walkthrough sees their words appear as they speak and pause, while standing in
the room — so a misheard reading can be corrected on the spot rather than discovered at review.

Today transcription begins only after the recording is finished: `record → stop() → enqueue → relay →
transcriber.transcribe(recording, audio)`. Nothing is visible until the whole recording is processed.

## What this is not

- **Not word-level streaming.** Whisper is an encoder–decoder over a fixed 30-second mel spectrogram;
  the encoder is bidirectional, so there is no incremental state to advance. Every "live Whisper"
  system re-runs the model, and because input is padded to 30 s regardless, a 3-second buffer costs
  the same encoder pass as a 30-second one. There is no cheap short call. Utterance-level fits the
  model's shape and the measured RTF 0.16 (`docs/implementation/14`); word-level does not.
- **Not live extraction.** Deliberately deferred. Every extraction call emits all 51 leaves because
  the anti-hallucination rule makes every key required and nullable, so a five-second utterance costs
  roughly what a five-minute recording does (~1,200 output tokens; **estimated** 12–20 s — extraction
  latency has never been measured). R3's per-group routing is a hard prerequisite, and even then the
  contradiction policy ("the attic is R-38 — sorry, R-49") is undecided and there is no local model
  for offline use.
- **Not diarization.** The VAD model can do it; we are not asking.

## Delivery: consumers already have a stream

`Outbox.watch(query)` returns `Observable<OutboxItem[]>` over an RxDB live query, and
`useOutboxItems` already subscribes. Anything written to the outbox document reaches consumers
reactively, so **no new subscription mechanism is added** and the `segments$` observable in the seam
below stays internal to core.

**This is not the same as "no API change", which revision 1 wrongly claimed.** `OutboxStatus` and
`OutboxItem` are public types. Adding `recording` grows a union that consumers may switch on
exhaustively, which is a compile-time break, and adding `preview` widens the item. That is the right
trade — the alternative is the relay silently transcribing an item with no audio — but it must be
declared, and `schema.test.ts`'s status-partition test (which deliberately fails when a status
belongs to no category) must be satisfied by **naming a new category**, never by weakening it.

## Architecture

```
mic ─► MediaStream ─┬─► MediaRecorder ──► chunks ──► audio-chunk-NNNN attachments
                    │                                        │ (at stop) merge
                    │                                        ▼
                    │                                 AUDIO_ATTACHMENT_ID
                    └─► AudioWorklet ─► PCM ────► LiveSession.feed()
                                                       │
                                              [worker: rolling VAD + state]
                                                       │ utterance closes
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
audio falls back to a fixed-window march without VAD. Live has no such fallback — rolling VAD is the
mechanism — so "batch ready, live unavailable" is a real state the existing probe cannot express.

### Components

**`Recorder` (`ribo-core`, extended).** Gains an optional `onSamples` tap; one `getUserMedia` stream
feeds both `MediaRecorder` — still producing the durable Opus Blob — and an `AudioWorklet` emitting
16 kHz PCM. Started with a `timeslice` so chunks arrive during recording. Without the callback,
behaviour is identical to today.

**`LiveTranscriber` / `LiveSession` (`ribo-core`, new seam).** `openSession(recording)` returns a
handle with `feed(pcm)`, `segments$`, and `close()`, plus `liveCapability()` on the transcriber.

**`ribo-transcriber-ondevice` (extended).** Implements it by adding a live conversation to the worker
protocol alongside `prime` and `transcribe`.

### Rolling VAD needs explicit streaming state

**Revision 1 claimed the segmentation helpers work unchanged on a tail buffer. They do not.**

`binarizeSpeech` begins every call outside speech and pushes a still-open region when it reaches the
end of the buffer, so its output cannot distinguish "closed below `leave`" from "hit the current
tail". The concrete loss: after a forced 30-second cut the cursor starts _mid-speech_; if the first
new probability sits between `leave` and `onset`, real hysteresis would still be in speech but a
fresh call stays in silence until some later frame reaches `onset` — and the audio in between is
gone.

So the rolling driver carries state across feeds:

```ts
interface VadStreamState {
  readonly inSpeech: boolean; // hysteresis carried across the boundary
  readonly openRegionStart?: number; // frame index, when a region is still open
}
```

`segmentation.ts` gains a streaming entry point that accepts an initial state and returns the final
one, alongside the existing whole-buffer functions (which keep working for the batch path). A forced
cut seeds the next call with `inSpeech: true`.

The worker keeps a cursor at the last committed sample and runs VAD only over the uncommitted tail.
A region closes — and is transcribed and emitted — only when trailing silence exceeds `minSilence`;
a region still open at the tail is _not_ emitted, it waits for more audio. If the tail passes 30 s
with no pause, `cutLongRegions` force-closes at the quietest point and the state seeds as above.

## Data model — mostly in piece 1

The `recording` status, the recording-metadata lifecycle, `finalizeRecording`, schema v2, and the
`workSafety` / `hasAudio` contract changes are all specified in
[piece 1](2026-08-10-durable-capture-design.md). This document adds exactly one field.

### `preview: { segments: string[] }`

An append-only array of utterance texts — no timings, no per-segment engine, no confidence. Index keys
stay stable for incremental rendering; the joined form is `segments.join(" ")`. Timings are excluded
because `transcript.ts` warns that _"a shape nobody consumes is a shape nobody keeps honest"_, and
rendering a growing list needs no offsets.

**No lease or owner token lives here.** Revision 2 put the heartbeat in `preview` and that was wrong
twice: shallow patches let a heartbeat carrying a stale nested object erase a sibling field, and it made
"no preview when live is unavailable" internally false. Ownership lives on piece 1's lock document.

`Transcript` itself is untouched: segments live on the preview, so `isSpanGrounded` still validates
spans against exactly the text the model saw.

### Provisional, not authoritative

After `stop()` the whole recording is re-transcribed by the existing batch path and the result replaces
the preview — roughly 2x inference, and the text visibly rewrites. Chosen so the batch path stays the
single source of truth and `Transcript` semantics do not change.

**Backpressure falls out of this**, but needs defining rather than assuming. Under load, drop **closed
utterances awaiting transcription** — never buffered PCM, because removing PCM would let VAD join
speech across the hole into one false utterance. Nothing is lost either way; the full pass is
authoritative.

### The handoff, and the late-reply race

`preview` is deleted in the same modification that writes `transcript`. A single RxDB modification is
one committed revision, so no subscriber observes half of it. Two requirements, both confirmed sound in
review:

- **Use `incrementalModify` + `delete`, not `patch`.** `Outbox.patch` is an `incrementalPatch`, and
  setting an optional property to `undefined` does not delete the persisted key.
- **A stale live reply must not restore `preview` after the transcript is written.** Every live request
  carries a **session generation**; replies from a closed session are discarded, and the append modifier
  additionally **rejects when `status !== "recording"` or `transcript` exists**. Both are required.

A "neither populated" window is **legitimate** before the first utterance closes; tests must not forbid
it.

## Ownership, persistence and recovery — all piece 1

The single-recorder lock document, the fencing token checked on every write, claimed recovery, the
commit-order interruption table, and decode-verified per-container recovery are specified in
[piece 1](2026-08-10-durable-capture-design.md) §3–§4. This document depends on all of it and restates
none of it.

The one thing piece 2 adds: a live session's generation must be tied to the recording session's owner
token, so a tab that loses ownership mid-recording stops feeding PCM as well as stopping capture.

## Failure handling

**Live must never degrade recording.** A preview is a nicety; the audio is the product.

| Failure                                               | Behaviour                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| No `LiveTranscriber`, or `liveCapability()` not ready | No preview. Recording and chunk persistence proceed normally.                 |
| `AudioWorklet` unavailable                            | No preview. Everything else unaffected.                                       |
| Live transcription throws                             | Preview stops for that session. Recording continues; error surfaced.          |
| Transcription falls behind                            | Drop closed utterances awaiting transcription, never buffered PCM.            |
| Second tab tries to record                            | Refused with a reason.                                                        |
| Crash mid-recording                                   | Lease expires → recovery per the state table.                                 |
| **Chunk write fails**                                 | **Stop capture, salvage in-memory audio, leave recoverable, surface loudly.** |

### Worker contention: the relay pauses during recording

**Revision 1's "live takes priority in `serialize()`" does not work.** One batch request owns the
serializer for its _entire_ duration — planning plus every sequential Whisper chunk — so a live
request cannot interleave between chunks. On a multi-minute backlog the preview would wait minutes,
not the ~5 s claimed. Real preemption would need per-pass scheduling plus an anti-starvation rule.

Instead: **the relay does not drain while any item is in `recording`.** Live has the worker to
itself; the relay resumes and drains the backlog at `stop()`. One condition the relay checks, no
scheduler, no fairness rule — and it is better for battery, since running Whisper while capturing
audio on a phone is questionable regardless.

## Testing

Five that **must be able to fail**, each easy to write so it does not:

- **The relay must not pick up a `recording` item.** Red if `recording` ever lands in
  `ACTIVE_OUTBOX_STATUSES`.
- **`workSafety` must not report `safe` with a recording in progress.** Red if `recording` is not
  classified as pending. Revision 1 would have shipped this bug.
- **A second tab is refused while a lease is fresh, and recovers once it is stale.** Both halves, or
  it proves only one.
- **A deliberately truncated final chunk still recovers** via drop-last-and-retry. A clean tail
  proves nothing.
- **A stale live reply after the transcript is written does not restore `preview`.** The naive
  "never both populated" test passes without this and misses the race entirely.

Rolling-VAD boundary cases, all node-side with no model: a tail ending inside speech is not emitted;
a probability between `onset` and `leave` across a forced cut does not lose audio; a short silence
spanning two feeds is joined; re-feeding the same uncommitted tail emits nothing twice.

Also: the crash-interruption table exercised at each row against a reopened database; chunk merge
ordering and decodability in real Chromium (`decodeAudioData` is the only honest check); a legitimate
"neither populated" window before the first utterance is permitted; and a manual run where text
appears while speaking.

## Unresolved — must be settled before this piece is planned

Review round two showed two of revision 2's answers do not work. Neither is fixed here, and both are
**blocking for piece 2** (not for piece 1).

### U1. Worker exclusion: pausing the relay is not sufficient

Revision 2 replaced "live takes priority in `serialize()`" with "the relay pauses while any item is in
`recording`". That is still wrong, for a reason revision 2 missed: **a recording can start after the
relay has already begun a batch transcription.** The relay runs a step to completion, and one on-device
request holds the inference serializer across every one of its chunks. Checking for `recording` before
the _next_ relay iteration cannot preempt work already in flight, so live can still wait minutes — the
exact revision-1 failure.

Candidate directions, none chosen:

- **Coordinate admission at one point.** Recorder acquisition and relay admission share the lock, so a
  recording cannot start while a batch step is running, or vice versa. Simple and bounded; means the
  auditor may have to wait to start recording, which is likely unacceptable.
- **A cancellation boundary between Whisper chunks.** The batch request checks for cancellation between
  chunks and yields, resuming later. Genuine preemption without a full scheduler, but it makes batch
  transcription interruptible and re-entrant, which is new behaviour with its own failure modes.
- **A second worker for live.** Full isolation, at the cost of a second copy of the model in memory —
  likely fatal on a phone at ~314 MB fp32.

The cancellation boundary looks most promising, and it is a change to the ondevice package's inference
loop rather than to relay semantics. It needs its own design.

### U2. `VadStreamState` is under-specified

`inSpeech` and `openRegionStart` preserve hysteresis but do not represent everything that must survive
a feed boundary:

- a below-`leave` silence run that has not yet reached `minSilence`;
- a preceding region waiting to learn whether that silence gets filled (the pipeline fills short
  silences **before** dropping short speech, so the fill decision is retrospective);
- padding already consumed on the previous side of a boundary;
- **the VAD model's own overlap context** — stable probabilities come from overlapping 10-second
  inference windows averaged together, and binarizer state alone does not preserve that;
- the committed cursor's exact relationship to padded-and-transcribed audio.

The "short silence spanning two feeds" test cannot pass without more retained state than the current
contract names. Getting this wrong loses or duplicates speech at boundaries, silently — so the state
contract needs to be derived properly, not extended piecemeal until tests pass.

## Open questions

None blocking. Noted for later: whether utterance boundaries ever need exposing (would add timings to
`preview`), and whether the lease staleness threshold needs tuning against real device sleep
behaviour.
