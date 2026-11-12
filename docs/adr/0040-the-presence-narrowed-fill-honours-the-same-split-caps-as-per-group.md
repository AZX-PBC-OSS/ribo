# 0040. The presence-narrowed fill honours the same split caps as per-group

Status: Accepted
Date: 2026-11-13

## Context

The presence-narrowed fill (`presenceFillPhase`) was built from `perGroupPlan`'s per-piece
construction but never partitioned: it projected each present group's narrowed target and sent
exactly one value-extraction call per group. `perGroupPlan` honours
`maxNullableUnionsPerGroup` and `maxSerializedCharsPerGroup` and splits an oversized group across
calls (`splitExtractionSchema`). So under a byte-capped route — the Helix vendor cap of 32,768
serialized characters on the real Snugg Pro schema — the per-group path splits `basedata` into
pieces that fit, while the presence path sent basedata's narrowed target as ONE call whenever
enough of its leaves were present, over the cap, and the route refused it with the same 400 every
over-cap schema gets. `ribo schema inspect`'s `presenceNarrowedAtMost` bound mirrored the defect:
it reported `2 × groupCount`, resting on the one-call-per-group assumption.

The alternatives each fail:

- **Enforce the cap at the transport or adapter.** The adapter only supplies the cap number; the
  split is core's, and the fill was the one strategy that bypassed it. Rejecting an over-cap
  request at the transport turns a recoverable partitioning decision into a failed extraction.
- **Split the FULL schema at construction and intersect with presence at plan time.** The fill's
  requests must narrow to the active leaves — that is the strategy's point (ADR 0027) — and
  intersecting the split's pieces with the presence map reintroduces a second partitioner whose
  boundaries can drift from the split's.

## Decision

**The fill narrows first, then splits the narrowed schema through the same
`splitExtractionSchema` call `perGroupPlan` uses, under the same two options with the same
defaults.** `PresenceFillPhaseOptions` gains `maxNullableUnionsPerGroup` (defaulting to
`MAX_NULLABLE_UNIONS_PER_CALL`, the union cap always on, exactly as `perGroupPlan` defaults it)
and `maxSerializedCharsPerGroup` (pass-through, off when absent). `plan` projects the group's
active-leaf target and splits that one-key schema, emitting one item per piece; `run` builds each
piece's request with the plan's `-<part>` name suffix and leaf-narrowed examples;
`merge` regroups a group's pieces and recombines them into the entry the seed created. Narrowing
runs BEFORE the split, so a group with few present leaves still costs one call, and an all-present
group's pieces are byte-identical to the pieces `perGroupPlan` would partition that group into —
same splitter, same caps, same per-key packing.

## Consequences

**One item per piece, not per group.** Piece granularity buys per-call failure isolation under
`onItemFailure: "skip"` — a failed piece nulls only its own leaves, which the seed's floor already
holds — and per-call progress units, whose `describeItem` now carries the `part`/`parts` quartet
the other fill phases report. An unpartitioned group's single piece carries no part, so its skip
report and unit events are byte-identical to what a per-group item emitted.

**The merge is total by construction, not by piece count.** A flat group's pieces assign their
disjoint leaf subsets into the seeded entry. A collection group's pieces each answer for the
ARRAY — presence decides which leaves, never how many instances (spike 0012) — so the merge zips
them by instance index, the longest answer deciding the count and a shorter piece's missing
instances staying at the null floor. An empty answer still leaves the seed's one null instance in
place, and an all-pieces-failed group still reads as the nulled seed.

**The inspect bound moves with the fix, derived from the split's own pieces.**
`presenceNarrowedAtMost` is now `groupCount` presence calls plus the split's grouped-piece count
under the reported caps (the unwrapped `""` pieces excluded — the fill only walks groups), read
off `describeExtraction`'s pieces rather than re-split; a single-shot schema fits whole, so every
group is one piece and the bound is the old `2 × groupCount`. A construction refusal leaves no
bound to report: the fill would throw where `perGroupPlan` does. The JSON contract's shape is
unchanged, so `contractVersion` stays at 3.

**The union cap's default is now load-bearing on the fill path too.** A group over 16 nullable
unions partitions even when the caller supplied no caps — the behaviour `perGroupPlan` has always
had, and the point: the fill is no longer the one strategy that could send a schema the managed
route's model family refuses.

**The splitter's refusal is rehearsed at construction.** `perGroupPlan` refuses a schema whose
single leaf cannot fit any piece when it is built; the fill's split runs in `plan`, after the
presence calls are paid for, so a late throw there would be the worst kind of failure. The fill
therefore runs the all-present split once at construction and discards it: the refusal is
per-leaf, and a leaf subset can only pack into fewer or finer pieces than the full set, so a
construction that passes cannot throw mid-run.
