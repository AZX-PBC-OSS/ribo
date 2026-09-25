---
"@azx/ribo-core": minor
---

The runtime walk over enveloped extraction results is now public in `@azx/ribo-core`, and a
construction-time guard refuses targets the judging combinators cannot serve.

`mapExtractedLeaves` (with `isExtractedLeaf` and the `LeafPath` type) moves out of
`gapFillExtractor`, where it was module-private. It is the codebase's one generic RUNTIME walk over
`Enveloped<V>` data, as a structure-preserving map over the leaf envelopes: `fn` sees every leaf
with its structured path, and a subtree keeps its reference when nothing under it changed. A host
writing their own combinator over extraction results no longer has to rewrite it — and the
identity-preservation property it carries is easy to lose in a rewrite, which is why it moves rather
than gets re-derived. `@azx/ribo-extractor-openai` now imports the walk from core; its behaviour is
unchanged, and its gap-fill suite passes unmodified.

`assertLeafGranularity(schema, { combinator })` throws at construction when a target's
`extractionSchema` declares a group derived at `"row"` or `"none"` provenance granularity, naming
the combinator, the group, and which granularity that group appears to be. It exists for the
combinators that judge a result by walking per-leaf envelopes: a `"row"` group is plain values plus
one row-level span and a `"none"` group has no span at all, so a walk that identifies leaves by
their envelope passes both straight through — comparing nothing and counting nothing while
returning a result that looks judged, exactly where per-cell citations were measured 37% fabricated.
The check is a recursive predicate rather than an unwrap-then-check, because `enveloped()` derives
an array of primitives to an array of envelopes — a one-level version rejects legitimate `"leaf"`
schemas the reference adapter never produces.
