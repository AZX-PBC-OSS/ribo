# 0024. The shape applier collects every refusal and applies the surviving operations

Status: Accepted
Date: 2026-09-22

## Context

ADR 0016's one-shot-with-repair proposer feeds the applier's refusal back per turn — but the
applier stopped at the **first** refusal, and refused the whole set all-or-nothing. Measured
against a real 294-property vendor schema (`docs/roadmap/design/nest-live-run-evidence.md` §2): the
model proposed 91 operations, exactly one was invalid — a `retype` naming a leaf the same proposal
dropped — and it cost all 91, including fourteen good nests. The repair turn did not find it and
the run exhausted to `[]`. Worse, the refusal named the **victim** (the retype), not the
**culprit** (the drop), so a repair model reading it could not tell which of the two to retract.
Spike 0009's flat-schema run tells the same story from the other side: 19 regroups, 18 refused, one
repair turn each — and the spike hand-rolled a recovery loop over captured turns, the workaround
every caller of the throwing surface would otherwise write.

## Decision

**The applier collects every refusal in one pass, and a sibling surface applies what survives.**
`deriveExtractionShapePartially(schema, options)` returns `{ shape, refusals }` — a full
`DerivedExtractionShape` built from the surviving operations, plus every refusal found, each
carrying the caller's verbatim operation, its index, its class, and the applier's own message.
Applied and refused partition the input exactly; `refusals` is empty if and only if the artifact is
what `deriveExtractionShape` returns, because the throwing function is now a thin wrapper that
throws the canonically-first refusal's reason — byte-identical for every single-refusal set, which
is every case the pre-existing suite pins.

**Refusals are classified by what they are defeasible against.** `local` — defective against the
schema alone. `consequential` — defective only because an applied operation removed or occupied the
target, with `cause` naming that operation (or the caller's declaration, when the conflict is with
`requiredOnCreate` / `identifyingFields` / `provenance` — the declaration is the invariant, the
operation takes the refusal). `set` — no single operation is defective (duplicates; a doubly-claimed
nest source; drops that together empty an object), and the applier does not pick a member to blame.
The hard boundary is unchanged: schema defects and declaration defects no applied operation explains
still abort the derivation — no operation subset repairs them, so no partial artifact can exist.

**Drops are validated declaratively, not by sequential mutation** — existence against the pristine
schema, then declaration coverage, then emptiness computed set-wise, then nesting outermost-first.
This fixes a live order-dependence the throwing applier had: `drop "a.b"` before `drop "a"` applied
both, and after it threw not-found — a violation of the documented set contract. Nests are the one
pass that iterates: a nest group may take a name another nest frees, so a refused nest can un-free a
sibling's name — re-validation to a monotone fixed point, bounded by the nest count, not a fixpoint
over refusal batches.

**Amendment to ADR 0016: at repair exhaustion the proposer returns the final proposal's surviving
operations, not `[]`.** The `[]` default was argued as "keep the pipeline open with an unshaped
derivation"; the surviving subset is the same property, held more often and more fully. `[]` remains
when nothing survives, and on the two transport-exhaustion exits, where no proposal arrived to
partially apply. The repair turn itself now carries every refusal at once — one line per refusal,
each the applier's own message prefixed with the operation it names — so N bad operations cost one
repair turn, not N.

## Consequences

**The repair economics change.** A large proposal has as many chances to contain one bad operation
as it has operations; all-or-nothing made the cost of one the whole set. Now the whole refusal list
arrives in one repair turn and, at exhaustion, the mostly-good proposal mostly applies. The
89-survivors-of-91 outcome no longer looks like `[]`.

**The cost, stated plainly: the `[]`-check diagnostic weakens.** ADR 0016 documented that a host
surfaces proposer failure by checking the operations array for `[]`; a surviving subset of 89 out of
91 does not announce itself. Accepted (the design's open question 1): the collect-all repair turn
makes exhaustion-with-refusals rare, and a result-carrying proposer return is a breaking change to
make when a host actually needs it.

**Multi-refusal sets may throw a different refusal than input order used to reach first.** The
canonical order — class, then operation kind, then path or group, then index — decides, not
discovery order. That is the determinism fix, not a regression: the operations are a set, and the
set now has one answer. (One deliberate exception: a collision message that names a _pair_ of moves
within one operation keeps the moves' record order — a pinned message the canonical order would have
reversed.)

**The refusal record is prose plus structure, not codes.** `reason` is the applier's own message —
the repair turn consumes prose; a host auditing refusals branches on `class` and `cause`. Machine
codes wait for a second consumer (the same no-special-formatter rule ADR 0016 set).

Design and the full rejected-alternative tour:
`docs/roadmap/design/shape-partial-application-design.md`.
