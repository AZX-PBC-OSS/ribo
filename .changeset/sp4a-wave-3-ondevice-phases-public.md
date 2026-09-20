---
"@azx/ribo-extractor-ondevice": minor
---

The on-device phases can now be composed outside the package.

`@azx/ribo-extractor-ondevice` exports the four phases `threePhaseExtractor` composes —
`presencePhase`, `spanPhase`, `classifyPhase` and `classifyWrappedPhase` — together with
their options types (`PresencePhaseOptions`, `SpanPhaseOptions`, `ClassifyPhaseOptions`;
the wrapped pass shares the classify options) and the note keys their hand-offs cross the
draft under (`presenceNoteKey`, `spansNoteKey`, `unsupportedNoteKey`). Until now the
package exported only the preset, so every composition — by a host, by hand, or
eventually by a planner — was managed-only, which for an offline-first library is the
wrong half. A host can now reorder the phases, drop the wrapped pass, or slot a phase of
its own into the chain; `threePhaseExtractor` remains the supported preset for callers
who do not want to compose.

The cost, stated plainly: this widens a public surface deliberately and permanently. Four
factories, their options types and their note keys are now supported API and a
compatibility commitment — exporting a phase without its note key would have exported
something that cannot be composed with anything, which is why the keys travel with the
factories.

The schema walk goes with them: `extractGroups` and its `Group`/`Leaf`/`JsonSchema` vocabulary are public too. Exporting the phases without it exported something a host could construct but never run — `presencePhase` takes walked groups and nothing else produces them. This mirrors `@azx/ribo-extractor-openai`, where `splitExtractionSchema` and `PreparedGroup` are public for the same reason.
