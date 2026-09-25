---
"@azx/ribo-core": minor
---

`perGroupExtractor` becomes a preset over `groupedExtractor`, and the plan it
builds is exported (composition plan Task 12, `per-group-composition-design.md`
§4.3).

`perGroupPlan({ target, chat, model, maxTokens, groupInstructions, singleton,
maxNullableUnionsPerGroup })` returns `{ groups, targets }` — the exhaustive
per-key map of default entries (a `singleShotExtractor` per piece over a
`projectTarget`-projected target) and the projected `ExtractionTarget`s those
entries were built from, index-aligned. `overrideGroups(plan, overrides)` then
replaces or wraps one group per PIECE — the unit that matters, because a group
over the nullable-union cap (Snugg Pro's `health`) is partitioned into pieces
sharing its key, and an override that silently applied to only the first piece
would be worse than none. Untouched keys come back reference-equal to
`plan.groups`'s, so the common case reads as it reads in the design: the
defaults everywhere, except `health` also gets gap-fill and `componentLoads`
goes to a cheaper model. An unknown override key is a compile error for a
TypeScript caller and a construction-time throw naming the key for a JS caller.

`perGroupExtractor` is now `groupedExtractor({ target, groups:
perGroupPlan(options).groups, …timing })` and nothing more; its signature is
unchanged. Requests are byte-identical to the pre-combinator implementation —
`response_format.json_schema.name`, the schema, the message list, the order —
pinned by the unchanged `per-group.test.ts` suite, the adapter's
`per-group-cap.test.ts` and the frozen JSON Schema fixture. Two semantics move
with the retry unit, as the design's §7 records: the unit of retry is the group
entry's `extract()` rather than the chat call alone, and `usage.calls` sums
what entries report, so the preset's default entries count their own chat calls
per run — failed attempts included, the way the old loop counted them.
`perGroupArrayExtractor` and `perGroupSingletonExtractor` remain names for the
two `singleton` settings.

For the preset's non-grouped fallback, `GroupMap` gains a second arm: a map
whose only key is `""` declares ONE entry covering the whole schema — the shape
`splitExtractionSchema`'s fallback yields and the preset sends today, with
`GroupUnit` events keyed `""` and the entry's fields merged flat. The design
(§4.7) keeps that derived behaviour in the preset; a hand composer naming keys
per group is unchanged.
