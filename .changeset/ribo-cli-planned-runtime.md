---
"@azx/ribo-cli": minor
---

Execute planned eval ladders through core's `plannedExtractor`, with parsed plans supplied separately from JSON settings. The runner validates plan coverage and layout before transcription, derives the effective settings' fingerprint through core, and exposes `runEvalWithSettings` so record-building callers receive that identity; `runEval` remains the results-only wrapper.
