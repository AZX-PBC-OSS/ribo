---
"@azx/ribo-extractor-openai": minor
---

**The derived extraction shape: apply explicit shape operations to a plain zod schema, and get the
extraction schema plus the mapping back.** `deriveExtractionShape(schema, { operations, provenance,
requiredOnCreate, identifyingFields })` normalizes the caller's schema into patch form, applies the
operations — `drop` (scoping), `retype` (the closed string→number kind change, with the pinned
`String`/`Number` canonical pair), and `regroup` (re-nesting within a top-level key, which never
crosses a group boundary and never touches an array) — and returns the artifact pair: the enveloped
`extractionSchema` for `schemaExtractor`'s `extractionSchema` passthrough, and the `mapping` back as
data (a path map plus transforms from a closed, invertible set — cacheable, persistable, diffable).
The derived **patch** comes with it: the caller's schema in patch form, drops removed, which review
walks and the write parses against.

**`reshapedExtractor` is the reversal combinator** — `Extractor` over the extraction shape →
`Extractor` over the derived patch — validating the mapping against both schemas at construction and
parsing its own output against the derived patch's enveloped shape before it becomes field data.
Reversal carries `confidence` and `sourceSpan` through every regroup and retype (a reversal that
dropped them would collapse every review card to a sentinel), lands row spans back on the patch's
rows at every row unit including nested-array elements, and keeps an emptied collection's key present
(`hvac: []` is an answer, not an omission).

The refusals are at derivation, naming the path: scalar arrays, unions and records (which review and
`enveloped()` reject later and worse), a retype whose source kind is outside the closed set, a move
crossing a collection boundary or resurrecting a dropped path, ambiguous operation sequences
(duplicate retype/regroup/drop, overlapping or prefixing moves), a drop that empties an object, and
declarations naming a leaf the operations removed.

Also exported: `reverseShapedFields` (the pure reversal, for hosts composing their own seams) and
`generateShapedValue` (the deterministic extraction-space value walker the reverse-direction
round-trip property runs on — no generator exists in this repo, so the walker is hand-rolled and
exhaustive over kinds, with the retype's canonical-encoding edges covered by running the property
once per member of a small number pool).
