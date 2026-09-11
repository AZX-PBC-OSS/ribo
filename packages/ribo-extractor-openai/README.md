# @azx/ribo-extractor-openai

A tool-agnostic `Extractor` for Ribo: single-shot managed-LLM extraction over a `ChatClient`
transport, plus a per-group strategy (`perGroupExtractor`) that partitions a schema too big for one
model call across concurrent calls. It works against any `ExtractionTarget<V>` — any adapter or test
target wires the same extractor — so it depends on no adapter.

## When to reach for it

Reach for it as the managed-LLM extraction strategy behind any `ToolAdapter`: `singleShotExtractor`
for a schema that fits one call, `perGroupExtractor` + `instanceLadder` once it doesn't. `openAiChat`
gives you an OpenAI-compatible transport; `helixChat` gives you the Helix platform's own LLM route
instead — that route is **not** OpenAI-compatible, despite living in this same package.

Skip it if you're extracting on-device — see [`@azx/ribo-extractor-ondevice`](../ribo-extractor-ondevice/README.md),
which depends on this package only for the shared `ChatClient` transport types, not for a chat
transport itself.

## Composing it

```ts
import { toSessionExtractStep } from "@azx/ribo-core";
import { openAiChat, singleShotExtractor } from "@azx/ribo-extractor-openai";

// `target` is any adapter's `ExtractionTarget` slice — here, a placeholder for whichever
// `ToolAdapter` package this host writes into (e.g. `@azx/ribo-adapter-snuggpro`, as an example).
const extractor = singleShotExtractor({
  target: hostAdapter,
  chat: openAiChat({ apiKey: process.env.OPENAI_API_KEY!, baseUrl: "https://api.openai.com/v1" }),
  model: "gpt-4o-2024-08-06",
});

const sessionExtract = toSessionExtractStep(extractor);
```

## Learn more

- Guide: [Extraction](../../docs/guide/extraction.md)
- [Repo root](../../README.md)
