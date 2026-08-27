---
"@azx/ribo-core": patch
"@azx/ribo-extractor-openai": patch
---

A schema parse failure is now a recognisable, still-retryable error.

Adds `SchemaParseError` to `@azx/ribo-core`: a JSON-parsing-but-schema-violating model
response that stays transient (`isTransientFailure` still returns `true`) while also being
recognisable by the default arbiter. `terminalFallsThrough` now continues past a
`SchemaParseError`, so a strategy ladder can try a different shape without stripping the
queue retry behaviour that recordings without a second chance depend on.

`@azx/ribo-extractor-openai` now throws `SchemaParseError` from `parseWithSchema`, which is
shared by both `singleShotExtractor` and `perGroupExtractor` (including the per-group parse
and the merged-whole parse). Non-JSON bodies still throw a plain `Error` and remain
transient but are not relabelled as schema failures. This changes the shipped error type
for both extractors when a model response parses as JSON but violates the extraction schema.
