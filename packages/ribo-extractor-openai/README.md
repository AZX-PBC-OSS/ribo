# @azx/ribo-extractor-openai

Managed-LLM extraction for Ribo: a single-shot strategy for a schema that fits one call, and a
per-group strategy (`perGroupExtractor`) that partitions a schema too big for one call across
concurrent calls. It implements the `Extractor` contract over a `ChatClient` transport and works
against any `ExtractionTarget<V>` — any adapter or test target — so it depends on no adapter.

## When to use it

Use it as the managed-LLM extraction strategy behind any `ToolAdapter`: `singleShotExtractor` for a
schema that fits one call, `perGroupExtractor` + `instanceLadder` once it doesn't. `openAiChat` gives
you an OpenAI-compatible transport; `helixChat` speaks the Helix platform's own LLM route, which —
despite the package name — is **not** OpenAI-compatible.

Skip it if you're extracting on-device — see [`@azx/ribo-extractor-ondevice`](../ribo-extractor-ondevice/README.md),
which borrows only this package's `ChatClient` transport types, not a chat transport itself.

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
