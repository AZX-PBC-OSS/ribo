---
"@azx/ribo-extractor-openai": major
---

Thread the `P` provenance-map type parameter through `GapFillOptions` and `gapFillExtractor`. `gapFillExtractor` can now wrap extractors whose target declares a `"row"` group or any other custom provenance granularity, matching the other strategy wrappers in the package.
