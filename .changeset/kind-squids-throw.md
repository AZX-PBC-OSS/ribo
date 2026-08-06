---
"@azx/ribo-core": minor
---

Review is now a gate in the outbox state machine, not a contract with no callers.

Extraction parks an item at a new `awaiting-review` status — deliberately held out of
`ACTIVE_OUTBOX_STATUSES`, so `nextPending()` never hands it to the relay and the next
recording drains straight past it. `Outbox.submitReview` is the only exit, applied through
`incrementalModify` so the status check and the mutation cannot be split by a second tab.
Accepted and edited outcomes move the item to `writing`; a discard is terminal, gets its own
`discarded` status distinct from `dead`, and drops the audio.

`WriteStepInput.extracted` is replaced by `reviewed`: the flat values `resolveReview` produces,
which is what `ToolAdapter.write(fields, ctx)` wants. Passing the model's raw envelopes would
have made a reviewer's corrections invisible at write time. A write with no usable review
outcome fails terminally rather than writing.

`summarizeWork` counts `awaiting-review` items as pending and exposes an informational
`awaitingReview` count on `WorkOnDevice`. Without this a device holding only un-reviewed
recordings reported `pending: 0`, and `workSafety` answered `safe` over work it had not looked
at.

`Recorder` gains `pause()` and `resume()`. Duration accumulates across run-segments, so a
paused span no longer inflates `Recording.durationMs`, and `level` reads zero while paused.
Pause cannot release the microphone — `MediaRecorder.resume()` requires the same stream — so
the browser's recording indicator stays lit, which is documented rather than surprising.

**Breaking:** `ReviewPresenter` is removed. It had no implementations and no callers, and its
`present(request) => Promise<ReviewSubmission>` shape described the design this replaces: a
relay awaiting a human stalls the serial queue behind one un-reviewed recording, and a reload
mid-await drops the promise. The outbox schema moves to version 1 with a migration.

**Also breaking, and narrowed on purpose:** `seq` no longer means "capture order is write
order". Writes follow review order once the recordings ahead of an item have parked, finished
or died. Enforcing capture order would let one un-reviewed recording block every write behind
it.
