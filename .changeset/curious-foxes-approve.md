---
"@azx/ribo-core": minor
---

`enveloped()` recurses through arrays into their element schema.

A `z.array(...)` in the values schema becomes an extraction schema whose element carries one provenance envelope per leaf, not a single envelope wrapping the whole array. The property count is therefore bounded by the element shape rather than the number of instances, which is what keeps the schema under the model provider's cap as the Snugg Pro adapter adds per-instance groups in R1.6. Nested arrays recurse uniformly; records and unions still throw with a field path because they cannot be expressed in OpenAI strict structured-output mode.
