# Live transcription — utterance-level preview during recording

**Status:** Design, approved in brainstorming. Not yet planned or implemented.
**Date:** 2026-08-08

## The goal

An auditor dictating a walkthrough sees their words appear as they speak and pause, while standing in
the room — so a misheard reading can be corrected on the spot rather than discovered at review.

Today transcription begins only after the recording is finished: `record → stop() → enqueue → relay →
transcriber.transcribe(recording, audio)`. Nothing is visible until the whole recording has been
processed.

## What this is not

- **Not word-level streaming.** Whisper is an encoder–decoder over a fixed 30-second mel spectrogram;
  the encoder is bidirectional over the whole window, so there is no incremental state to advance.
  Every "live Whisper" system re-runs the model, and because the input is padded to 30 s regardless,
  a 3-second buffer costs the same encoder pass as a 30-second one. There is no cheap short call.
  Utterance-level — text on each pause — fits the model's shape and the measured RTF 0.16
  (`docs/implementation/14`); word-level does not.
- **Not live extraction.** Considered and deliberately deferred. Every extraction call emits all 51
  leaves because the anti-hallucination rule makes every key required and nullable, so a five-second
  utterance costs roughly the same output as a five-minute recording (~1,200 output tokens, estimated
  12–20 s). R3's per-group routing is a hard prerequisite, and even with it there is an undecided
  contradiction policy ("the attic is R-38 — sorry, R-49") and no local model for offline use.
  **Extraction latency has never been measured**; the figures here are arithmetic, not evidence.
- **Not a new public API for consumers.** See "Delivery" below.

## Delivery: consumers already have a stream

`Outbox.watch(query)` returns `Observable<OutboxItem[]>` over an RxDB live query, and
`useOutboxItems` already subscribes to it. Anything written to the outbox document reaches every
consumer reactively. **No new consumer-facing API is added.**

The `segments$` observable in the seam below is internal — between the transcriber and `ribo-core`.
Consumers never see it. This is what keeps live preview additive rather than a second public path to
the same text, which the consuming app would then have to reconcile.

## Architecture

```
mic ─► MediaStream ─┬─► MediaRecorder ──► chunks ──► audio-chunk-NNNN attachments
                    │                                        │ (at stop) merge
                    │                                        ▼
                    │                                 AUDIO_ATTACHMENT_ID
                    └─► AudioWorklet ─► PCM ────► LiveSession.feed()
                                                       │
                                                  [worker: rolling VAD]
                                                       │ utterance closes
                                                       ▼
                                          segments$ ──► item.preview.segments[]
                                                                │
                                                      Outbox.watch() ──► useOutboxItems ──► UI

stop() ─► queued ─► relay ─► transcriber.transcribe(blob) ─► transcript (preview cleared)
```

Live is orchestrated by `ribo-core` against a seam that engines implement — the same direction as the
existing `Transcriber`. The alternative of letting `ribo-transcriber-ondevice` write to the outbox
itself was rejected: it inverts the dependency, breaks the substitutability `firstCapable` relies on,
and would force a second engine to duplicate the orchestration. A separate `ribo-live` package was
rejected because the worker and VAD model live in the ondevice package, so it would either split the
worker or load the model twice.

### Components

**`Recorder` (`ribo-core`, extended).** Gains an optional `onSamples` tap. One `getUserMedia` stream
feeds both `MediaRecorder` — still producing the durable Opus Blob, unchanged — and an `AudioWorklet`
emitting raw 16 kHz PCM. Without the callback, behaviour is identical to today. `MediaRecorder` is
started with a `timeslice` so chunks arrive during recording.

**`LiveTranscriber` / `LiveSession` (`ribo-core`, new seam).** `openSession(recording)` returns a
handle with `feed(pcm)`, a `segments$` observable, and `close()`. Core defines it; engines implement
it. This is what allows a managed live transcriber later without touching core.

**`ribo-transcriber-ondevice` (extended).** Implements `LiveTranscriber` by adding a live conversation
to the worker protocol alongside `prime` and `transcribe`.

### Rolling VAD

The worker keeps a cursor at the last committed sample and runs VAD **only over the uncommitted
tail**, never the whole buffer. When a speech region closes with sufficient trailing silence, that
region is transcribed, emitted, and the cursor advances. If the tail passes 30 s with no pause,
`cutLongRegions` force-closes it at the quietest point.

`binarizeSpeech`, `fillShortSilences`, `dropShortSpeech` and `cutLongRegions` from `segmentation.ts`
all work unchanged on a tail buffer — the module merged in PR #5 does the work.

## Data model

### New `recording` status

```
recording ─► queued ─► transcribing ─► extracting ─► awaiting-review ─► writing ─► done
```

**`recording` MUST NOT be in `ACTIVE_OUTBOX_STATUSES`.** That list drives `nextPending()`, and an item
still recording has no canonical audio attachment yet. If the relay picked it up it would try to
transcribe nothing. (`status` is indexed at `maxLength: 16`; `recording` fits.)

### `preview: { segments: string[] }`

An array of utterance texts. No timings, no per-segment engine, no confidence. Append-only, so index
keys are stable for incremental rendering; the joined form is `segments.join(" ")`.

Timings are deliberately excluded. `transcript.ts` warns that _"a shape nobody consumes is a shape
nobody keeps honest"_, and rendering a growing list needs no offsets. If tapping an utterance becomes
a feature, that is when boundaries earn their place.

**`preview` is deleted in the same update that writes `transcript`.** Exactly one field is
authoritative at any moment, never both.

Note this reverses the reasoning in `transcript.ts` that declined to model segments — the condition it
named ("nothing downstream needs them yet") is what changes here. `Transcript` itself is untouched:
segments live on the preview, not on the transcript, so `isSpanGrounded` still validates spans against
exactly the text the model saw.

### Provisional, not authoritative

Live segments are a preview. After `stop()`, the whole recording is re-transcribed by the existing
batch path with VAD over the complete buffer, and that result replaces the preview. Roughly 2×
inference, and the text visibly rewrites after stop.

The alternative — live text is final, no second pass — halves the compute and avoids the rewrite, but
makes boundary decisions with a rolling VAD that has no lookahead the source of truth. Provisional was
chosen so the batch path remains the single source of truth and `Transcript` semantics do not change.

**One property falls out of this and solves backpressure for free:** if transcription falls behind
speech, the preview backlog can simply be dropped. Nothing is lost, because the full pass is
authoritative. A preview that degrades under load is acceptable in a way a primary transcript never
would be.

### Incremental audio persistence

`MediaRecorder.start(timeslice)` at 5 seconds. Each `ondataavailable` writes one attachment,
zero-padded so lexical order is chronological:

```
audio-chunk-0000, audio-chunk-0001, … ─► (at stop) concatenate ─► AUDIO_ATTACHMENT_ID, chunks deleted
```

Per-chunk rather than appending to one growing attachment: RxDB attachments are not appendable, so
rewriting a growing Blob every 5 seconds is quadratic I/O where N chunks merged once is linear.
Worst-case loss is bounded at one timeslice.

**This reverses a documented invariant and the comment on `enqueue` must be updated to say so.**
`enqueue` currently folds document and audio into one IndexedDB transaction specifically so an item
can never exist without its audio. The live path breaks that deliberately: the item exists first,
audio accrues after. The `recording` status is what keeps it legible — the marker that says "audio
incomplete by design, relay keep out."

### Interrupted recordings

An item found in `recording` at startup means the app died mid-recording. Recovery merges whatever
chunks exist, writes the canonical attachment, and moves it to `queued`; it then flows through the
existing pipeline untouched. No new terminal state, no manual salvage.

Two rules that are where this will actually break:

- **A truncated tail may not decode.** Concatenated `audio/webm;codecs=opus` chunks form a valid file
  because chunk 0 carries the header, but a crash can leave a partial final cluster. Recovery attempts
  the merge and, on decode failure, retries with the last chunk dropped.
- **`durationMs` on a recovered recording is derived from the decoded audio, not the timer** — the
  wall-clock timer died with the app.

## Failure handling

The governing rule: **live must never degrade recording.** A preview is a nicety; the audio is the
product.

| Failure                          | Behaviour                                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| Model not primed, or VAD missing | No preview. Recording and chunk persistence proceed normally.                            |
| `AudioWorklet` unavailable       | No preview. Everything else unaffected.                                                  |
| Live transcription throws        | Preview stops for that session. Recording continues; error surfaced.                     |
| Transcription falls behind       | Drop the backlog. Safe only because the preview is provisional.                          |
| Crash mid-recording              | Merge chunks → `queued`.                                                                 |
| **Chunk write fails**            | **Fatal to the recording; must surface loudly.** The only failure here that loses audio. |

### Worker contention

The worker serializes inference. If the relay is batch-transcribing a previous recording when the
auditor starts a new one, live segments queue behind it — a 30-second batch job stalls the preview by
roughly 5 seconds at RTF 0.16.

**Live work takes priority in the worker's queue.** The auditor is watching; the batch job is for a
recording nobody is looking at. A small change local to `serialize()`.

Pausing the relay entirely during recording was considered — simpler, and better for battery, since
running Whisper while capturing audio on a phone is questionable regardless. Rejected for blast
radius: it changes relay semantics. Worth revisiting if battery proves to matter more than expected.

## Testing

Three that **must be able to fail**, and are easy to write so they do not:

- **The relay must not pick up a `recording` item.** Goes red if `recording` ever lands in
  `ACTIVE_OUTBOX_STATUSES`. This is the guard that stops the relay transcribing a non-existent
  attachment.
- **A deliberately truncated final chunk still recovers**, via drop-last-and-retry. A fixture with a
  clean tail proves nothing.
- **`preview` and `transcript` are never both populated.** The clearing happens in the same update as
  the write.

Also required:

- Unit (node, no model): rolling-VAD cursor advance; force-close at 30 s with no pause; the
  backlog-drop policy; chunk merge ordering.
- Browser (real Chromium): the `AudioWorklet` tap produces 16 kHz PCM; `MediaRecorder` timeslice
  chunks concatenate into a Blob that `decodeAudioData` accepts — the only honest check; an outbox
  item exists during recording in `recording` status with an accumulating preview; the full recovery
  path against a reopened database.
- Manual, opt-in: a real recording where text appears while speaking.

## Open questions

None blocking. Two noted for later:

- Whether relay-pausing during recording beats live-priority once battery is measured.
- Whether utterance boundaries ever need to be exposed (would add timings to `preview`).
