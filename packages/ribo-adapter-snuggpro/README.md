# @azx/ribo-adapter-snuggpro

The `ToolAdapter` for Snugg Pro, a home-energy-audit tool: the field schema shaped to its wire
property names, the extractor instructions and few-shot examples, a deterministic normalization
pass, and the write-back seam. It is Ribo's **reference adapter** — the only tool-specific surface
in the workspace, and the worked example every other adapter is built by analogy to.

## When to reach for it

Reach for it if you're actually integrating with Snugg Pro, or if you want a real, complete
`ToolAdapter` to read before writing your own for a different host tool — it's the fullest worked
example of the seam.

Skip it for any other host tool: write your own `ToolAdapter` package instead. No Snugg Pro field
name or quirk is meant to leak into `@azx/ribo-core` or `@azx/ribo-ui-react`, and none does.

## Composing it

```ts
import { toSessionExtractStep } from "@azx/ribo-core";
import { normalizeFields, snuggProAdapter } from "@azx/ribo-adapter-snuggpro";
import { openAiChat, singleShotExtractor } from "@azx/ribo-extractor-openai";

// Any Extractor can target this adapter — it only needs `name`, `extractionSchema`,
// `instructions`, and `examples` (the `ExtractionTarget` slice of `ToolAdapter`).
const extractor = singleShotExtractor({
  target: snuggProAdapter,
  chat: openAiChat({ apiKey: process.env.OPENAI_API_KEY!, baseUrl: "https://api.openai.com/v1" }),
  model: "gpt-4o-2024-08-06",
  normalize: normalizeFields, // the deterministic pass — the second half of the trust boundary
});

const sessionExtract = toSessionExtractStep(extractor);
```

## Learn more

- Guide: [Write-back](../../docs/guide/write-back.md)
- [Repo root](../../README.md)
