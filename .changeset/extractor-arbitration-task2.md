---
"@azx/ribo-core": patch
---

Add the sequential extraction engine and `fallbackExtractor`.

`ExtractionResult["usage"]` now carries an optional `strategy` provenance field,
distinct from `engine`: `engine` is _which transport_, `strategy` is _which
approach_ inside it. The shared `createSequentialExtractor` engine owns candidate
iteration, verdict validation and result stamping with a caller-chosen key;
`fallbackExtractor` builds a strategy ladder with no admission gate and stamps
accepted results under `usage.strategy`. Both are exported from `ribo-core`.
