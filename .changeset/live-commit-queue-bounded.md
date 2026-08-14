---
"@azx/ribo-transcriber-ondevice": patch
---

Bound the live ASR commit queue by coalescing queued commits.

`serialize` is a single unbounded promise chain. Refresh transcriptions
are load-shed when one is in flight (`refreshInFlight`), but commits
were never shed — each enqueued a closure capturing its region's
`Float32Array` and waited behind every earlier one. On a slow device a
15–30 s region takes 5–10 s to transcribe, while continuous dictation
produces a commit every 15–30 s. The backlog compounded and the newest
commit waited for the sum of all earlier durations. A ~10 s preview lag
was observed in the field.

The fix bounds the queue at **one in-flight commit transcription + one
coalesced pending buffer**. When a commit arrives while
`commitInFlight` is `true`, its samples are merged into
`pendingCommitSamples` instead of enqueuing a separate `serialize` call.
The in-flight transcription drains `pendingCommitSamples` before it
starts (merging anything that arrived while it was queued) and re-queues
itself after it finishes if more commits arrived while it was running.

**What the user loses:** individual commit boundaries. Two regions that
would have been separate commit segments become one larger segment whose
text is the transcription of their concatenated audio. Consecutive
regions are contiguous audio, so transcribing them together is
equivalent to transcribing each separately — no text is lost. The user
would know coalescing is happening because commit segments arrive less
frequently and contain more text per segment during sustained dictation
on a slow device.

**Why this beats the alternatives:** shedding commits like refreshes
would silently lose real text (a bug this feature has produced four
times). Back-pressuring the producer would block the VAD feed, which
could lose audio — the exact failure this revision exists to eliminate.
A cap that surfaces `liveError` when exceeded would make the loss
visible, but the text would still be lost.
