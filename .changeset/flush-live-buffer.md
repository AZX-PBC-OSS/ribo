---
"@azx/ribo-transcriber-ondevice": patch
---

Flush buffered speech when a live session closes, so the last sentence is not silently dropped.

The VAD emits an utterance only when trailing silence closes a region. When a recording
ended mid-speech, the still-open buffer was discarded — no flush. Measured on the 54-second
test fixture: the live path produced 85 words covering the first 30 seconds and lost the
remaining 24, because the VAD emitted once (hitting the 30 s cap) and never closed again
— continuous dictation never gave it 800 ms of silence.

- `StreamingVad` gains a `flush()` method that emits any buffered speech as one utterance
  when the session closes. It covers both places audio can be held: the in-speech buffer
  (a region that never saw a closing silence) and the held-short buffer (a close below the
  minimum-utterance threshold that was kept for the next region to merge into — on flush
  there is no next region). The min-speech noise filter still applies (a cough is not worth
  transcribing); the minimum-utterance rule does not (transcribe-it-or-lose-it, and losing
  the last sentence is worse than a fragmentary transcription the batch pass replaces
  anyway).
- The worker's `liveClose` handler now flushes the VAD, transcribes the result, and posts
  the segment before the session goes away — rather than just deleting the session.
- `OnDeviceLiveSession`'s message listener no longer drops segments after `close()`. The
  `#closed` flag still prevents further `feed()` calls, but the flush segment arrives
  after close and must reach the subscriber. A late feed segment (mid-inference when close
  arrived) is also forwarded — it is real speech, and dropping it would lose data.
