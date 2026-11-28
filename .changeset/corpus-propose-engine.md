---
"@azx/ribo-cli": patch
---

The corpus gains its proposal engine and its collection-path walk. `proposeCase` asks a model,
over an injected chat transport, for one case's unanswered answers and returns pending
expectation entries: the model speaks a flat, code-owned proposal language (scalar items and
collection rows — deliberately not the enveloped extraction schema, so the response format's
depth and size never depend on the user's schema), code validates every item against the leaf
inventory and grounds every quote against each input under the one rule `schema-init/validate.ts`
applies, recording the earliest declared input whose own rule matches — the input name is always
derived, never taken from the model. Collection cells pivot to the ordinal-keyed, leaf-major
shape the scorer reads, with a leaf missing from one row omitting that ordinal and an empty
collection a proposed absence. One bounded repair round answers an unparseable reply; after it
a still-unparseable reply fails that case alone, while item-level problems drop their leaf into
the result's unproposed list with a reason instead. `walkCollectionPaths` walks the corpus's zod
schema and returns, for every leaf, the path of its nearest array ancestor (absent for a scalar
leaf) — the one CLI-side answer to "which collection is this leaf under?", reused by the review
sheet. The new exports are on the package's public surface.
