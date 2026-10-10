---
"@azx/ribo-core": minor
"@azx/ribo-ui-react": minor
---

The review tree can be laid out by a shape plan. `buildReviewRequest` and `useReview` take an
optional `reviewPlan` (a `DerivedExtractionShape`, or just its `mapping` and `partitions`), and
`ReviewRequest.tree` is laid out by it:

- a partitioned group shows one labelled section per part, in the plan's order, with an "Other"
  section last for the fields no part names and the fields the plan dropped; every instance of a
  collection gets the same sections;
- a regroup's new intermediate groups show as sections inside their group, and a nest's new
  top-level group shows as a top-level section;
- retypes are ignored, so the reviewer still edits the patch type.

Only the tree changes: `fields`, every `FieldPath`, `resolveReview` and the write are identical
with and without a plan, and a leaf inside a section is the same object `fields` holds. A plan
entry the values schema lacks is ignored. Without `reviewPlan` the request is exactly as before.

Sections are a new `ReviewSectionNode` member of `ReviewNode` (`{ kind: "section", label, children }`,
no `path` or `key`). The union widens for every host, plan or not: an exhaustive switch over
`ReviewNode` needs a case for it.
