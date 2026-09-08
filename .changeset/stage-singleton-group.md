---
"@azx/ribo-adapter-snuggpro": minor
---

New `stage` group — the job's workflow stage as a job-collection SINGLETON (doc 20 §5.1;
job-collections foundation design), alongside `basedata` and `health` rather than as a per-instance
array: the job holds exactly one current `stageId`, and `POST /jobs/{jobId}/stage` is a state
transition, not an instance create. Its one capture field, `stageId`, is `z.number()`: the spec's
operation publishes no `enum` key — the ten valid codes exist only in the description prose — so the
label→code vocabulary (1 Lead … 10 Archived Lost) travels in the leaf's description, the same
treatment `basedata.hasEv` established for a numeric `enveloped()` leaf; `POST /jobs` independently
declares the same closed set as a real enum, confirming completeness. Its sibling
`stageChangeReason` is deliberately out of scope. With the four job-collections tranches integrated
the schema totals 214 leaves across ten groups; `descriptions.generated.ts` was regenerated (the
vendor describes `stageId`) and the frozen extraction fixture was re-captured for this deliberate
field-set change.
