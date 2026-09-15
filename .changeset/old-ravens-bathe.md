---
"@azx/ribo-core": major
"@azx/ribo-extractor-ondevice": major
---

Delete redundant type casts in `instance-write-step.ts` and `three-phase-extractor.ts`. `adapter.schema.parse(...)` and `target.extractionSchema.parse(...)` already return the typed value; the casts only masked future drift.
