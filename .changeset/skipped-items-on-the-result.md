---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": minor
---

Report which phase items a run skipped. `ExtractionResult.skippedItems` lists each item a skip
policy (`onItemFailure: "skip"`) gave up on. Each entry carries the phase id and the item's
coordinates, the same members a `PhaseUnit` carries. For a fill item that is the group key, the
instance and the piece. An engine-written abstention is byte-identical to a model abstention, so
this list is the only way a caller can tell them apart.

`phasedExtractor` always sets the member (`[]` when nothing was skipped); an extractor with no
skip path leaves it absent. `groupedExtractor`, `consensusExtractor`, `extractorPhase` and
`reshapedExtractor` carry it through; `reshapedExtractor` translates a nest group's item into the
patch keys it feeds. `cachedExtractor` no longer stores a result that skipped anything. See ADR 0026.
