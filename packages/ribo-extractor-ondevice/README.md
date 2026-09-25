# @azx/ribo-extractor-ondevice

On-device extraction for Ribo. It runs three phases — presence, verbatim span, then classify — over
Chrome's built-in Language Model, implementing Ribo's `Extractor` contract as a `CapableChatClient`
so it composes with a managed strategy through `compositeExtractor` or `fallbackExtractor`.

## When to use it

Use it as a fallback engine when the managed extractor is unreachable — no network, or a deployment
that wants to degrade to on-device rather than fail. It's a weaker model than a frontier managed
one, so `ribo-core`'s extraction-side composite prefers managed first and accepts on-device only
when the managed path can't run.

Skip it if your deployment has reliable managed-model access; use
[`@azx/ribo-chat-openai`](../ribo-chat-openai/README.md) alone instead. It borrows only
the `ChatClient` types from `@azx/ribo-core`, not the transports.

## Composing it

```ts
import { acceptAnySuccess, fallbackExtractor, singleShotExtractor } from "@azx/ribo-core";
import { openAiChat } from "@azx/ribo-chat-openai";
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
