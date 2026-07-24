# 05 — `@azx/ribo-adapter-snuggpro` (Snugg Pro Adapter)

The **only** tool-specific surface. Declarative: a field schema, extraction guidance, and a write function. Implements `ribo-core`'s `ToolAdapter<F>`. A new client (e.g. PSE) is a sibling package with its own values — core, UI, and transcription are reused untouched.

## Shape

```ts
export const snuggPro: ToolAdapter<SnuggFields> = {
  name: "snugg-pro",
  schema: SnuggFieldsSchema, // the bounded audit field set (rules below)
  instructions: "…domain guidance: energy-audit vocabulary, what counts as stated…",
  examples: [/* few-shot: real dictation → expected fields */],
  async write(fields, ctx) {
    await fetch(`/_api/fetch/https://api.snugg.pro/assessments/${(ctx as any).jobId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fields), // X-Api-Key injected server-side by egress
    });
  },
};
```

The adapter declares _what_ to extract and _how to talk about the domain_ — it does **not** declare an extraction strategy. The core runs a single schema-constrained call ([03](03-ribo-core.md)).

## Schema rules (driven by strict structured outputs)

Helix's OpenAI-compatible route supports `response_format` json_schema, and **strict mode requires every property to be present**. We turn that constraint into a quality feature:

- **Model "not mentioned" as `nullable` + required — never `optional`.** The model must explicitly emit `null` rather than silently omitting a field. This makes `null` a legitimate answer and removes most of the "the schema asked for a value, so I'll invent one" pressure — enforcing the anti-hallucination rule _at the schema level_ instead of by prompt-pleading.
- **Wrap each field so provenance is guaranteed:**
  ```ts
  const Extracted = <T extends z.ZodTypeAny>(v: T) =>
    z.object({
      value: v.nullable(), // null = not stated in the transcript
      confidence: z.number(), // 0..1, drives review-card flagging
      sourceSpan: z.string().nullable(), // the transcript quote justifying the value
    });
  ```
- **Keep schemas strict-mode compatible** (no top-level `.optional()`, avoid unsupported constructs).
- **Normalize in code, not in the prompt.** Extract what was _said_ ("R-eleven", "about 11"), then coerce units/enums/ranges deterministically in TypeScript.

## The three tool-specific pieces

1. **Field schema** — the **bounded** audit set for the pilot (not the whole assessment; a named scope lever). Exact set is an open decision.
2. **Extraction guidance** — `instructions` + few-shot `examples` using real energy-audit vocabulary (R-value, CFM25, AFUE, blower door). This is where domain accuracy comes from; tuned against the real-recording corpus ([07](07-testing-and-accuracy.md)).
3. **Write** — Snugg Pro's published API via the Helix fetch-proxy; the key is a connection secret ([06](06-field-app-helix.md)).

## Build-time action

Confirm the Snugg Pro API needs **no request header outside the fetch-proxy safelist** (`content-type`, `accept`, `user-agent`, `anthropic-version`, conditional headers). `cookie`/`authorization` are dropped by the proxy — the `X-Api-Key` injection recipe covers auth, but confirm the endpoint shape early. Write-mapping itself was already proven feasible via a prior internal hackathon.

## Size & open items

- **Size:** **S** once the field set + Snugg Pro API shape are confirmed.
- **Open:** the bounded field set; Snugg Pro assessment/patch endpoint shape and the `ctx` needed to target the right assessment (`jobId` above is a placeholder).
