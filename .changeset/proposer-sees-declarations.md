---
"@azx/ribo-core": minor
---

**The shape proposer validates against the caller's declarations, and shows them to the model.**
`proposeExtractionShape` used to pass `provenance`, `requiredOnCreate` and `identifyingFields` to
the final derive only, so a proposed drop that stranded one was accepted without a repair turn and
the final derive threw. `proposeShapeOperations` now takes the same declarations as an optional
third argument and validates every attempt against them: the conflicting drop is refused, repaired,
and left out of the surviving subset at exhaustion. `proposeExtractionShape` forwards its own.

`renderLeafInventory` takes the declarations as an optional second argument (typed by the new
`InventoryDeclarations`) and tags what they name — `[required on create]`, `[identifying]`,
`[provenance: <granularity>]` — and the proposal directive tells the model not to drop a tagged field
or group. Without declarations the inventory is unchanged.
