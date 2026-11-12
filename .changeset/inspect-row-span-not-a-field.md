---
"@azx/ribo-cli": patch
"@azx/ribo-adapter-snuggpro": patch
---

`inspectSchema` no longer counts a row unit's own `sourceSpan` citation as a schema field: under row granularity the report's leaf count and guidance coverage now cover the real fields only, matching core's own field notion. The row-citation key is core's exported `ROW_SOURCE_SPAN_KEY`, dropped only on a row unit where core skips it, so a leaf field that happens to be named `sourceSpan` still counts. The adapter's entry covers the schema-artifact round-trip test's explicit timeout — no runtime change.
