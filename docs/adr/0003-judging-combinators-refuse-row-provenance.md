# 0003. Judging combinators refuse row and none provenance at construction

Status: Accepted
Date: 2026-09-17

## Context

`validateExtractor` and `consensusExtractor` both work by walking **per-leaf** provenance
envelopes: one `{ value, confidence, sourceSpan }` per leaf is what makes a grounding census or a
leaf-by-leaf comparison possible at all.

A group declared at `"row"` granularity carries one span for a whole row; `"none"` carries no
provenance. Pointed at either, the leaf walk finds nothing to judge — and the failure is silent in
the worst possible way. The combinator returns a result that has been through validation or
consensus and looks judged, while nothing was actually compared. A host would read a clean verdict
as evidence of quality on precisely the data nobody checked.

## Decision

Both combinators call `assertLeafGranularity(target.extractionSchema)` **at construction**, before
any call is made, and throw naming the offending group.

The check is recursive over arrays, optionals, nullables and nested objects — a one-level unwrap
rejects legitimate schemas such as `z.array(z.string())`, which becomes an array of envelopes.

## Consequences

The failure mode moves from "silently judges nothing" to "refuses to be built", which is the right
trade: construction happens once, at wiring time, where a developer sees it, rather than per
extraction in production.

The cost is real scope loss. If the targets people actually run are mostly row granularity, this
refuses the majority of real work, and extending the walk to row provenance would have been the
thing to build instead. That is recorded as one of the ways this sub-project could be wrong, and no
measurement currently says which way it falls.

See `docs/roadmap/design/sp2-judging-combinators-design.md` §4.5 and §8.
