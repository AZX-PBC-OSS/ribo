# @azx/ribo-transcriber-ondevice

**On-device Whisper**, implementing `@azx/ribo-core`'s `Transcriber` so it is substitutable for any
other engine and composes through `firstCapable` with no queue changes. Inference runs in a Web Worker
via `@huggingface/transformers`; the model is downloaded once (explicitly, user-initiated) and cached
for offline use. This is a **separate package** from `ribo-core` on purpose:
`@huggingface/transformers` pulls `onnxruntime-node` and `sharp` as hard dependencies with postinstall
scripts — a cost no `ribo-core` consumer that never transcribes on-device should inherit.

Measured on clean authored audio, `whisper-base.en` (fp32, WASM) runs at **RTF ~0.16** (≈6× real time)
with **8.0 % WER**, and a warm start rebuilds the pipeline from cache — with no network — in **~0.8 s**.
These are a floor, not a field forecast. **iOS is out of scope** for on-device today (use the managed STT
path there).

## Installation

```bash
pnpm add @azx/ribo-transcriber-ondevice @azx/ribo-core
```

> Not yet published to a public registry — in this workspace it is consumed as a `workspace:` dependency.

## Public API at a glance

- **`OnDeviceTranscriber`** — the `Transcriber` implementation. `capability()` reads the Cache API to
  tell `needs-download` from `ready`; `prime(onProgress)` downloads and caches the model with visible
  progress; `transcribe(recording, audio)` decodes the `Blob` to 16 kHz mono PCM and runs Whisper.
- **Config** — `OnDeviceTranscriberOptions`, `TranscribeHints`, `DEFAULT_MODEL_ID`,
  `MODEL_DOWNLOAD_BYTES`, `estimateDownloadBytes`, `buildHintPrompt`.
- **Cache** — `TRANSFORMERS_CACHE_NAME`, `isModelCached`.
- **Engine id** — `ONDEVICE_WHISPER_ENGINE` (stamped onto every `Transcript`).
- **Worker protocol** — `PrimeConfig`, `PrimeProgress`, `TranscribeWorkerRequest`, `decodeTo16kMono`.

The worker ships as a **separate published entry** (`@azx/ribo-transcriber-ondevice/worker`) — the
consumer constructs it in their own build context (never `new Worker(...)` inside library code; see
`AGENTS.md` §5.2).

## Minimal example

```ts
import { OnDeviceTranscriber } from "@azx/ribo-transcriber-ondevice";

const transcriber = new OnDeviceTranscriber({
  wasmPaths: "/ort/", // same-origin ONNX Runtime files
  createWorker: () =>
    new Worker(new URL("@azx/ribo-transcriber-ondevice/worker", import.meta.url), {
      type: "module",
    }),
});

await transcriber.prime((progress) => console.log(progress)); // user-initiated download
const transcript = await transcriber.transcribe(recording, audio);
```

See the [API Reference](../../docs/reference/) (generated) for the full surface.
