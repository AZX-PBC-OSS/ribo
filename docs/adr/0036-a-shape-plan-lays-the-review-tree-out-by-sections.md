# 0036. A shape plan lays the review tree out by sections

Status: Accepted
Date: 2026-10-09

## Context

`buildReviewRequest` walks the values schema and presents every group as one list of leaves in
schema-declaration order, so a large partitioned group — Snugg Pro's `hvac` — renders as an
undifferentiated list per instance. The derived extraction shape already carries a better layout:
its `partitions` record holds the topic labels a model proposed for each partitioned group
("cooling", "heating"), and its `mapping` records where each field was regrouped or nested. Review
read neither. The plan is a good layout for a person too, and it already exists — reusing it in
review changes the presentation and nothing else, because a review's decisions are keyed by leaf
paths and read off `fields`, never off the outline (ADR 0034 left the partition cut out of every
schema; it lives on the derived shape alone).

Three constraints shaped the decision:

- **The tree is the only rendering channel a host has.** A section has no path and no key, so it
  cannot be expressed as any existing `ReviewNode` member — leaf, object, collection. The union
  has to widen.
- **The plan is a presentation input the host holds**, read together with the walked schema, and
  it need not be the one extraction ran with. The option's type is therefore
  `Pick<DerivedExtractionShape, "mapping" | "partitions">`: the two records layout reads, and
  nothing else about the shape — not the extraction schema, not the provenance, not the
  declarations. "Nothing about the extraction run is consulted" holds at the type level.
- **A stale plan is a presentation mismatch, not an invalid request.** A plan naming a group or
  field the walked schema lacks leaves the request correct; only its layout degrades.

## Decision

**`buildReviewRequest` takes an opt-in `reviewPlan`, and a tree built with one presents the
plan's sections: partition labels as labelled sections, regrouped and nested fields under the
plan's groups, fields the plan left without a topic under one "Other" section — a second view of
the same leaves, never a second source.** The union gains
`ReviewSectionNode { kind: "section"; label; children }` with no `path` and no `key`; `children`
is the full node union, so sections nest and an "Other" section can hold whole patch subtrees.
Without a plan no section arises anywhere, and the returned request is exactly what the walk
alone built.

**Opt-in governs what the tree _contains_, not the type.** The widening reaches every host's
types even when no plan is passed: an exhaustive switch over `ReviewNode` stops compiling whether
or not the option is used. That is the accepted cost of keeping the tree the single rendering
channel — a host renders sections with no second structure to reconcile — and it is also the
opt-in signal made visible. `emptyCollectionPaths` descends into section nodes, so
`resolveReview`'s empty-collection write is unchanged.

**Order comes only from the plan's records and the walked schema.** The extraction schema's
declaration order is unrecoverable at layout time: the option type deliberately does not carry
it, the mapping derivation inserts its entries by walking the _patch_ schema's leaves
(`shape-operations.ts`, derivation step 11), and the applier appends moved structure to its
containers (`shape-moves.ts` `insertAt`), so a moved child's extraction-side declaration order
does not survive into the plan when an operation's moves are declared out of patch order. Each
record carries exactly one order — its enumeration order — and enumeration order breaks every
tie: untouched children keep their patch positions, sections and moved-in leaves append after the
surviving patch children of their container, and a leaf no entry names falls to "Other" in
schema-declaration order, the only order left. For a plan whose operations were declared in patch
order — the common case — the rule reproduces the extraction schema's order exactly.

**"The partition record's label order" is its enumeration order, integer-like labels included.**
Partition validation refuses empty, reserved, duplicate and empty-list parts but not
integer-like labels (`shape-operations.ts`), and a record's integer-like keys enumerate first,
ascending, in JavaScript regardless of insertion order — the insertion order is unrecoverable in
principle. The layout reads the record the language reads it; skipping integer-like labels and
appending them would manufacture an order the record does not carry.

## Consequences

**Layout only, verbatim leaves.** `fields`, every `FieldPath`, `resolveReview`'s classification
and the write are identical with and without a plan; a leaf inside a section is the same object
`fields` holds at its unchanged patch path. The tree/fields order agreement — the tree built by
the same walk in the same order — now holds for the no-plan layout only; with a plan the tree
presents the plan's order over the same leaves, and `fields` keeps its declaration order.

**The compile break is the announcement.** Hosts that switch exhaustively over node kinds break
at compile time on a minor version, whether or not they pass a plan. Walkers that treat the last
kind by fall-through break too, since a section lacks the collection fields they read — that is
how typecheck found every in-repo site.

**The plan's quiet degrade is deliberate silence.** An unknown group or field in the plan is
ignored — no throw, no report — because the plan is presentation input over an already-validated
request, and the exactly-once invariant holds by construction: a moved leaf is pruned before it
is placed. The one loud failure is a plan path that is not schema-time data (bracketed, empty),
which no derivation can produce and no quiet degrade should paper over.

**ADR 0034's cut stays cut — for everything but review's presentation.** A partition still
changes no schema, no mapping and no identity, and the merge and write-back still never see it.
Review is the one consumer that can: only in a plan-laid-out tree does the partition cut become
visible, and only because the host handed the record back as the plan.
