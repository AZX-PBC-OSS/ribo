# @azx/ribo-core

The headless engine at the center of Ribo: the durable offline queue and its two state machines,
the `Transcriber` / `Extractor` / `ToolAdapter` seam contracts every other package implements, and
the provenance and review vocabulary that ties them together — with no React and no DOM rendering.

## When to reach for it

Reach for it directly when you're wiring the queue and relay yourself, writing a new `Transcriber`,
`Extractor`, or `ToolAdapter` package, or driving the pipeline in a test with no model and no
network (`FakeTranscriber`, `FakeExtractor`). Every other Ribo package depends on it — you get it
either way.

Reach for [`@azx/ribo-ui-react`](../ribo-ui-react/README.md) instead if you're building a React app
and want the state machine already wired into hooks; you'll rarely import from `ribo-core` directly
in that case, though it stays a peer dependency underneath.

## Composing it

```ts
import {
  createRelay,
  FakeExtractor,
  FakeTranscriber,
  openOutbox,
  toSessionExtractStep,
} from "@azx/ribo-core";

// The durable queue: every capture lands here the instant it's made, online or not.
const outbox = await openOutbox();

// The relay drains the queue whenever connectivity allows. Swap the fakes below for a real
// Transcriber package and a real ToolAdapter's `toWriteStep(adapter)` with no change to this shape.
const relay = createRelay({
  outbox,
  transcriber: new FakeTranscriber(),
  sessionExtract: toSessionExtractStep(new FakeExtractor({})),
  sessionWrite: async () => ({}),
});

await relay.start();
```

## Learn more

- Guide: [Offline & the Outbox](../../docs/guide/offline-and-the-outbox.md)
- [Repo root](../../README.md)
