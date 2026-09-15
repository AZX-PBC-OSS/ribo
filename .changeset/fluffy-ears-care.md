---
"@azx/ribo-core": major
"@azx/ribo-extractor-openai": major
"@azx/ribo-adapter-snuggpro": major
---

Move the generic `Roster`, `RosterCandidate`, and `FillScope` vocabulary from `ribo-extractor-openai` into `ribo-core`, and re-export them from `ribo-extractor-openai` for backward compatibility. The adapter now imports `FillScope` from the extractor package instead of maintaining a duplicate local copy.
