---
"@azx/ribo-transcriber-ondevice": patch
---

Cap the coalesced commit buffer at the model's 30s input window.

The commit-queue coalescing fix bounded queue **depth** (at most one
in-flight commit + one pending buffer) but not buffer **size**:
`pendingCommitSamples` grows by unbounded concatenation, so on a slow
device with sustained dictation three backed-up 30s regions become a
single 90s transcription call. That exceeds the model's supported input
window — Moonshine's reference caps at 30s (`MAX_BUFFER_DURATION = 30`)
and `WHISPER_WINDOW_SECONDS` is 30 for the same reason. The previous
code never sent more than one region (30s), so this risk is new.

`transcribeBounded` reuses the batch path's `planFallbackChunks` — the
same fixed-window march `transcribe` falls back to when VAD is
unavailable — to split the coalesced buffer into overlapping 30s
windows, transcribing each separately and joining the text. No audio's
text is dropped. The 10s overlap duplicates some words at chunk
boundaries: the safe direction (a repeated phrase is harmless, a
deleted one is not), and the live preview is provisional — the batch
pass after `stop()` produces the final transcript without duplication.
