---
"@azx/ribo-cli": patch
---

`ribo eval` now unwraps recognised provenance envelopes in a loaded corpus schema through the same field-level walk as `ribo schema inspect`, before core derives the extraction shape. Core therefore adds one envelope per field, leaf descriptions remain available to prompt guidance, plain schemas are unchanged, and the run fingerprint still covers the raw `schemaDocument`. Regression tests over a grouped-and-collection fixture and the real Snugg schema prove that a double-enveloped value cannot arise through the fixed run path, rather than leaving the scorer to mistake one for an abstention.
