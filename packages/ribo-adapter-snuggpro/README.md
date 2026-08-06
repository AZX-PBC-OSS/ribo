# @azx/ribo-adapter-snuggpro

The **only tool-specific surface** in the Ribo workspace: how Snugg Pro's bounded audit pilot fields are
shaped, how to describe them to an extractor, the deterministic pass that runs after the model, and the
write-back seam. It is a `ToolAdapter` — a second host tool would be a new adapter package and nothing
else. No Snugg Pro field names or quirks leak into `ribo-core` or `ribo-ui-react`.

Write-back is **scaffolded, not yet wired**: the `write` seam and the adapter exist, but the live Snugg
Pro write is gated on a platform ask.

## Installation

```bash
pnpm add @azx/ribo-adapter-snuggpro @azx/ribo-core
```

> Not yet published to a public registry — in this workspace it is consumed as a `workspace:` dependency.

## Public API at a glance

- **The adapter** — `snuggProAdapter` (a `ToolAdapter`), `SNUGGPRO_ADAPTER_NAME`.
- **The field schemas — two of them, one derived from the other.** `snuggValuesSchema` (type
  `SnuggValues`) is the hand-written **writable patch**: what a review produces and what `write`
  sends, with every leaf optional (absent = the reviewer rejected it, leave it alone) and nullable
  (a present `null` = write it empty). `snuggExtractionSchema` (type `SnuggExtraction`) is what the
  **model** is asked for, derived from the patch with `ribo-core`'s `enveloped()` — every leaf
  wrapped in a provenance envelope, closed and fully required. Plus the enums both are built from
  (`HeatingEquipmentType`, `HeatingFuel`, `DhwSystemType`, `AtticInsulationDepthBand`,
  `HealthSafetyMatrix`, and the rest).
- **The write context** — `snuggCtxSchema` and the `SnuggWriteContext` inferred from it (the real
  `C` the adapter's `write` needs, parsed rather than merely typed because it comes back out of
  storage).
- **Extraction inputs** — `snuggProInstructions` (normalization intent) and `snuggExamples` (few-shot).
- **The deterministic pass** — `normalizeFields`, `clampConfidence`, `inchesToAtticDepthBand`,
  `yearsToDhwAgeBand`.

The extractor is **not** here: `singleShotExtractor` (single-shot managed LLM), its transport
`openAiChat`, and the `ChatClient` seam are tool-agnostic and live in
[`@azx/ribo-extractor-openai`](../ribo-extractor-openai/README.md). Compose them with `snuggProAdapter`
as the extraction target (see the example below).

## Minimal example

```ts
import { snuggProAdapter, normalizeFields } from "@azx/ribo-adapter-snuggpro";
import { singleShotExtractor, openAiChat } from "@azx/ribo-extractor-openai";
import { toExtractStep } from "@azx/ribo-core";

// A single-shot extractor over an OpenAI-compatible chat endpoint, targeting the SnuggPro adapter.
const extractor = singleShotExtractor({
  target: snuggProAdapter,
  chat: openAiChat({ apiKey: process.env.OPENAI_API_KEY!, baseUrl: "https://api.openai.com/v1" }),
  model: "gpt-4o-2024-08-06",
  normalize: normalizeFields, // the deterministic pass — the second half of the trust boundary
});

// Collapse it onto the relay's injected extraction step.
const extractStep = toExtractStep(extractor);
```

See the [API Reference](../../docs/reference/) (generated) for the full surface.
