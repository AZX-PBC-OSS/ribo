---
"@azx/ribo-extractor-openai": minor
"@azx/ribo-extractor-ondevice": patch
"@azx/ribo-adapter-snuggpro": patch
---

`perGroupExtractor` now partitions a group whose leaves exceed 8 (the real per-call ceiling on Anthropic-family models, which reject a response schema with more than 16 nullable unions — this repo's provenance envelope emits two per leaf) into multiple calls sharing one key, recombined after. `hvac` and `health` in the current Snugg Pro schema already exceed the ceiling; this is invisible today because the managed path is pinned to OpenAI-family models, and is proactive groundwork for a possible future Anthropic-compatible path rather than a live behavior change. `splitExtractionSchema` gains an opt-in `maxLeavesPerGroup` parameter and a new exported `MAX_ENVELOPED_LEAVES_PER_GROUP` constant; every existing caller that doesn't pass it is unaffected.

Separately, `threePhaseExtractor` (the on-device path's extractor) no longer silently drops the leaves of an array-shaped group (`hvac`/`attic`/`wall`/`window`/`dhw`, introduced by R1.6 instance modeling) and then throws on its own closing parse — it now walks into the array's per-instance schema and wraps the filled instance back into a one-element array. This was a live bug on the on-device path.

`@azx/ribo-adapter-snuggpro` gets a new regression test (`per-group-cap.test.ts`) guarding the leaf-count cap above; no behavior change to the adapter itself.
