---
"@azx/ribo-extractor-openai": minor
"@azx/ribo-core": minor
---

Partition the flat (non-grouped) fallback against the supplied byte cap.

A flat extraction schema (top-level leaves rather than nested groups) used to
fall back to a single entry covering the whole input — under every cap. With a
byte cap supplied, that single piece frequently exceeded the route's
character ceiling, and the request was rejected at the provider with a `400`
indistinguishable from any other schema rejection. The grouped packer ran
only on the grouped path.

`splitExtractionSchema` now partitions a flat schema over its top-level keys
when a byte cap is supplied, producing several entries that share `key === ""`,
each a strict object carrying a disjoint subset of leaves. The existing
`key === ""` consumers (`perGroupExtractor`'s flat-fallback plan,
`groupedExtractor`'s merge, `prepareGroups`, the inventory/fill phases)
recombine them via shallow `Object.assign` — each piece's parsed response is
a disjoint subset, so assignment in piece order is the merge.

The union cap does not partition a flat schema; that path is unchanged
(`split-schema-unions.test.ts` pins its single-entry behaviour). Without a
byte cap, the flat path is also unchanged.

`GroupMap`'s `""` arm now also accepts an array of extractors — the partitioned
flat case — alongside the historical single-entry shape. `groupedExtractor`
flattens that array to N ordered entries with `part: i+1`, `parts: N`, matching
the vocabulary for partitioned grouped schemas.
