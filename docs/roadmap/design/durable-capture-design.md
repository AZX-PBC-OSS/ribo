# Durable capture — audio survives a crash mid-recording

**Status:** Design, **revision 9 — simplified**. Not yet implemented.
**Date:** 2026-08-10

> **Revision 9 deletes most of revision 8.** A whole-project review made the argument that revisions 1
> through 8 had converged on internal consistency rather than on whether the mechanism should exist —
> five of the eight fixed injuries the design had inflicted on itself. It proposed one change, and that
> change removes the majority of the machinery:
>
> ## **Recovery writes a NEW row. It never mutates the interrupted one.**
>
> Everything revision 8 built existed to make it safe for a second actor to take over a row that a
> first actor might still be writing to. Remove the takeover and the entire problem class goes with it:
>
> | Deleted                                    | Why it existed                                 | Why it is gone                                                                                                                                     |
> | ------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
> | `capture.owner` and the write fence        | authorise writes after a takeover              | nothing takes over                                                                                                                                 |
> | `canonicalAttachmentId` pointer            | stop a stale writer overwriting verified audio | no stale writer exists                                                                                                                             |
> | owner-scoped canonical naming              | same                                           | same                                                                                                                                               |
> | owner rotation on recovery                 | make the fence effective                       | no fence                                                                                                                                           |
> | the restored-context revalidation protocol | catch a bfcache-resumed writer                 | it can only touch its own abandoned row, which nothing reads                                                                                       |
> | most of the interruption state table       | disambiguate half-finished takeovers           | recovery starts from chunks and writes once                                                                                                        |
> | `step.generation` and the relay claim      | —                                              | **out of scope entirely**: this was a pre-existing multi-tab relay problem that revision 8 adopted. It is real, and it is not this design's to fix |
> | Task 1, the bfcache spike                  | measure whether the fence defends a real path  | there is no fence to justify                                                                                                                       |
>
> **Twelve plan tasks become five.** What survives is the part that was never in question: write chunks
> during capture, merge and verify them at stop, and be able to recover what a crash left behind.
>
> The cost, stated plainly: an interrupted recording becomes a **visible orphan** the operator resolves,
> rather than something the app silently repairs. Given this is a tool for one auditor with one phone,
> that is arguably the better product behaviour and certainly the more honest one.

## The problem

Audio only becomes durable at `stop()`. `MediaRecorder` accumulates chunks in memory, `stop()` assembles
one `Blob`, and `enqueue` writes the document and that Blob in a single storage transaction. Kill the
tab, or crash the renderer at minute four of a five-minute walkthrough, and **the entire recording is
gone** — there was never anything on disk.

For a field app whose premise is that an auditor drove to a house to make this recording, that is the
most expensive failure available.

## What this does NOT protect, stated first

On **Chrome Android with the screen locked**, the video track mutes and `dataavailable` **stops firing
altogether** until unlock — one large chunk then arrives containing everything captured meanwhile. This
is documented as expected behaviour, not a bug, and the same class of stall occurs on desktop sleep/wake
and on Safari/iOS around track mute-unmute.

So **while a phone is pocketed or backgrounded, nothing reaches disk**, however long that lasts. An
auditor pocketing their phone mid-walkthrough is not an edge case, and this design gives them nothing
for that period. It is still strictly better than today, where _any_ interruption loses _everything_ —
but the claim is **"each flushed chunk is safe"**, never "a five-second bound".

## 1. Capture writes chunks as it goes

`MediaRecorder.start(timeslice)` at 5 seconds. Each `dataavailable` becomes one RxDB attachment, named
from an immutable per-recording `sourceId`:

```
audio-<sourceId>-000123-04          // chunk 123, slice 4
```

- **Per-chunk, not one growing attachment.** RxDB attachments are not appendable, so rewriting a growing
  Blob every 5 seconds is quadratic I/O where N chunks merged once is linear.
- **Oversized chunks are sliced before writing.** A timeslice does not bound chunk size: a Chrome desktop
  sleep/wake has been measured producing 23 MB in one event, and 20 minutes of screen-locked Chrome
  Android producing 15 MB. Byte-slicing is safe — concatenating the parts in order reproduces the
  original exactly — but each slice must carry the negotiated MIME type explicitly, because
  `Blob.slice()` returns an empty `type` and RxDB rejects an empty attachment content type.
- **Fixed-width indices with a defined overflow.** Six digits and two are ample (a million chunks is ~58
  days at 5 s), but capture **fails safely and stops** before an index would overflow rather than
  emitting a name that sorts wrongly and corrupts merge order.
- **`stop()` awaits the outstanding writes.** `MediaRecorder`'s `stop` event guarantees the final
  handler _fired_, not that an async IndexedDB write it started has committed.

**Ingestion and persistence are separate stages.** A single queue deadlocks: a chunk operation that
detects a write failure must finalise, and the final `dataavailable` may already be queued behind it. So
`dataavailable` ingests synchronously into an ordered buffer and returns; a separate loop drains it.

## 2. The `recording` status

```
recording ─► queued ─► transcribing ─► extracting ─► awaiting-review ─► writing ─► done
```

Already implemented. Four registrations, each failing differently if missed: **not** in
`ACTIVE_OUTBOX_STATUSES` (the relay must not select a row with no audio yet), **not** in
`FINISHED_OUTBOX_STATUSES`, **counted as pending** by `summarizeWork` (or `workSafety` answers `safe`
while the only copy is local), and **named as its own category** in the status-partition test.

**`capture: { sourceId }` only.** Revision 8's `owner` is deleted; nothing takes over, so nothing needs
authorising. `canonicalAttachmentId` and `step` are deleted too — see the revision note.

## 3. One recording at a time, via Web Locks

`navigator.locks.request(CAPTURE_LOCK, { ifAvailable: true }, …)` — Baseline Widely Available since
2024-09-14, comfortably inside this project's browser floor.

Held for the duration of a capture session. `null` means the lock is held, so a second tab **refuses to
start** — before touching the microphone — and says capture is busy rather than asserting a recording is
in progress, which would sometimes be untrue.

**This is exclusion only, and that is the whole of its job.** Revision 8 needed the lock to also imply
write authorisation, which it cannot do — a lock can be released while its holder's context survives
(bfcache), and that gap is what the deleted fence existed to close. With recovery writing a new row,
being wrong about liveness costs an orphan, not corruption. **The bfcache question stops mattering.**

## 4. Commit, and recovery

**Commit** — at `stop()`, under the lock the session already holds:

1. Merge the chunk attachments in name order.
2. **Decode-verify** with `decodeAudioData` on the main thread (`AudioContext` is Window-only). The
   transcriber decodes through the same route, so a blob that decodes here will decode there.
3. Write it as `AUDIO_ATTACHMENT_ID` — the ordinary constant, no pointer.
4. Transition `recording → queued` and write `durationMs` from the **decoded** audio.
5. Delete the chunks.

Decode-verification proves **decodability, not completeness**. It cannot establish that every emitted
chunk was persisted, or that a permissive decoder did not accept a truncated tail. So what is
container-independent is detection of outright decode failure — not detection of silent truncation.
**MP4 chunk recovery remains unverified**: the harness is Playwright Chromium, so a passing test proves
WebM only.

**Recovery** — at startup, in a tab that can take `CAPTURE_LOCK`:

For each row in `recording` (nothing else holds the lock, so none is live):

- If it has chunks that merge and decode → **insert a NEW row**, `queued`, with that audio, carrying the
  original's `recording` metadata and a fresh id. Then mark the original `dead` with a reason naming its
  successor.
- If its chunks cannot be decoded even after dropping the last one → leave it `dead` with
  `lastError` set and **its chunks intact**. Never write audio that does not decode; never silently
  discard bytes.

The new row goes through the ordinary pipeline, having been created the way every other row is created.
There is no half-recovered state to reason about, because recovery either produces a complete row or
produces nothing and says so.

**Then call `syncNow()`** — the relay drains only on `syncNow()`, startup, or a connectivity edge.

## 5. Reporting

- **`workSafety` keeps `protected` during healthy recording**, with a distinct reason naming the
  unflushed tail. A warning that fires on every recording is noise that teaches the user to ignore the
  one time it matters. It downgrades to `at-risk` when persistence **actually falls behind** — a failed
  chunk write, or no `dataavailable` past a threshold. That signal must be plumbed from the capture
  session, because `summarizeWork` sees only `status` today.
- **`audioReady` / `audioBytes`** are already implemented: `audioReady` is attachment presence,
  `audioBytes` sums chunks while recording. One gap remains untested until this design lands — a
  `recording` row carrying chunks — because no public API can build one yet.

## 6. What this costs

An interrupted recording is a **visible orphan**: a `dead` row the operator sees and, if recovery
succeeded, a `queued` successor beside it. Nothing is repaired invisibly.

That is a deliberate trade for deleting the fence, the pointer, the rotation and the revalidation
protocol — roughly two thirds of revision 8. For one auditor with one phone it is also the more honest
behaviour: the app says what happened rather than quietly reconstructing it.

## 7. Open questions

- **The emission-stall threshold** needs a real backgrounded device. Not guessable.
- **MP4 chunk recovery is unverified** and cannot be tested in this harness.
- **Multi-tab relay claiming** is a real pre-existing problem — `nextPending()` takes no claim, so two
  tabs drain the same item. Revision 8 adopted it; revision 9 hands it back. It deserves its own design.
