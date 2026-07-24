# Adapters

A `ToolAdapter<F, C>` is the only tool-specific surface in the workspace: the field schema, the
instructions and few-shot examples that describe those fields to an extractor, the deterministic
post-model normalization pass, and the write-back seam. A second host tool is a new adapter package and
nothing else. `@azx/ribo-adapter-snuggpro` is the reference implementation.

::: info Content coming
A guide to writing a `ToolAdapter` lands in the content pass. See
[`ToolAdapter`](/reference/ribo-core/src/interfaces/ToolAdapter) and
[`snuggProAdapter`](/reference/ribo-adapter-snuggpro/src/variables/snuggProAdapter).
:::
