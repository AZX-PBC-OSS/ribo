---
"@azx/ribo-extractor-systemone": minor
---

Remove the `corroborationCensus` value (and the `CorroborationCensusOptions` type that only parameterised it) from the public barrel — `corroborateExtractor` is the public surface; the census it runs is an implementation detail.
