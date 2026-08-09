# Live transcription — utterance-level preview during recording

**Status:** Design, revision 2. Not yet planned or implemented.
**Date:** 2026-08-08

> **Revision 2** after a review that found revision 1 not implementable. The material changes:
> a **single-recorder lock with a lease** (the database is `multiInstance: true`, so "any item in
> `recording` at startup was abandoned" was wrong — a second tab would have recovered a live
> recording out from under the first); **the relay pauses during recording** instead of live taking
> priority in the worker (one batch request owns the serializer for its whole duration, so "priority"
> would have meant minutes of delay, not seconds); **explicit streaming state for the rolling VAD**
> (the existing helpers do _not_ work unchanged on a tail buffer); a **crash-interruption state
> table** for the merge; **`recording` counted as pending work** by `summarizeWork`; and an honest
> acknowledgement that the status union growing **is** a public API change.

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

## Data model

### New `recording` status

```
recording ─► queued ─► transcribing ─► extracting ─► awaiting-review ─► writing ─► done
```

Three separate registrations, each of which fails differently if missed:

- **NOT in `ACTIVE_OUTBOX_STATUSES`** — that list drives `nextPending()`, and an item still recording
  has no canonical attachment. The relay would try to transcribe nothing.
- **NOT in `FINISHED_OUTBOX_STATUSES`** — it is not terminal.
- **Counted as PENDING by `summarizeWork`.** Revision 1 missed this and it is the worst of the three.
  `summarizeWork` counts active statuses plus `awaiting-review`; everything else but `done`/`dead`
  falls through uncounted, so a lone in-progress recording would make `workSafety` return **`safe`**
  while the only copy of that audio is still accumulating locally. That module's contract is _never
  overstate safety_. `recording` must be classified explicitly, independent of relay activity.

`status` is indexed at `maxLength: 16`; `recording` fits.

### Recording metadata lifecycle must change

The item now exists before capture ends, and the current contracts cannot express that:

- `capturedAt` means "when capture finished" and `durationMs` is the final audio duration; the
  recorder does not mint the id or metadata until `stop()`.
- **`OutboxPatch` deliberately excludes `recording`**, so neither stop nor recovery can write a final
  `durationMs` at all — revision 1 promised exactly that and it is not writable.

The change:

- **`capturedAt` becomes capture START.** More natural for an item that exists during capture, and
  the recorder can supply it at `start()`.
- **`durationMs` is `0` while recording** and written at commit.
- **A narrow `finalizeRecording(id, { durationMs })`** rather than widening `OutboxPatch`. The
  exclusion exists for good reason; a dedicated method keeps it intact for everything else and is
  legal only on the `recording → queued` transition.
- On recovery `durationMs` comes from the **decoded audio**, not the wall clock, which died with the
  app.

### `preview: { segments: string[]; leaseAt: string }`

`segments` is an append-only array of utterance texts — no timings, no per-segment engine, no
confidence. Index keys are stable for incremental rendering; the joined form is
`segments.join(" ")`. Timings are excluded because `transcript.ts` warns that _"a shape nobody
consumes is a shape nobody keeps honest"_ and rendering a growing list needs no offsets.

`leaseAt` is the heartbeat described below.

`Transcript` itself is untouched: segments live on the preview, so `isSpanGrounded` still validates
spans against exactly the text the model saw.

### Provisional, not authoritative

After `stop()` the whole recording is re-transcribed by the existing batch path and the result
replaces the preview — roughly 2× inference, and the text visibly rewrites. Chosen so the batch path
stays the single source of truth and `Transcript` semantics do not change.

**Backpressure falls out of this**, but needs defining rather than assuming. Under load we drop
**closed utterances awaiting transcription** — never buffered PCM, because removing PCM would let VAD
join speech across the hole into one false utterance. Nothing is lost either way; the full pass is
authoritative.

### The handoff, and the late-reply race

`preview` is deleted in the same modification that writes `transcript`. A single RxDB modification is
one committed revision, so no subscriber observes half of it.

Two things revision 1 got wrong or omitted:

- **Use `incrementalModify` + `delete`, not `patch`.** `Outbox.patch` is an `incrementalPatch`, and
  setting an optional property to `undefined` does not delete the persisted key. Existing code
  already uses `incrementalModify` + `delete` where key absence matters.
- **A stale live reply can restore `preview` after the transcript is written.** Every live request
  carries a **session generation**; replies from a closed session are discarded, and the preview
  append modifier additionally **rejects when `status !== "recording"` or `transcript` exists**.
  Without both, a late worker reply recreates the field and both are populated at once.

A "neither populated" window is **legitimate** before the first utterance closes, and the tests must
not forbid it.

## Single-recorder lock

**The database runs `multiInstance: true`.** Revision 1's rule — any item in `recording` at startup
was abandoned — would let a second tab recover a _live_ recording, merge its partial chunks, and
queue it while the first tab kept appending.

- **Only one tab may record.** A tab acquires the lock by creating the `recording` item; a second tab
  attempting to start finds a live item and **refuses with a clear reason** rather than racing.
- **The lock is a lease.** The recording tab refreshes `preview.leaseAt` on a fixed interval. An item
  whose lease is older than a documented staleness threshold (a small multiple of the interval) is
  abandoned and recoverable; a fresh lease means another tab owns it.
- **Recovery is conflict-safe** — it runs inside an `incrementalModify` that re-checks staleness, so
  two tabs racing to recover cannot both win.

## Commit and crash-interruption states

RxDB cannot span the canonical-attachment write, the status change, and chunk deletion in one
transaction. The order is load-bearing and every interruption point needs a defined answer.

**Order: (1) write canonical attachment → (2) status `recording → queued` → (3) delete chunks.**

| Interrupted after | On-disk state                         | Recovery                                                |
| ----------------- | ------------------------------------- | ------------------------------------------------------- |
| — (before 1)      | `recording`, chunks only              | Merge chunks → write canonical → (2) → (3)              |
| 1                 | `recording`, canonical **and** chunks | Canonical already exists: **skip the merge**, go to (2) |
| 2                 | `queued`, canonical and chunks        | Harmless; run (3) idempotently on next open             |
| 3                 | `queued`, canonical only              | Nothing to do                                           |

So recovery's first question is always **"does the canonical attachment exist?"**, not "are there
chunks?". `queued` before canonical would recreate the exact relay race `recording` exists to
prevent; deleting chunks before the canonical commit could lose the recording. Both orderings are
forbidden.

**A truncated tail may not decode.** Concatenated `audio/webm;codecs=opus` chunks form a valid file
because chunk 0 carries the header, but a crash can leave a partial final cluster. Recovery attempts
the merge and, on decode failure, retries with the last chunk dropped.

### `stop()` must await outstanding chunk writes

`dataavailable` is currently synchronous bookkeeping into an in-memory array, and `MediaRecorder`'s
`stop` event guarantees the final handler _fired_ — not that an async IndexedDB write it started has
committed. The session therefore keeps a **persistence chain** of chunk writes that `stop()` awaits
before merging. Without it the merge can silently omit the last chunk, or race a slow earlier one.

**Chunk-write failure is the one failure here that loses audio, so its settlement is concrete:** stop
capture immediately, attempt to write the in-memory Blob as the canonical attachment, and if that
also fails leave the item in `recording` with an error marker so it stays recoverable. Never delete
it, and never report success.

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

## Open questions

None blocking. Noted for later: whether utterance boundaries ever need exposing (would add timings to
`preview`), and whether the lease staleness threshold needs tuning against real device sleep
behaviour.
