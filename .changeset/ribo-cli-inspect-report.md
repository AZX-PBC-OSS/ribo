---
"@azx/ribo-cli": minor
---

The `ribo schema inspect` engine grows from the four-field skeleton report to the full sizing
report of the schema-inspect design: leaf and group counts, the split path and call shape, whole
and per-piece measures with the worst piece, per-strategy call counts (single-shot, per-group from
a real `perGroupPlan`, the presence-narrowed upper bound, consensus per candidate), guidance
coverage, a reformat-description lint, the full leaf-granularity violation list, a not-visible
report, threshold comparisons, and a canonical schema fingerprint. `CONTRACT_VERSION` bumps to 2
with the new fields. The loader now refuses a draft-2020-12-form document loudly — naming the form
and `docs/guide/from-a-schema.md`, which gains the OpenAPI 3.0 export section — and the library
zod-parses the serialized report (`SchemaInspectReportSchema`, exported) before returning it.
`@azx/ribo-adapter-snuggpro` joins as a dev-only dependency for the conversion round-trip guard.
