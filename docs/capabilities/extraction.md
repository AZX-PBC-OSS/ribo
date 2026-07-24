# Extraction

The `Extractor` seam turns a transcript into structured fields. `toExtractStep` collapses any extractor
onto the relay's injected step; the `FakeExtractor` drives the pipeline with no model. The built default
is the tool-agnostic single-shot managed-LLM extractor in `@azx/ribo-extractor-openai`, composed with a
tool adapter (e.g. `@azx/ribo-adapter-snuggpro`) as its extraction target.

::: info Content coming
The narrative and a worked example land in the content pass. See
[`Extractor`](/reference/ribo-core/src/interfaces/Extractor) and
[`singleShotExtractor`](/reference/ribo-extractor-openai/src/functions/singleShotExtractor).
:::
