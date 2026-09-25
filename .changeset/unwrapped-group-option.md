---
"@azx/ribo-core": major
---

**The unwrapped portion is an option, not a map key** — a breaking change to an unreleased API
(both packages are `0.0.0`), re-spelling what ADR 0023 decided without changing what it decided.

In `@azx/ribo-core`, `groupedExtractor` no longer takes the unwrapped portion as a `""` key in
its `groups` map. `GroupedExtractorOptions` becomes a base intersected with a new
`GroupedEntries` union — exhaustive `groups` alone, `groups: Partial<…>` beside a required
`unwrapped` entry, or `unwrapped` alone — because "named keys, or the unwrapped entry, or both"
is the conditional required-ness one record cannot express: a missing group beside no
`unwrapped` is still a compile error, while the redundant combination (exhaustive `groups` plus
`unwrapped`) still compiles and throws at construction, exactly as before. `GroupMap` narrows to
the named-only map, and the `""`-contract prose moves onto the new `UnwrappedEntry` type. The
combinator folds `unwrapped` onto the internal `""` key at entry, so coverage, scheduling, the
merge and the merge-ownership guard are unchanged — and a literal `""` key inside `groups` now
throws at construction (`use the unwrapped option`) instead of silently dropping one of two
declarations. The marker stays on the reading surface — `ExtractionGroup.key`, `GroupUnit.key`,
`PhaseUnit`'s default — and gains an exported name, `UNWRAPPED_KEY`, so a consumer compares
against a constant. The error messages that named `the "" entry` (the redundancy refusal, the
merge-ownership guard and its `statedEmptyGroups` variant) now name the unwrapped entry.

In `@azx/ribo-extractor-openai`, `PerGroupPlan` gains parallel slots beside `groups`/`targets` —
`unwrapped` (the entry or ordered piece list) and `unwrappedTarget` (its projected target,
index-aligned) — in the same two shapes: an all-grouped plan has no unwrapped portion; a mixed
or flat plan carries the named maps beside both slots. `GroupTargets` narrows to the named-only
map. `overrideGroups` returns the `GroupedEntries` union with the plan's `unwrapped` entry
threaded through untouched, so the call site becomes
`groupedExtractor({ target, ...overrideGroups(plan, { … }) })`; it gains no slot for the loose
portion (ADR 0023 carries that decision forward), and its mixed-plan refusal now points at
passing `unwrapped` to `groupedExtractor` yourself. The preset's requests are byte-identical.
