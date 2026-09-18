---
"@azx/ribo-core": minor
"@azx/ribo-adapter-snuggpro": minor
---

Instance identity is a first-class core contract: the "are these two descriptions the same
real-world thing?" decision no longer lives inside one adapter function.

`@azx/ribo-core` gains the sameness vocabulary — `InstanceEvidence`, `InstanceFacts`,
`InstanceMatcher` and the three-valued `InstanceSameness` (`"same" | "different" | "unknown"`,
never a boolean, because "these disagree" and "neither side said anything" are different
answers) — plus the shipped `contradictionMatcher`. A host declares, per group, which leaves
identify an instance; the matcher vetoes on a committed `Object.is` disagreement of any of
them and answers `"unknown"` otherwise. What a consumer gains is a shared contract with a
conservative default, not a smarter one: **the matcher never returns `"same"`** — agreement
on identifying fields is not identity (two identical furnaces in one house agree on every
declared field and are two records), so saying "same" stays host judgement. A wrong create is
visible at review and removable; a wrong merge is invisible and permanent. An unflattened
`Extracted` envelope passed where a value belongs throws, naming the field, rather than
producing a matcher that vetoes every pair.

`@azx/ribo-adapter-snuggpro` declares the HVAC identifying fields on
`ToolAdapter.identifyingFields` and re-expresses `rankCandidates` over `contradictionMatcher`
with identical ranking behaviour — and `rankCandidates` and `HVAC_IDENTIFYING_FIELDS` are now
actually exported from the package barrel, which the R1.6 Task 11 changeset claimed but the
barrier never delivered.

Not here yet, deliberately: cross-chunk instance alignment will consume this vocabulary in a
later phase, and nothing in this change auto-merges anything.
