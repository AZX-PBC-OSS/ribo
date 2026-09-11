# @azx/ribo-transcriber-managed

A managed transcription plasmid for Ribo: Azure AI Speech Fast Transcription, proxied through the
host's transport. It implements `@azx/ribo-core`'s `Transcriber` seam with engine id
`managed-azure-speech`, and composes through `firstCapable` or `hedged` alongside an on-device engine
with no queue changes.

## When to reach for it

Reach for it as the network-dependent fallback behind
[`@azx/ribo-transcriber-ondevice`](../ribo-transcriber-ondevice/README.md) — a device that fails the
on-device real-time-factor gate, or a build that ships no on-device model at all, still needs a
transcription path. **The package has no capacity to authenticate** by design: it takes an endpoint
and an injected `fetch`, so the credential lives in the host's transport and is never held here.

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
