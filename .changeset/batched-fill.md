---
"@azx/ribo-core": minor
---

**Batched fill: one call per (collection, part) covering every current instance, merged by roster
id.** The scoped-instance extractor gains a `fill` option — `"per-instance"` (the default),
`"batched"`, or `{ batchAbove: n }` — decided per collection group at plan time from the roster's
current-instance count. A batched reply's elements each carry an `instanceId` whose enum is this
run's roster ids, so the model cannot name an instance the inventory did not list; a missing or
duplicated id fails the item retryably (the retry is a re-send), and at exhaustion with
`onItemFailure: "skip"` the part's fields are abstained on every instance, so the array has no
holes. The merge keys on the id and strips it, so reply order cannot mispair values.

New API: `batchedFillPhase` and `BatchedFillPhaseOptions` (with `includeGroup` and the optional
`buildBatchedFillInstructions`) are public for hosts composing their own phase lists;
`FillPhaseOptions.includeGroup` filters collection groups; `ExtractionResult.fillModes` reports the
mode each collection used. Defaults are unchanged: with `fill` omitted, the phase list, the unit
stream, every request and the fields are byte-identical to before — `fillModes` is the one
additive field, and it is never persisted.
