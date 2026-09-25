---
"@azx/ribo-core": minor
---

Add `groupedExtractor` — the per-group run-owner combinator — to `ribo-core`
(composition plan Task 11, `per-group-composition-design.md` §4.2).

`groupedExtractor({ target, groups, ...timing })` takes a per-key map of
`Extractor`s (`GroupMap` — one extractor or an ordered list of pieces per
top-level key) and owns the work that is genuinely cross-group: coverage
checked at construction (every top-level key named, no extras, key named in
the throw), a bounded pool, the retry budget derived from the entry count,
retry with full-jitter backoff (`TerminalQueueError` never retried), sibling
abort, the merge by key, the second trust-boundary parse against the full
`extractionSchema`, `normalize` once, usage summed from each entry's result,
and `statedEmptyGroups` unioned. It emits `GroupUnit` events around each
entry's `extract()` — the unit of retry is the group entry, not the chat call
alone.

**Abort sources combine; they never substitute.** The caller's
`ExtractOptions.signal` and the run's own sibling-failure controller are
combined with `AbortSignal.any` — `??` would substitute the caller's signal
for the run's controller and silently disable sibling abort.

Three primitives moved to core with it, so the copies do not multiply:
`mapWithPool` (was two byte-identical copies in `ribo-extractor-openai`'s
`per-group.ts` and `instance-fill.ts`; the combinator would have been the
third), `mergeGroupPieces` (the partitioned-group recombination the
combinator's merge needs), and `parseWithSchema` (the trust-boundary parse,
now beside the `SchemaParseError` it throws — `groupedExtractor`'s second
parse is the same function as the extractors' first parse).
`ribo-extractor-openai` imports all three from core; its public surface is
unchanged.

No call sites change: `perGroupExtractor` keeps its current shape and becomes
a preset over this combinator in the next task.
