---
"@azx/ribo-adapter-snuggpro": minor
"@azx/ribo-extractor-openai": minor
---

Add per-group prompt assembly — each per-group extraction call gets the
universal instructions plus only its own group's rules (R3 Task 4).

`snuggGroupInstructions(key)` produces a per-group prompt: the universal
rules (1–6, 11–13) plus only the group-specific rules (7 → hvac+dhw,
8 → attic+dhw, 9 → health, 10 → hvac), with an output section that asserts
the single top-level key instead of all seven. The rules are data keyed by
group and the assembly is mechanical — a rule assigned to no group is caught
by a test, not a silent accuracy regression.

`buildGroupMessages` (extraction-common) and `projectExample` are exported
from `@azx/ribo-extractor-openai` for the per-group extractor and for testing.
`perGroupExtractor` gains an optional `groupInstructions(key)` option; when
provided, each grouped call gets its own instructions and a projected example
(one top-level key in the assistant turn). Without it, behaviour is unchanged.

The full `snuggProInstructions` is preserved for the single-shot extractor.
The only text change is "The four rules below" → "The rules below" in the
normalization intro (accurate per-group, where the count varies).
