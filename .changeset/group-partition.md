---
"@azx/ribo-core": minor
---

**The shape vocabulary gains `partition`, and a group's parts reach the extraction calls.** A
partition names one group's parts — label → the group's direct fields — and cuts the group's
extraction calls along them: one call per part, each carrying a label line ("This call covers the
… fields of …"), cut along the parts even when the whole group would fit under the caps. The
proposer can propose partitions — its wire `parts` are an array of `{ label, fields }` pairs
(the structured-output route rejects records), converted to the record form the applier takes —
and a committed partition tags its fields `[part: <label>]` on a resume turn's field list.

New API: `partition` joins the `ShapeOperation` union; `DerivedExtractionShape.partitions`
(`ShapePartitions`) records the applied cut; `SplitOptions.partitions`, `PerGroupOptions.partitions`,
`ScopedFillOptions.partitions` and the enveloped `schemaExtractor`'s `partitions` option forward it
to the split (a non-empty record forces the per-group path over single-shot);
`partitionLabelLine(groupKey, label, elsewhere?)` renders the label line, naming the group's fields other calls cover (`ExtractionGroup.elsewhere`) so a narrowed call leaves their facts out. A host that passes no partitions gets
byte-identical requests, phase lists and fields.
