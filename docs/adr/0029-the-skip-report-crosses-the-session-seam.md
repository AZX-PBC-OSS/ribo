# 0029. The skip report crosses the session seam

Status: Accepted
Date: 2026-09-25

## Context

ADR 0026 put `skippedItems` on `ExtractionResult` and stopped at the seam.
`toSessionExtractStep` forwards `fields`, `engine`, `usage` and `statedEmptyGroups` — not the
skip report — so an application driving extraction through the relay cannot see which items a
skip policy gave up on. The data cannot carry the difference an abstained value makes: the
engine-written abstention parses exactly like a genuine model abstention, so a review screen
renders "we asked about the water heater and the call failed" identically to "the auditor never
mentioned a water heater". A consuming field app had built the whole path itself — an app-owned
RxDB collection, a decorator at the one seam that knows both the session id and the full
`ExtractionResult`, an async load in the review screen — and every defect found in that
machinery lived in its empty/absent path.

`statedEmptyGroups` already solves this shape of problem end to end: a step-result member,
persisted as its own session field, consulted by `buildReviewRequest` to produce a group state.
This decision is the second instance of that pattern, not a new mechanism.

## Decision

**`skippedItems` crosses the seam as a session field, and reaches review as a flag on the tree
— not as a new `ReviewGroupState`.**

- **The seam.** `ExtractStepResult.skippedItems` forwards `ExtractionResult.skippedItems`
  unchanged. Absent and `[]` keep their ADR 0026 meanings across it.
- **Persistence.** The session document gains `skippedItems` — typed (the members are core's
  own `PhaseUnit` vocabulary, not host data, unlike `extractionUsage`'s loose record), optional,
  and **set unconditionally on every extraction** like `statedEmptyGroups`: it is content about
  a specific transcript, so a re-extraction clears a prior run's stale report. The sessions
  schema bumps **v2 → v3** with an identity rung. The bump is required even though the field is
  optional and no stored document needs transforming — the DB6 refusal takes the whole open
  down with it, which this repo has now paid for twice and recorded in every rung's reason.
- **Review.** `buildReviewRequest` gains a `skippedItems` option; the walk sets `skipped` on
  the top-level collection or object node, and each of its instance nodes, that a reported
  item's coordinates name — an item names a top-level group, so a nested collection sharing
  its key is never marked. `useReview` passes the session's field through, so a host needs nothing new
  to get it.

### Why a flag and not a `ReviewGroupState`

The `ReviewGroupState` family answers **how many instances exist**: `absent`, `empty`,
`statedEmpty`, `populated`. A skipped item does not answer that question — a group with one
skipped fill of two is still `populated`, and a group whose _presence_ fill was skipped can
still be `"empty"`. The two axes are independent, so a state that folded them in would double
its values to say no more than a flag says. A new state would also be a breaking change for
anyone exhaustively switching on it, which the precedent (`"statedEmpty"`) paid once because it
_replaced_ a state with a better reading of the same question; here it would buy nothing.

The flag rides the tree rather than a separate list for the same reason `"statedEmpty"` does:
the join is non-trivial (fill coordinates are `(group, piece, instance)`; an item's 1-based
`instance` maps to the review key `k{n}`), and a fact split across two collections is a bug
every host gets to write independently.

### What the report cannot say

Leaf-level attribution is deliberately not attempted. An item covers a _piece_ of an
instance's leaves, and the piece partition exists only during extraction — the persisted report
carries the part number, not the leaf set, so mapping it to leaves would lie. `skipped` on an
instance means "some ask covering this instance failed"; a subset of its leaves may still be
genuinely extracted. Items naming the empty key (the flat fallback, `gapFillPhase`) are
attributable to nothing and mark nothing.

### The grouped-tier gap, stated for consumers

`groupedExtractor` cannot report skips: its entries are single chat calls with no skip policy,
so a tier built on it produces a result with the field absent. In a `fallbackExtractor` ladder
where a phased tier 1 falls through to a grouped tier 2, the session's report is absent even
though the session was extracted. The practical reading, and the reason this is tolerable
rather than deferred: a grouped tier's failures are loud (no skip policy means a failed item
fails the run and the relay retries), so it cannot have skipped silently. **Absent means "the
tier that produced these fields could not have skipped silently"; `[]` means "reports and
nothing was skipped".** A review screen that wants to distinguish "verified clean" from
"cannot tell" reads the session field's presence; the tree's flags are false either way, which
is the honest rendering for both.

Staleness stops being the consumer's problem. The relay writes the field on every
extraction, so a tier-2 run's absent report replaces a tier-1 run's stale one; a consumer with
its own skip record deletes it outright rather than porting its clearing logic.

## Consequences

- A consumer app driving extraction through the relay deletes its workaround: the report is on
  the session document and on the review tree.
- **Every consumer must take the v3 sessions migration.** An older bundle that opens a v3
  database fails loudly at open (downgrades refuse, by design), so the field app and the library
  must move together.
- `ReviewObjectNode`, `ReviewCollectionNode` and `ReviewInstanceNode` each gain a required
  `skipped: boolean`. Code constructing these nodes by hand must set it; code consuming them is
  unaffected — no node kind changed, and `ReviewGroupState` did not grow.
- The gap is recorded, not fixed: `groupedExtractor` reporting skips remains a separate,
  larger question (ADR 0026's non-goal, unchanged).
