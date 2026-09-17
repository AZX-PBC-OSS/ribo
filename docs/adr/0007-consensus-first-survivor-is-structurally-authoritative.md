# 0007. Consensus takes its structure from the first survivor and drops what only others produced

Status: Accepted
Date: 2026-09-17

## Context

`consensusExtractor` compares survivors leaf by leaf, which requires enumerating leaves. Candidates
can disagree **structurally** — two samples can differ on how many instances a collection group
holds — so "which leaves exist" is itself contested, before any value is compared.

Two options. Walk the first survivor, or enumerate the union of paths across all survivors. The
union is the intuitive reading of "a path present in fewer samples than survived is contested", but
it materialises a hallucinated instance into the output as a nulled row — putting a phantom unit in
front of a human reviewer, which is worse than omitting it.

Comparison is by **position**, which quietly assumes every candidate enumerates instances in the
same order. Nothing enforces that, and a sample that dropped an interior instance shifts every index
after it, so position-wise comparison pairs different physical entities.

## Decision

Walk the first survivor. Then, in order:

1. A survivor whose array is **shorter** than the first survivor's, at any array on the path,
   contests every leaf under that collection without consulting the arbiter. Shorter, not merely
   different: a _longer_ survivor is not misalignment, since the shared indices still pair
   like-for-like and its extras never enter the walk.
2. A path missing from any survivor is contested, arbiter not consulted.
3. Otherwise the arbiter decides.

Paths that exist only outside the first survivor's structure are dropped. Callers are told to put
their most trusted candidate first.

## Consequences

Nothing fabricated reaches a reviewer in either ordering, and rule 1 stops `majorityValues`
accepting a value for an entity that a sample does not have — a case where the majority would
otherwise win with a citation quoting a different unit.

The costs, both real:

- **The output's shape is the first candidate's shape.** A caller who orders candidates carelessly
  gets a different structure than one who does not.
- **The contested count under-reports, in one direction.** A candidate that invents an extra
  instance is caught when placed first and silently dropped otherwise — the walk never visits it, so
  no contest fires and `onContested` never reports it. A host must not read "zero contested" as "the
  candidates agreed on how many there are."

Equal-length reordering defeats rule 1 entirely and no rule here fixes it. `unanimousValues` fails
safe under reordering and is the default for that reason; `majorityValues` ships beside it and does
not. The real fix is content-addressed instance matching — a design question (what identifies an
instance?) rather than an implementation one — and is deliberately out of scope.

See `docs/roadmap/design/sp2-judging-combinators-design.md` §4.1 and §8.
