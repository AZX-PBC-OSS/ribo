# @azx/ribo-extractor-ondevice

An on-device `Extractor` for Ribo: three-phase extraction (presence, then verbatim span, then
classify) over Chrome's built-in Language Model, implemented as a `CapableChatClient` so it composes
through `compositeExtractor`/`fallbackExtractor` alongside a managed strategy with no queue changes.

## When to reach for it

Reach for it as a fallback engine when the managed extractor is unreachable — no network, or a
deployment that wants to degrade to on-device rather than fail outright. It's a genuinely weaker
model than a frontier managed one, so `ribo-core`'s extraction-side composite prefers managed first
and accepts on-device only when the managed path can't run at all.

Skip it if your deployment has reliable managed-model access; reach for
[`@azx/ribo-extractor-openai`](../ribo-extractor-openai/README.md) alone instead. This package
depends on that one for its `ChatClient` transport types (a declared exception to the otherwise
inward-only dependency rule, since a chat-shaped seam only needs describing once) — it does not use
`ribo-extractor-openai`'s transports themselves.

## Composing it

```ts
import { acceptAnySuccess, fallbackExtractor } from "@azx/ribo-core";
import { openAiChat, singleShotExtractor } from "@azx/ribo-extractor-openai";
import { OnDeviceChat, threePhaseExtractor } from "@azx/ribo-extractor-ondevice";

// `target` is any adapter's `ExtractionTarget` slice — a placeholder for whichever
// `ToolAdapter` package this host writes into.
const managed = singleShotExtractor({
  target: hostAdapter,
  chat: openAiChat({ apiKey: process.env.OPENAI_API_KEY!, baseUrl: "https://api.openai.com/v1" }),
  model: "gpt-4o-2024-08-06",
});

// `languageModel` is the host's own reference to Chrome's Prompt API global — this
// package never reaches for a global itself.
const onDevice = threePhaseExtractor({
  target: hostAdapter,
  chat: new OnDeviceChat({ languageModel: hostLanguageModel }),
});

// Managed first; on-device only when managed can't run at all — a deliberate
// degrade, so `acceptAnySuccess` rather than the conservative default.
const extractor = fallbackExtractor(
  [
    { strategy: "managed", extractor: managed },
    { strategy: "ondevice", extractor: onDevice },
  ],
  acceptAnySuccess,
);
```

## Learn more

- Guide: [Arbitration & Fallback](../../docs/guide/arbitration.md)
- [Repo root](../../README.md)
