---
"@azx/ribo-extractor-openai": minor
---

Add `splitExtractionSchema` — the pure, model-free half of R3 (per-group
extraction).

Given a target's `extractionSchema`, returns the list of top-level groups,
each with a schema containing exactly that one key. The group list is derived
from the schema's own top-level properties — no adapter change, no hard-coded
group names — so this works for any adapter. A non-grouped schema (a flat
enveloped schema whose top-level properties are leaf envelopes, a non-object
schema, or an empty object) yields a single entry covering the whole schema:
today's behaviour, and the fallback rather than an error.

Each per-group schema is a `z.strictObject({ [key]: groupSchema })` — shaped
like the final answer with one top-level key — so Task 2's per-group extractor
merges responses by shallow `Object.assign` rather than re-keying.
