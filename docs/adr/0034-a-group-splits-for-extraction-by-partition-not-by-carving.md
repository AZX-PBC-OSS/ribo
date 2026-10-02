# 0034. A group splits for extraction by partition, not by carving new groups

Status: Accepted
Date: 2026-10-02

## Context

Partition's first design widened `nest` instead: move fields out of a group into new top-level
groups (`thermostat` out of `basedata`, `hvacCooling` out of `hvac`), so each topic became its own
call the way any size split does. For object groups that is sound. For collections it breaks
properties that assume one collection is one top-level key, all verified against source:

- **Identity.** The inventory phase reads `roster[group.key]` and seeds any key the roster lacks
  with an empty array (`inventory-phase.ts`) — the roster has no `hvacCooling` entry, so a carved
  group gets no instances and its fields are silently lost.
- **Alignment.** Reversal's length check guards one patch path only (`shape-reverse.ts` refuses
  two mapping entries that wrote different-length arrays to the same path); the patch's fields
  are optional, so a count mismatch between `hvac` and `hvacCooling` parses — mispaired, silently.
- **Stated-empty.** Its passthrough in `reshapedExtractor` is sound only because a nest never
  creates a collection.
- **Skipped items.** A skipped item reverses to the patch keys its group's leaves map to
  (`shape-skipped.ts`) — for a carved instance, the whole source group.

Each is fixable, but every fix rebuilds what the size split's pieces already have: pieces share
their key, so they share the inventory's instance list, merge by position within one key
(`fill-phase.ts` writes `arr[job.instanceIndex]`), and report a skipped item with its part.

## Decision

**A group splits for extraction by `partition`, which names its parts — and the group keeps its
key.** Partition is a shape operation whose parts are labels, each naming the group's direct
fields; the schema split cuts the group's calls along the parts and carries each part's label into
the call's prompt. Nothing else moves: the extraction schema, the patch and the mapping are
untouched, so identity, the merge, review and write-back see one collection exactly as before.

## Consequences

**Parts share key and identity.** The inventory, the position-indexed merge, stated-empty and the
skip report all keep working unchanged, because the cut never leaves the group. An oversized part
still splits by size inside itself, under the one label.

**A narrowed call must be told what it cannot see.** A real-model smoke run showed a part's call
filing facts into the nearest visible field when their own field sat in another part (one
transcript's hard hallucinations 3 → 7). Each partitioned call therefore names the group's fields
other calls cover and says to leave their facts out; with that, the smoke run matched the
unpartitioned baseline. The cost of partitioning is not only calls.

**`nest` is unchanged.** It stays the way a flat schema gains structure. Partition addresses the
caller's own groups — a nest-created group is refused, and a partitioned group cannot also be
regrouped, since its paths would mean two things.

**Carving is recorded as rejected.** The breaks above are why; a future design that wants
topic-level groups for collections must first give them identity, which is the piece machinery
partition reuses rather than duplicates.

Design: `docs/roadmap/design/group-partition-and-batched-fill-design.md` §2.
