---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": minor
---

SP4a wave 6: a shipped phase can be made to wait for a phase of your own.

Every phase factory's options gain `requires?: readonly string[]`. A host composing
its own phase beside shipped ones could already wire `plan` to read whatever it
liked, but could not make a _shipped_ phase order itself after that phase's
output; now the list `[inventoryPhase, myPhase, fillPhase({ requires: [...] })]`
can express that ordering, and a mis-ordered list is rejected at construction,
naming `fill` and the id that does not appear earlier in the list — the repair
prompt for the next attempt.

`extractorPhase` gains an options object to carry the option — a third, optional
parameter, since it previously took only `(id, extractor)`. The other seven
factories (`presencePhase`, `spanPhase`, `classifyPhase`, `classifyWrappedPhase`
in core; `inventoryPhase`, `fillPhase`, `gapFillPhase` in the openai package)
already had options objects.

_(Since this changeset was written, the semantics of the option changed: under
phase-id declarations (see `sp4a-requires-are-phase-ids.md` and ADR 0008) the
option **replaces** the factory's default rather than unioning with it — the
complete list of ids, with the caller responsible for naming every provider the
phase reads from. This changeset's argument for union semantics and its claim
that `[gapfill]`-alone is the bug class a declaration check exists to reject are
kept here only as the record of what wave 6 shipped; the reversing decision and
its reasoning live in the newer changeset and the ADR.)_
