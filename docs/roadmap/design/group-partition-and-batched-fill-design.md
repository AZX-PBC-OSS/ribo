# Partition a group for extraction, and fill a collection's instances in one keyed call

**Date:** 2026-10-02
**Status:** Designed, not built.
**Question answered:** How can a large group be extracted in calls that each look at one coherent
topic, and how can a collection's instances be extracted together without relying on the model to
order them the same way twice?
**Depends on:** the shape operations and applier (`shape-operation.ts`, `shape-operations.ts`,
`shape-moves.ts`), the schema split (`split-schema.ts`, `merge-group-pieces.ts`), the
scoped-instance path (`inventory-phase.ts`, `fill-phase.ts`, `instance-fill.ts`,
`inventory-types.ts`), the per-group strategy (`per-group.ts`), the proposer and its resume loop
(`operations-proposer.ts`, `proposal-commit.ts`, ADR 0032; this branch builds on
`proposer-resume`, PR #100).

---

## 1. The answer, before the argument

**Two changes, designed as a pair.**

- **`partition`**, a new shape operation, names a group's parts — `hvac` into `system`, `heating`,
  `cooling`, `ducts`, `improved`; `basedata` into `house`, `thermostat`, `foundation`, … Extraction
  never mixes two parts in one call. The group keeps its key, so identity, the merge, review and
  write-back are untouched.
- **Batched fill**, a new phase kind, extracts one part for **every** instance of a collection in
  one call, after the inventory has listed the instances. Each returned instance carries its
  roster id, enforced by the response schema, and is merged by id — so the order the model
  answers in no longer matters.

Together: one call per part, covering all of a group's instances, merged by id.

## 2. Why not carve new top-level groups

The first design widened `nest` to move fields out of a group into a new top-level group
(`thermostat` out of `basedata`, `hvacCooling` out of `hvac`). For object groups that is sound. For
collections it breaks four things that assume one collection is one top-level key, all verified
against source:

- **Identity.** The inventory reads `roster[group.key]` (`inventory-phase.ts`); the Snugg roster
  has no `hvacCooling` key, so a carved group gets no instances and its fields are silently lost.
- **Alignment.** Reversal writes element-wise with no length check (`shape-reverse.ts`), and the
  patch's fields are optional, so a count mismatch between `hvac` and `hvacCooling` would parse —
  mispaired, silently.
- **Stated-empty.** Its passthrough in `reshapedExtractor` is sound only because "a nest never
  creates a collection".
- **Skipped items** for a carved instance reverse to the whole source group (`shape-skipped.ts`).

Each is fixable, but every fix rebuilds what the size split's pieces already have: pieces share
their key, so they share the inventory's instance list, merge by position within one key
(`merge-group-pieces.ts`, `fill-phase.ts` writes `arr[job.instanceIndex]`), and report a skipped
item with its `part`. Partition reuses pieces; the cut just follows meaning instead of size.

## 3. What was decided, and by whom

Decided in conversation before this design was written:

- **Partition, not carving.** Parts share the group's key.
- **The proposer writes the labels**, and the label reaches the extraction call.
- **Both changes in one spec**, as a pair.
- **No accuracy gate.** Partition is justified semantically; a real-model smoke run confirms it
  works, nothing more (§8).
- **The fill mode is a host rule by instance count**, default per-instance (§6).
- **Presence per part is out of scope** (§9).

## 4. The `partition` operation

- **Shape:** `partition { group, parts: { <label>: [<field>, …], … } }`. `group` is a top-level
  object group or collection of the caller's schema. Fields are the group's direct field names —
  its element's, for a collection — in the original schema's space. Labels are the proposer's.
- **Effect:** extraction for the group never mixes two parts in one call; within a part the size
  split still applies, so an oversized part becomes several calls under one label.
- **Nothing else changes.** The extraction schema and the mapping are byte-identical with and
  without a partition. The derived shape gains a `partitions` record —
  `{ hvac: { heating: [...], cooling: [...] } }` — in extraction-schema space, which for a
  partitioned group is the caller's own names, so the record is written as given: partition and
  regroup cannot share a group, and nest takes only top-level fields. The schema stays flat: encoding parts as
  sub-objects would cost nesting depth, and Helix's depth cap already binds the per-group pieces.
- **Remainder.** A group field not named in any part goes to one implicit remainder part, so
  nothing goes unextracted.
- **Fields are the group's direct fields** — one segment, the group's (or its element's) own
  properties. The split cuts a group's properties; it cannot carve inside a sub-object, so a
  deeper path is refused rather than silently served wrong.
- **Refused**, each with a reason the proposer is told:
  - two partitions on one group (`set`);
  - a group that is not an object group or collection — a top-level leaf rides the split's loose
    portion and would be silently ignored;
  - no parts, or a part with no fields;
  - a field in two parts, a field that is not a direct leaf of the group, or a field under an
    applied drop (`consequential`, the drop named as cause, as `retype` does);
  - an empty or duplicate label within the group, or the reserved label `remainder`;
  - a group at "row" or "none" provenance (one quote per row cannot be shared across calls);
  - a group that a `nest` creates (partition addresses the caller's groups; a nest group's layout
    is the proposer's to choose already);
  - a group that a `regroup` also restructures (`set`: paths would mean two things).
- **Composes with** retype, and with drops of fields it does not name.
- **The part is the unit of both halves of the pair.** Under per-instance fill: one call per part
  per instance. Under batched fill: one call per part for all instances. An unpartitioned group is
  one part.

## 5. Parts reach the calls

- **The split.** `splitExtractionSchema` gains a `partitions` option. A partitioned group is cut
  along its parts first, in the order the parts are listed, then by size within each part.
  Pieces keep today's numbering across the whole key (`part` 0…n−1, `parts` n), so the merge,
  request names and skipped-item reporting are unchanged. `ExtractionGroup` gains an optional
  `label`.
- **The label in the prompt.** Every call for a labelled piece gets one line from core: "This call
  covers the _heating_ fields of _hvac_." The same line under per-group, per-instance and batched
  fill. Adapter instructions stay keyed by group.
- **The fields other calls cover.** The same line names the group's fields this piece does not
  ask for (`ExtractionGroup.elsewhere`) and says to leave their facts out. Added after the Helix
  smoke run (2026-10-02, `gpt-5.6-luna`, three corpus transcripts): without it a narrowed call
  pushed facts into the nearest field it could see — a model number copied into an indoor-model
  field, a manufacturer into a name field — and one transcript's hard hallucinations went 3 → 7.
  With it, partitioned runs matched the unpartitioned baseline's hallucination and correct counts
  on all three transcripts, one sample each. It is r1.6's negative-sibling remedy applied to
  fields.
- **Plumbing.** `schemaExtractor`, `perGroupExtractor` and the scoped-instance extractor accept
  `partitions` and pass it to the split. Composing a proposed shape becomes
  `schemaExtractor({ extractionSchema: shape.extractionSchema, partitions: shape.partitions, … })`,
  wrapped by `reshapedExtractor` as today.
- **Partitions force the per-group path.** `schemaExtractor` chooses one single call when a schema
  fits under the caps; a partitioned group goes per-group instead, since one call would mix parts.
- **Presence-based strategies** (on-device three-phase, System One) ignore partitions: they already
  work field by field.

## 6. Batched fill

- **A new phase kind, `batchedFillPhase`**, an alternative to `fillPhase` after the same inventory
  phase. It reads the roster note as `fillPhase` does and declares that through `requires`.
- **Plan:** one item per (group, piece) — per part, or per size piece within a part. A collection
  with no current instances (stated-none or empty) plans nothing.
- **Response schema, built at call time:** an array whose element is
  `{ instanceId, …the piece's fields }`, `instanceId` an enum of this transcript's roster ids
  (`hvac-1`, `hvac-2`, …). The model cannot return an id the roster lacks.
- **Prompt:** lists the identities from what the inventory already returns — id, `mentionSpan`,
  `discriminator`, `distinguishedBy` — and the not-current candidates as out of scope, as the
  per-instance scope block does. The label line of §5 applies.
- **Strict validation:** every roster id appears exactly once. A missing or duplicated id fails the
  item, retryably; the engine re-runs the same item (its messages are built at plan time), so the
  retry is a re-send and the reason is reported on the unit stream's error event, not in the
  request. Feeding the reason back would mean changing the engine's retry ownership — out of
  scope. At exhaustion, with `onItemFailure: "skip"`, the item is skipped through the existing
  skip machinery: a skipped item naming the group and part with no instance, and the part's
  fields abstained on every instance (derived from the piece's element schema), so the array has
  no holes.
- **Merge by id:** each element is written at its instance's roster position and merged with the
  instance's other pieces (`mergeGroupPieces`). `instanceId` is stripped before writing. Reply
  order does not matter.
- **Choosing the mode.** The scoped-instance extractor gains
  `fill: "per-instance" | "batched" | { batchAbove: N }`, decided **per group at plan time** from
  the roster's current-instance count: `{ batchAbove: 2 }` is per-instance for one or two instances
  and batched for three or more. The default is per-instance, so existing hosts' requests and
  fields do not change; the instance ladder's tier 1 can take either. The mode each group used is
  recorded on the result as an additive, non-persisted `fillModes` field, forwarded by
  `reshapedExtractor` so the documented composition carries it. The
  per-group choice is a plain value so that a future planner can set it per group (§9).
- **Composes with** gap-fill after it (it addresses fields by indexed path) and with row-provenance
  collections (each element carries its own row quote).
- **Calls.** `hvac` with five parts and two systems: batched 5, per-instance 10. One system: 5 and 5. The saving grows with instance count; the cost is isolation — one call sees every instance,
  where per-instance keeps siblings out of scope. That trade is unmeasured, which is why the
  default stays per-instance.

## 7. The proposer

- **Wire branch:** `{ op: "partition", group, parts: [{ label, fields: [...] }] }` — an array of
  pairs rather than a record, because the Helix structured-output route rejects records (the same
  reason `moves` is pairs). Converted to the record form before the applier.
- **Directive:** a bullet — partition splits a large group's fields into named parts, each
  extracted in its own call; use it where a group's fields fall into distinct topics (heating vs
  cooling, thermostat vs foundation); labels short and descriptive; a field in at most one part;
  unlisted fields form a remainder part — and composition lines: at most one partition per group;
  a partitioned group cannot also be regrouped.
- **Resume loop:** the commit rule keys a partition by its group and `formatOperation` labels it
  `partition "hvac"` (both the existing default); the in-progress field list tags a committed
  partition's fields `[part: heating]`, read from the shape's `partitions` record.

## 8. Tests and checks

Each test written to fail first.

- **Applier:** one test per rule in §4; composition with drop, retype, regroup and nest; the record
  in extraction space; the remainder part; extraction schema and mapping deep-equal with and
  without a partition.
- **Split:** cut along parts, then by size; no piece mixes parts; an oversized part splits inside
  itself; collection parts cut within the element; numbering and labels.
- **Prompt:** the label line under per-group, per-instance and batched calls.
- **Batched fill:** the `instanceId` enum is the roster's ids; the prompt lists the identities; a
  missing and a duplicate id each fail and retry; exhaustion yields a part-level skipped item with
  abstained fields on every instance; shuffled replies merge onto the right instances;
  `instanceId` never reaches the output; stated-none plans nothing; `batchAbove` chooses per
  group; the mode is recorded.
- **Proposer:** the wire schema accepts a partition and converts it; the directive bullet; the
  `[part: …]` tag on a resume turn; the commit rule.
- **Through the real pipeline** (scripted chat): propose a partition → derive → scoped-instance
  extractor in batched mode with a roster → `reshapedExtractor` → review sees `hvac[0]` and
  `hvac[1]` with every part's fields on the right system, including when one part's reply lists
  the systems in reverse order.
- **Mutation checks after the build:** merging by position instead of id; dropping the
  exactly-once check; the split ignoring part boundaries.
- **Real-model smoke run, not a gate:** a few corpus transcripts with an `hvac` partition through
  batched fill on Helix — the call counts are as predicted, and no field the unpartitioned run
  fills comes back empty.

**Records:** two ADRs, one decision each — "a group splits for extraction by partition, not by
carving new groups" (§2's reasoning), and "collection fill can batch instances, keyed by roster
id" (§6). Numbered after a fetch, skipping the unpushed hint branch's 0033. The guide; changesets
for `@azx/ribo-core` (minor).

## 9. Out of scope

- **Presence per part.** A part is a sharper presence question than a group ("anything about
  cooling?"), and a skipped part is one call. Spike 0011 measured group presence at 42.9% of calls
  removed with no group lost, robust across thresholds 0.30–0.50; seeding first keeps skipping
  sound (ADR 0027). Presence needs System One (`@azx/ribo-extractor-systemone`), so it stays
  opt-in in core; a host turns it on.
- **The proposer choosing the fill mode or a model per group.** The future planner (ADR 0011). §6's
  per-group choice is a plain value so a planner can set it without the phase changing.
- **Read-only context values across parts** — a cooling call seeing the heating call's extracted
  `hvacSystemEquipmentType` value. Each call already names the fields other calls cover (§5) and
  has the transcript and the instance's description. The smoke run's one remaining invented value
  sat in the implicit remainder part, which has no topic; a proposer that names every field in a
  real part avoids it.
- **Carving fields into new top-level groups** (§2).
