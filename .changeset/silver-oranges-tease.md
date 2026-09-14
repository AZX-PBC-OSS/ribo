---
"@azx/ribo-core": major
---

Constrain `toSessionExtractStep<F>` to `F extends Record<string, unknown>` and remove the `as ExtractedFieldMap` cast. The bound prevents passing an extractor whose fields are a primitive, while `Enveloped<V, P>` continues to satisfy it.
