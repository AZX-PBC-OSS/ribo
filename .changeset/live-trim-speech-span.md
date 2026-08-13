---
"@azx/ribo-transcriber-ondevice": patch
---

Trim the live region to its speech span before transcribing.

The live path used to hand the model the whole clock-bounded region — every frame
since the last commit — including the silence or room noise at its edges. The batch
path never does this: `planVadChunks` cuts to speech boundaries and pads by 200 ms.
Field testing showed ~70 % of live transcriptions on a hesitant, stop-start recording
returned empty text, while a continuous recording produced text every time. The
surviving hypothesis is that regions dominated by real microphone room noise transcribe
to nothing, and that noise is exactly what batch trims away.

`RegionVad` now tracks the first and last frame that entered speech and exposes a
trimmed `transcriptionSamples` on commit and a `speechSpanSamples()` method for the
refresh path. The trim reuses the per-frame speech decisions the VAD already makes —
no second detector — and applies the same 200 ms padding the batch path uses. Internal
pauses between speech segments are preserved; only leading and trailing non-speech is
removed. The region buffer's own semantics are unchanged: it still holds every frame
contiguously, and a commit still advances past exactly the audio that was committed.

A region with no speech at all now produces no transcription call —
`transcriptionSamples` is null and `drain` returns empty — rather than sending noise
to the model.
