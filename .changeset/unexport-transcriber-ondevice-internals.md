---
"@azx/ribo-transcriber-ondevice": minor
---

Trim both entry points to their real public surface.

The root barrel drops `ONDEVICE_WHISPER_ENGINE` (the deprecated, superseded engine constant), the engine-id helpers `ONDEVICE_ENGINE_PREFIX`, `ondeviceEngineId`, `shortModelName` and the `EngineIdentity` type, the download byte table `MODEL_DOWNLOAD_BYTES`, `VAD_MODEL_ID`, `VAD_DOWNLOAD_BYTES`, `STREAMING_VAD_MODEL_ID` and `STREAMING_VAD_DOWNLOAD_BYTES`, the hint prompt builder `buildHintPrompt`, and the RTF verdict cache plumbing `RTF_VERDICT_CACHE_NAME`, `readRtfVerdict` and `writeRtfVerdict`. `isModelCached`, `estimateDownloadBytes`, `DEFAULT_RTF_THRESHOLD`, every transcriber class, and the options and result types their signatures name stay public.

The `./worker` subpath now exports only `handleMessage` and the `TranscribeWorkerRequest` type; the segmentation, progress-normalising and session-bookkeeping helpers (`WORKER_ENTRY_NAME`, `normalizeProgress`, `planChunks`, `serialize`, `clearCancelledTranscribes`, `clearLiveSessions`, `injectLiveSession`, `processPendingClose`) moved to an internal module that is not published.
