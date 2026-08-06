# @azx/ribo-extractor-openai

A **tool-agnostic** extractor plasmid for Ribo: single-shot managed-LLM extraction over an
OpenAI-compatible chat-completions endpoint. It implements `@azx/ribo-core`'s `Extractor` seam and
works against **any** `ExtractionTarget<V>` — the SnuggPro adapter, a future adapter, or a test target
all wire the same extractor — so it lives outside every tool adapter and depends on **no** adapter.

One structured-output chat call turns a transcript into `Enveloped<V>`: it assembles the prompt from
the target (instructions as the system message, few-shot `examples` as user/assistant turns, then the
transcript), pins the output to the target's `extractionSchema` with `strict: true` via
`z.toJSONSchema`, then crosses the trust boundary — parse the response with that same
`extractionSchema`, then run an optional deterministic `normalize` pass — before it becomes field data.

**Enveloped, not plain values, and the type says so.** The type parameter is `V` — the adapter's
writable field type — because that is what names a target. But every one of the four things this
extractor does with fields (constrain the model, parse the response, imitate the example assistant
turns, normalize) is the provenance-enveloped shape the model actually emits. The plain `V` only
exists after a human review, which is a later step and a different contract. Saying `Extractor<V>`
here would be a signature that claims something untrue.

## Installation

```bash
pnpm add @azx/ribo-extractor-openai @azx/ribo-core
```

> Not yet published to a public registry — in this workspace it is consumed as a `workspace:` dependency.

## Public API at a glance

- **`singleShotExtractor`** — builds an `Extractor<Enveloped<V>>` for an `ExtractionTarget<V>` over an
  injected `ChatClient`. Options: `target`, `chat`, `model`, and an optional `normalize`
  (`SingleShotOptions`), which consumes and returns `Enveloped<V>` because it runs on the model's
  output, before review.
- **`openAiChat`** — a concrete `ChatClient` over an OpenAI-compatible `/chat/completions` endpoint.
  Everything is injected: `apiKey`, `baseUrl`, and (for tests) `fetchImpl` (`OpenAiChatOptions`). No
  secret is hardcoded; `fetch` is used as the bare global. HTTP errors carry a `status` so the queue's
  `isTransientFailure` can classify 5xx/429/408 as retryable and other 4xx as terminal.
- **The transport seam** — `ChatClient`, `ChatRequest`, `ChatMessage`, `ChatResponseFormat`,
  `ChatCompletion`, `ChatRole`. Implement `ChatClient` yourself for a custom transport.

## Minimal example

```ts
import { singleShotExtractor, openAiChat } from "@azx/ribo-extractor-openai";
import { toExtractStep } from "@azx/ribo-core";
import { snuggProAdapter, normalizeFields } from "@azx/ribo-adapter-snuggpro";

// A single-shot extractor over an OpenAI-compatible chat endpoint, described by any adapter/target.
const extractor = singleShotExtractor({
  target: snuggProAdapter,
  chat: openAiChat({ apiKey: process.env.OPENAI_API_KEY!, baseUrl: "https://api.openai.com/v1" }),
  model: "gpt-4o-2024-08-06",
  normalize: normalizeFields, // the deterministic pass — the second half of the trust boundary
});

// Collapse it onto the relay's injected extraction step.
const extractStep = toExtractStep(extractor);
```

## Headless

This package is **headless** (AGENTS §4): no React, no DOM rendering. `fetch` is expressly allowed and
used as the bare global. Its dependency on `@azx/ribo-core` is **type-only** (`ExtractionTarget`,
`Extractor`, `ExtractionResult`), so it is a `devDependency`, not a runtime dependency; `zod` is a
runtime dependency (it builds the strict JSON Schema).

See the [API Reference](../../docs/reference/) (generated) for the full surface.
