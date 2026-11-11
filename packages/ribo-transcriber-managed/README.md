# @azx/ribo-transcriber-managed

Managed speech transcription for Ribo — Azure AI Speech Fast Transcription, proxied through the
host's transport. It implements `@azx/ribo-core`'s `Transcriber` contract with engine id
`managed-azure-speech`, and composes through `firstCapable` or `hedgedTranscriber` alongside an on-device
engine.

## When to use it

Use it as the network-dependent fallback behind
[`@azx/ribo-transcriber-ondevice`](../ribo-transcriber-ondevice/README.md) — a device that fails the
on-device real-time-factor gate, or a build that ships no on-device model at all, still needs a
transcription path. **The package never holds a credential:** it takes an endpoint and an injected
`fetch`, and the host's transport attaches whatever credential it holds.

Skip it if you have no managed speech backend to point it at, or if on-device alone already meets
your latency and offline requirements.

## Composing it

```ts
import { ManagedTranscriber } from "@azx/ribo-transcriber-managed";

// The host supplies the endpoint and the transport. The transport attaches
// whatever credential the host holds — this package never sees it.
const transcriber = new ManagedTranscriber({
  endpoint: "https://myresource.cognitiveservices.azure.com",
  isOnline: () => navigator.onLine,
});
```

## Learn more

- Guide: [Captures & Sources](../../docs/guide/captures-and-sources.md)
- [Repo root](../../README.md)
