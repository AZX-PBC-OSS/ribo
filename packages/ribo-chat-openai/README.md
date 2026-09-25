# @azx/ribo-chat-openai

The OpenAI-compatible chat transport for Ribo: `openAiChat` implements `@azx/ribo-core`'s
`ChatClient` seam over a `/chat/completions` endpoint. Point it at OpenAI proper, Azure
Foundry, or a proxy that speaks the same dialect.

It is a dialect package (ADR 0020): everything above the transport — `singleShotExtractor`,
`perGroupExtractor`, the schema split, the phases — lives in `@azx/ribo-core` and speaks the
seam, so this package exists to name the dialect and nothing else (ADR 0027).

Everything is injected — the key, the base URL, and (for tests) the `fetch` implementation.
No secret is hardcoded, and the package has no capacity to authenticate on a consumer's
behalf: the credential lives in the host's transport.

## Composing it

```ts
import { singleShotExtractor } from "@azx/ribo-core";
import { openAiChat } from "@azx/ribo-chat-openai";

const chat = openAiChat({
  apiKey: process.env.OPENAI_API_KEY!,
  baseUrl: "https://api.openai.com/v1",
});
const extractor = singleShotExtractor({ target, chat, model: "gpt-4o-2024-08-06" });
```

## Learn more

- Guide: [Extraction](../../docs/guide/extraction.md)
- [Repo root](../../README.md)
