---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": minor
---

SP4a wave 6: a shipped phase can be made to wait for a phase of your own.

Every phase factory's options gain `requires?: readonly string[]` — extra note
keys the phase must wait for, **unioned** with the phase's own. A host composing
its own phase beside shipped ones could already wire `plan` to read whatever it
liked, but could not make a *shipped* phase order itself after that phase's
output; now the list `[inventoryPhase, myPhase, fillPhase({ requires:
[myNoteKey] })]` validates, and reversing the last two is rejected at
construction, naming `fill` and the key no earlier phase produced. The phase's
own `requires` is a fact about what its `plan` reads, not a configuration
choice, so the option can only add ordering, never subtract it — declaring away
a real dependency is the `[gapfill]`-alone class of bug the note-key check
exists to reject.

**There is deliberately no additive `produces`.** The engine verifies every
declared `produces` key against what the phase's merge actually wrote, and a
shipped merge will never write a caller's key — declaring one would throw
mid-run. A caller's contribution belongs on a caller-built phase, whose
`produces` is written in its own merge and verified like any other.

`extractorPhase` gains an options object to carry the option — a third, optional
parameter, since it previously took only `(id, extractor)` and still declares no
`requires` of its own. The other seven factories (`presencePhase`, `spanPhase`,
`classifyPhase`, `classifyWrappedPhase` in core; `inventoryPhase`, `fillPhase`,
`gapFillPhase` in the openai package) already had options objects. Duplicates
across the union are removed cosmetically: the engine tolerates a repeat, and
dedup keeps error messages and any future introspection clean.
