# 0026. A skip is reported per item, on the result

Status: Accepted
Date: 2026-09-24

## Context

`onItemFailure: "skip"` (#93) lets a failed phase item abstain instead of failing the run. The
abstained value is `{ value: null, confidence: 0, sourceSpan: null }`, which is also a legal model
answer about a leaf nobody mentioned. That sameness is what makes it parse, and it means the data
cannot carry the difference. A review screen showed a group whose fill failed the same way it
showed a group the auditor never mentioned. Only the engine knew which was which, and the result
did not say.

The observer's error units carry the item's coordinates, but that is live telemetry. Review
happens later, against a persisted session.

## Decision

**`ExtractionResult.skippedItems` lists every item a skip policy gave up on, one entry per phase
item.** An entry is the phase id plus the item's `describeItem` coordinates, the same members a
`PhaseUnit` carries. For `fillPhase` that is `(group, instance, piece)`, not the group.

The finer granularity is deliberate. A group can be read as coarse as you like from the item
list, but the item list cannot be recovered from a group-level report. A collection with one
failed instance of two differs from one where both failed. The consuming UI marks a section, and
it needs to know whether the whole section or only part of it abstained.

The rest of the decision:

- **It is a sibling of `usage`, not part of it.** `usage` is cost, and combinators sum it; a list
  of items does not sum. Skipped items travel like `statedEmptyGroups`.
- **Empty and absent mean different things.** `phasedExtractor` always sets the member, so `[]`
  means "reports, nothing skipped". An extractor with no skip path (single-shot, schema-retry,
  `FakeExtractor`) leaves it absent. A combinator over several results is present when any
  constituent reported.
- **It names the ask that failed, not the value.** A merge decides what a failed item means for
  the fields. For `fillPhase` that is usually an abstention, but a narrowed re-ask that fails keeps
  the earlier answer and is still reported. The consumer's message, "we asked and could not get
  it, check this", is true either way.
- **Composition keeps it.** The pass-through combinators already did (fallback, race, hedged,
  retry, timeout, budget, validate, corroborate), because they return or spread the accepted
  result. The ones that rebuild a result now carry it:
  - `groupedExtractor` concatenates its entries' reports in schedule order.
  - `extractorPhase` lifts an inner run's report onto the draft, and the outer engine appends it.
  - `consensusExtractor` unions its survivors' reports, unlike `statedEmptyGroups`, which it drops.
    One survivor's abstention is enough to contest a leaf, so its skip explains a null. When a
    policy accepts another survivor instead, the union over-reports, which is the safe direction.
  - `reshapedExtractor` translates keys back to the patch. A nest group becomes the patch keys it
    feeds, and a regrouped leaf is re-pathed.
- **`cachedExtractor` does not store a result that skipped anything.** Replaying the abstentions at
  `calls: 0` would turn one transient failure into a permanent one, the same reason rejections are
  not cached.

## Consequences

- A live consumer and a persisted one name an item the same way, so a host can join the report to
  its observer log.
- **The report does not reach the session yet.** `toSessionExtractStep` forwards `fields`,
  `engine`, `usage` and `statedEmptyGroups`. Persisting `skippedItems` is a sessions-schema change,
  which needs a version bump and a migration strategy. It is the next step for the consuming
  review screen, and it is deliberately not part of this decision.
- A phase without `describeItem` reports `key: ""`. A skip-policy phase that wants a useful report
  needs `describeItem`, just as it does for a useful progress stream.
