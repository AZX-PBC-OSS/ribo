---
"@azx/ribo-core": minor
---

The vocabulary for describing a multi-pass extraction strategy as a list of phases, with the wiring checked at construction.

A phase becomes a value a caller can construct, inspect and validate: `Phase` (its item and contribution types hidden existentially behind one `with` member, so one phase's items cannot feed another phase's `run` without a compile error), `PhaseDef`/`PhaseContext`/`PhaseMeta`, the curried `phaseBuilder`, branded note keys with an immutable `Notes` bag, a `PhaseDraft` whose `fields` are a homomorphic deep partial of the enveloped shape, `PhaseOutput`/`PhaseItemOutcome`, a construction-time `validatePhases` that rejects a mis-wired list (naming the phase and the key or value), and `extractorPhase`, which lifts any existing `Extractor` into a one-item phase.

Nothing runs a phase yet — the engine (`phasedExtractor`) is a later wave.
