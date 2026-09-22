---
"@azx/ribo-core": minor
"@azx/ribo-extractor-openai": minor
---

**The `""` group key now means the unwrapped portion, not the whole schema** — a mixed schema
(groups beside loose top-level leaves) splits into one entry per group plus the loose leaves as
`""` piece(s), instead of one loose key vetoing every other key's grouping and collapsing the
schema to the flat fallback. That collapse was measured on a live run: 14 `nest` groups plus 47
loose leaves could not split at all (`nest-live-run-evidence.md` §3), and wiring the packers
alone only moved the failure to `groupedExtractor`'s refusal (§5) — so the split and the map
contract change together.

In `@azx/ribo-core`, `GroupMap` gains a third arm — named keys beside an optional `""` entry —
and the blanket "either the schema has groups or it does not" refusal narrows to a redundancy
rule: `""` beside named keys that do not cover the schema is accepted (the `""` entry owns the
unnamed remainder; a lying declaration surfaces at the second trust-boundary parse, as the
fallback arm's always did), while `""` beside named keys that already cover every top-level key
still throws. The widening is strict: every map accepted before behaves identically, and only
maps that threw change behaviour. Because the `""` slot's type keeps the whole-shape claim, the
merge's `""` arm is guarded at runtime: a `""` entry whose result fields — or whose
`statedEmptyGroups` — carry a key a named entry covers throws, naming the key, since the `""`
entry covers only the unwrapped remainder and the shape-valid closing parse cannot see a
shape-valid but wrong value. The `statedEmptyGroups` union now happens in schedule order rather
than pool arrival order, so two entries stating one key resolve deterministically.

In `@azx/ribo-extractor-openai`, `splitExtractionSchema` classifies top-level keys once and
splits a mixed schema into the grouped path's pieces (unchanged under each cap regime) plus the
loose keys packed as the unwrapped portion — one `""` piece under no cap or the union cap alone
(the union cap still does not partition flat material), flat-packed pieces sharing `""` under a
byte cap. ADR 0013's over-cap-leaf refusal applies to a loose leaf unchanged. `perGroupPlan`
flows the loose pieces through its existing `""` branch — the loose request is the flat
fallback's request: the target's own instructions, full unprojected examples (leaf-narrowed when
partitioned), no group-key infix in the wire name, and `groupInstructions` is never invoked with
`""`. `GroupTargets` widens beside `GroupMap`, and `overrideGroups`'s refusal for a mixed plan
no longer claims "not an object of groups" — it names the `""` entry, which takes no override,
and points at hand composition.

The scoped-instance preset needed no code: `prepareGroups`, the inventory phase and the fill
phase already handled a `""` piece as one entry among several, and new pins lock that a mixed
split flows through them with zero behavioural drift. ADR 0023 records the contract change.
