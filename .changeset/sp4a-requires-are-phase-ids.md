---
"@azx/ribo-core": major
---

Phase dependencies are declared over **phase ids**, not note keys (ADR 0008, rewritten in place —
nothing here shipped in a released version).

**`PhaseMeta.requires` names phase ids** — ids of phases that must appear earlier in the same list,
checked by `validatePhases` in list order, a phase unable to satisfy itself. **`PhaseMeta.produces`
is deleted**, and with it the engine's per-phase-boundary verification of a declared `produces`
against what the merge wrote. **`draftSeededNoteKey` is deleted** from core's barrel: it existed
only to be declared, and there is nothing left to declare it in. The remaining note keys
(`rosterNoteKey`, `presenceNoteKey`, `spansNoteKey`, `unsupportedNoteKey`) are unchanged and stay
the **runtime channel** — written and read by their phases, never spoken by a declaration.

The behavioural replacement is a **read-site demand**: a phase whose `plan` reads a note throws a
`TypeError` naming the key and the phase when no earlier phase wrote it, instead of defaulting the
read to an empty value and turning a mis-wired list into a silent all-null run that parses green.
`demandNote` is the shared helper, newly exported from core. Two of the four read sites need a
carve-out — the engine skips a phase's `merge` when its plan was empty, so a producing merge's
"unconditional" write has a hole — so `classifyPhase` throws only when the spans note is missing
while presence still found present leaves, and `classifyWrappedPhase` only when the unsupported
note is missing while grounded spans exist; a legitimately quiet producer stays a no-op.

**`requires` on the phase factories now REPLACES the factory's default rather than unioning with
it.** The default (`spanPhase` → `["presence"]`, `classifyPhase` → `["span"]`,
`classifyWrappedPhase` → `["classify"]`, `fillPhase` → `["inventory"]`; the others declare none)
named the shipped provider of the note the phase's plan reads. Supplying the option is the complete
list: a caller who renames a provider must name the new id, and a caller adding a constraint must
still name every provider the phase reads from — `fillPhase({ requires: ["inventory", "mine"] })`,
not `["mine"]`. `gapFillPhase` declares no `requires` at all and has no default: it is an optional
refiner whose plan returns no items when it finds no candidates, so `[gapfill]` alone is a valid
list.

The engine's per-phase-boundary `produces` verification is gone with the
declaration it verified, and so are its two tests. What replaced them is a
read-site throw per reading phase, pinned end-to-end through `phasedExtractor`
in `span-phase.test.ts` and `fill-phase.test.ts` — look there, not in
`phased-extractor.test.ts`, for the guarantee that a mis-wired list is loud.

`extractorPhase` gains an options object to carry the option — a third, optional
parameter, since it previously took only `(id, extractor)`. The other seven
factories (`presencePhase`, `spanPhase`, `classifyPhase`, `classifyWrappedPhase`
in core; `inventoryPhase`, `fillPhase`, `gapFillPhase` in the openai package)
already had options objects.
