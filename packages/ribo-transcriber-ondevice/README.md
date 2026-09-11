# @azx/ribo-transcriber-ondevice

On-device Whisper, implementing `@azx/ribo-core`'s `Transcriber` so it's substitutable for any other
engine and composes through `firstCapable`/`hedged` with no queue changes. Inference runs in a Web
Worker via `@huggingface/transformers`; the model downloads once (explicitly, user-initiated) and is
cached for offline use.

## When to reach for it

Reach for it as the free, private, offline-capable transcription engine — `capability()` measures
the device's real-time factor at `prime()` time and reports `too-slow` on hardware that can't keep
up, so a caller can fall back rather than guess.

Skip it, or pair it with [`@azx/ribo-transcriber-managed`](../ribo-transcriber-managed/README.md) as
a fallback, when the device fails that gate — and skip it outright on iOS, which is out of scope for
on-device today. It's also a separate package from `@azx/ribo-core` on purpose:
`@huggingface/transformers` pulls `onnxruntime-node` and `sharp` as hard dependencies with
postinstall scripts, a cost no non-transcribing consumer should inherit.

## Composing it

```ts
import { firstCapable } from "@azx/ribo-core";
import { ManagedTranscriber } from "@azx/ribo-transcriber-managed";
import { OnDeviceTranscriber } from "@azx/ribo-transcriber-ondevice";

const onDevice = new OnDeviceTranscriber({
  wasmPaths: "/ort/", // same-origin ONNX Runtime files
  createWorker: () =>
    new Worker(new URL("@azx/ribo-transcriber-ondevice/worker", import.meta.url), {
      type: "module",
    }),
});

await onDevice.prime((progress) => console.log(progress)); // user-initiated download

// On-device first — it's free and private — falling back to managed speech when
// `capability()` reports `too-slow` or the model isn't primed yet.
const transcriber = firstCapable([onDevice, new ManagedTranscriber({ endpoint: managedEndpoint })]);
```

## Learn more

- Guide: [Captures & Sources](../../docs/guide/captures-and-sources.md)
- [Repo root](../../README.md)
