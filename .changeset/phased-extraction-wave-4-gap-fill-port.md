---
"@azx/ribo-extractor-openai": major
"@azx/ribo-core": minor
---

**`gapFillExtractor` is now a `phasedExtractor` preset** — an `extractorPhase` base followed by the new exported `gapFillPhase` follow-up — rather than a closed wrapper. A host can assemble the same phase list by hand and extend it with phases of its own.

`@azx/ribo-core`'s share is additive: `phasedExtractor`'s usage accumulation now carries `engine` and `strategy` (first phase to report each wins), so a phased run reports which transport and approach produced the draft the way composed extractors always did.

Host-visible changes to `gapFillExtractor`:

- **The `onUnit` observer's unit type widens from `GapFillUnit` to `PhaseUnit`**, and it now receives the engine's phase events — including a base-phase `start`/`done` pair on the no-candidates passthrough path, which previously emitted nothing. The per-event `candidates` count is no longer carried; phases are identified by `phaseId` (`"base"`, `"gapfill"`) and `pass`.
- **Returned objects are no longer reference-equal to the base extractor's** — on both the follow-up and the passthrough path — because the engine's closing trust-boundary parse rebuilds every object. Values are unchanged (deep equality holds).
- **A base extractor producing a shape that does not satisfy the extraction schema is now rejected by the closing parse** where it previously passed through untouched. Valid shapes are unaffected.

What a consumer gains: gap-fill is a phase list a host can extend — `gapFillPhase` is exported — rather than a closed wrapper. Both phases are pinned to zero retries, keeping today's call pattern: the base is attempted exactly once, and the follow-up has no retry loop. `raw` on the follow-up path remains the merged fields.
