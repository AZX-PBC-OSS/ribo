# @azx/ribo-extractor-openai

A **tool-agnostic** extractor plasmid for Ribo: single-shot managed-LLM extraction over an
OpenAI-compatible chat-completions endpoint. It implements `@azx/ribo-core`'s `Extractor<F>` seam and
works against **any** `ExtractionTarget<F>` — the SnuggPro adapter, a future adapter, or a test target
all wire the same extractor — so it lives outside every tool adapter and depends on **no** adapter.

One structured-output chat call turns a transcript into `F`: it assembles the prompt from the target
(instructions as the system message, few-shot `examples` as user/assistant turns, then the transcript),
pins the output to the target schema with `strict: true` via `z.toJSONSchema`, then crosses the trust
boundary — parse the response with the target's own `schema`, then run an optional deterministic
`normalize` pass — before it becomes field data.

## Installation

```bash
pnpm add @azx/ribo-extractor-openai @azx/ribo-core
```

> Not yet published to a public registry — in this workspace it is consumed as a `workspace:` dependency.

## Public API at a glance

- **`singleShotExtractor`** — builds an `Extractor<F>` for an `ExtractionTarget<F>` over an injected
  `ChatClient`. Options: `target`, `chat`, `model`, and an optional `normalize` (`SingleShotOptions`).
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
