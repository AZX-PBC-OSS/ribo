---
"@azx/ribo-core": major
"@azx/ribo-ui-react": major
---

Audio becomes durable **during** capture, so a crash mid-recording no longer loses the whole thing.

`MediaRecorder` now runs with a timeslice and each `dataavailable` is written as its own RxDB
attachment. At `stop()` the chunks are merged, decode-verified, and committed as the canonical audio
while the row moves `recording → queued`. One recording at a time, enforced by a Web Lock. An
interrupted recording is recovered at startup into a **new** row; the original is marked `dead`
naming its successor, so nothing is repaired invisibly.

**What it does not protect, stated plainly:** on a backgrounded or screen-locked phone
`dataavailable` stops firing altogether, so nothing reaches disk for that period. The guarantee is
"each flushed chunk is safe", not a bounded window. It is still strictly better than before, where
any interruption lost everything.

Breaking changes:

- `OutboxStatus` gains `recording`. Consumers switching exhaustively will not compile until they
  handle it — deliberately, since the relay must never select a row whose audio is still arriving.
- `OutboxItem.hasAudio` is now `audioReady`, and `audioBytes` means durable bytes on disk, summing
  chunks while a recording is in progress.
- `Recorder.start()` acquires a capture lock and refuses when another tab holds it.
  `Capture` gains `itemId`, present when durable capture already committed the row — callers must
  not enqueue it again.
- `RecorderPhase` gains `failed`, and `RecorderState` gains `error`, so a mid-capture failure
  surfaces immediately instead of at `stop()`.
- `RiboInstances` gains an optional `captureCoordinator`. Absent, there is no durable capture and no
  capture health, and everything behaves as before.
- `workSafety` takes an optional capture-health argument and gains two reasons: `recording` on
  `protected`, and `capture-stalled` on `at-risk`. Existing levels and their precedence are
  unchanged.
