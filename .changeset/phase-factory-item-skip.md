---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": minor
---

Let `fillPhase` and `gapFillPhase` skip a failed item instead of failing the run.

Both factories accept `onItemFailure: "abort" | "skip"`. Absent, it stays
abort, exactly as before. Under skip, `fillPhase`'s merge writes a failed
call's slot as abstained, and fills only keys the slot does not already hold,
so a committed value or a cited null survives a failed re-ask. Without that
write, a skipped fill left a hole the closing parse rejected with a
`SchemaParseError`, which also hid the real error. `gapFillPhase` under skip
keeps the base's leaves.

`inventoryPhase` deliberately takes no such option. A skipped inventory would
only move the failure one phase later, to the fill's missing-roster-note error.

New in `@azx/ribo-core`: `abstainedValue(schema)`, the all-abstained value of
a built extraction schema, which parses against that same schema at every
provenance granularity.

A skipped slot is not yet distinguishable from one the transcript never
mentioned.
