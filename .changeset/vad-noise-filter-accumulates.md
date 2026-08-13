---
"@azx/ribo-transcriber-ondevice": patch
---

Fix the streaming VAD silently discarding held speech when a short noise region follows.

`#speechFrameCount` — the counter behind the 250 ms min-speech noise filter — was reset per
region, while `#speechFrames` accumulated across holds. So the counter described only the
_most recent_ region, not the whole buffer. When a held sentence (real speech, just shorter
than the minimum utterance) was followed by a brief noise blip — a breath, a mic click, a
chair — the blip opened a region that closed with a count of 1, failed the noise filter, and
**emptied the entire accumulated buffer**. No emission, no error, no trace. Between every pair
of sentences this could repeat, and the user saw no live text at all for the whole recording.

The count now accumulates across a hold, matching `#speechFrames`: when a region opens onto a
held buffer the count is added to, not reset; when a close holds the buffer the count is
preserved, not zeroed. A region that is only noise (no held buffer behind it) is still
discarded — the filter is not defeated wholesale. The flush path needs no matching change: its
noise-filter check is guarded by `#inSpeech`, which is false when a buffer is held, so the
preserved count does not change the flush's behaviour.
