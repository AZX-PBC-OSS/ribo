---
"@azx/ribo-extractor-openai": minor
---

Teach `splitExtractionSchema` to detect top-level groups wrapped in `z.array()`.

A collection group arrives as a `ZodArray` whose element is a group object of
enveloped leaves. The split now unwraps the array element when deciding whether a
top-level property is a group, and still produces one per-group schema per key.
The per-group schema preserves the `ZodArray` wrapper so the response shape
matches the final answer and merging stays a shallow `Object.assign`.

Non-grouped schemas — including a top-level array of envelopes, a flat object of
envelopes, a non-object schema, or an empty object — continue to fall back to a
single entry covering the whole schema.
