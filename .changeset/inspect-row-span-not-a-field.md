---
"@azx/ribo-cli": patch
"@azx/ribo-adapter-snuggpro": patch
---

`inspectSchema` no longer counts a row unit's own `sourceSpan` citation as a schema field: under row granularity the report's leaf count and guidance coverage now cover the real fields only, matching core's own field notion. The row-citation key is core's exported `ROW_SOURCE_SPAN_KEY`, which identifies a row unit and refuses a real field of that name, so a genuinely named field cannot be miscounted. The adapter's entry covers the schema-artifact round-trip test's explicit timeout — no runtime change.
