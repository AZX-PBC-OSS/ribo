---
"@azx/ribo-core": minor
---

Export `childPath` from the barrel, beside `buildFieldPath`/`parseFieldPath`. The field-path grammar
anticipates further walks over the same schemas ("a third walk is coming") — the schema-shape
derivation and the mapping-back in `@azx/ribo-extractor-openai` are those walks, and every walk must
refuse the same path-breaking key shapes rather than copy the validation.
