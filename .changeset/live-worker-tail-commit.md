---
"@azx/ribo-transcriber-ondevice": minor
---

Revision 7 Task 2: the worker transcribes regions and distinguishes tail from commit.

The worker now consumes `RegionVad` directly (Task 1's region buffer) instead of
the backward-compat `StreamingVad` wrapper, which is deleted along with the
`Utterance` interface. On a VAD **refresh**, the worker transcribes the whole
region buffer (`vad.samples`) and posts the text as a provisional **tail**. On a
**commit**, it transcribes `committedSamples` and posts the text as **committed**.
On session close, it drains the region and posts the remainder as a commit, so
the last region is never lost.

The `liveSegment` protocol message gains a `kind: "tail" | "commit"` discriminator
so the receiver can render and store provisional vs permanent text differently.
Task 4 carries this distinction through the `LiveSession` seam to hosts.

**Load shedding:** if a refresh comes due while a refresh transcription is already
in flight, the new refresh is skipped — not queued. The region buffer is untouched,
so the next refresh sees everything including audio that arrived during the skip.
A commit is never skipped. The VAD feed is deliberately not wrapped in `serialize`
so frames can be processed while a transcription is running; only the transcription
goes through `serialize` to chain with batch inference.

The existing error boundaries are preserved: a VAD failure is session-fatal (every
later frame would fail identically), while a transcription failure skips that one
region, posts `liveError`, and leaves the session alive.
