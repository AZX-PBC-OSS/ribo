---
"@azx/ribo-core": patch
"@azx/ribo-storage-rxdb": patch
"@azx/ribo-ui-react": patch
---

`skippedItems` crosses the session-extract seam (ADR 0029, the step ADR 0026 deferred).
`ExtractStepResult` gains the field, `toSessionExtractStep` forwards it, and the relay persists
it as its own session document field — set unconditionally on every extraction, so a
re-extraction clears a prior run's stale report, and absent/`[]` keep their ADR 0026 meanings.
**The sessions schema bumps v2 → v3** with an identity rung; an optional field still needs the
bump, because a changed shape at an unchanged version is refused at `addCollections` with DB6
and takes the captures down with the open. Every consumer takes the migration.

`buildReviewRequest` gains a `skippedItems` option and sets a `skipped: boolean` flag on the
review tree's collection nodes, top-level object nodes, and each instance node a reported
item's coordinates name (`useReview` passes the session's field through automatically). This is
deliberately a flag beside the state family, not a new `ReviewGroupState`: a skipped fill does
not change how many instances exist, and a new state value would break every exhaustive switch
for no extra information. Note the honest gap: a `groupedExtractor` tier has no skip path, so
an absent report can also mean the winning tier could not have skipped silently — "absent" and
"empty" are different answers, and the difference lives on the session field.
