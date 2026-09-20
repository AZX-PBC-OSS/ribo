---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": minor
---

Repetition means something, and a phase list can use a kind more than once.

`@azx/ribo-extractor-openai`'s `fillPhase` gains `narrowToAbstained?: boolean` (default
`false`). When true, `plan` skips a job whose leaves are already committed in the draft —
"committed" meaning what it means everywhere else, a leaf envelope whose `value` is
non-null — so the list `[inventoryPhase, fillPhase, fillPhase({ narrowToAbstained: true })]`
re-asks only about what the first fill did not get, and the first fill's results survive
the second's merge. The granularity is the job, not the leaf: a job with any uncommitted
leaf is planned in full, because leaf-level narrowing is `gapFillPhase`'s and is a
different phase. To make that sound, the fill merge now starts each collection array from
the draft's own entry for the key, so the slots a narrowed fill skipped are preserved
rather than blanked — a full fill is unaffected, since every slot's job ran.

All seven options-based phase factories — `inventoryPhase`, `fillPhase` and `gapFillPhase`
in `@azx/ribo-extractor-openai`; `presencePhase`, `spanPhase`, `classifyPhase` and
`classifyWrappedPhase` in `@azx/ribo-core` — gain `id?: string`, defaulting
to the factory's current literal (`inventory`, `fill`, `gapfill`, `presence`, `span`,
`classify`, `classify-wrapped`). `validatePhases` rejects duplicate ids, so a phase list
could not use one kind twice; renaming an instance unblocks that. `extractorPhase` already
takes its id as a required parameter and is unchanged.

An id reaches only `validatePhases`' duplicate check, the engine's error messages and
`PhaseUnit.phaseId` in the live observer stream — nothing persists it — so a caller-chosen
id changes only what a progress consumer sees. `@azx/ribo-core`'s `PhaseMeta.id` now
documents that contract, which is what makes a caller-chosen id supported rather than
incidental.
