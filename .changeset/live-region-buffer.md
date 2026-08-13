---
"@azx/ribo-transcriber-ondevice": minor
---

Revision 7: the VAD stops deciding what gets transcribed.

Replace utterance segmentation with a region buffer that appends every frame
unconditionally — speech or silence, no frame is dropped before transcription.
Silero's probability drives only timing: a pause triggers a refresh (re-transcribe
the region, buffer does not advance), a long-enough pause or the region cap triggers
a commit (text becomes permanent, buffer advances past the committed audio).

New `RegionVad` class with `feed(frame): Promise<RegionFrameResult>` reporting
`refresh`, `commit`, and `committedSamples` per frame, plus a `samples` getter for
the current region and a `drain()` method for close-time extraction. The hysteresis
thresholds and recurrent-state handling carry over unchanged.

Deleted: the minimum-utterance hold, `flush()`'s role as a rescue for discarded
audio, the pre-speech FIFO, and the min-speech filter as an emission gate. The 250 ms
filter survives only to suppress transcribing a region with no speech at all, and
never removes audio from a region.

`StreamingVad` remains as a backward-compat wrapper over `RegionVad` so `worker.ts`
compiles unchanged; Task 2 will wire `RegionVad` in directly.
