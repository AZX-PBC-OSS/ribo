# 0035. Collection fill can batch instances, keyed by roster id

Status: Accepted
Date: 2026-10-02

## Context

After the inventory, the scoped-instance fill made one call per (piece, instance), naming the other
instances as out of scope. The r1.6 instance-extraction design gives the reason: a call with one
slot and a fact that must go somewhere produces the false-but-plausible record — a fact about one
system recorded on another, every field individually plausible — and naming the siblings, with the
assurance that their facts land on their own records, makes `null` correct routing rather than a
loss (its §1 and §5). The cost is arithmetic — five parts and two systems pay ten per-instance
calls where five batched ones cover the same ground — and whether batching keeps that attribution
safety is unmeasured. Batch without identity and nothing ties an element to its system at all.

## Decision

**A collection's fill can ask for every current instance in one call, each element keyed by its
roster id.** `batchedFillPhase` plans one item per (group, piece) after the same inventory phase;
the response schema's element carries an `instanceId` whose enum is this run's roster ids, so the
model cannot name an instance the inventory did not list; every listed id must appear exactly
once, or the item fails retryably and the engine re-sends the same messages; and the merge writes
each element at its id's roster position, stripping the id, so reply order is irrelevant.

## Consequences

**Per-instance stays the default.** The scoped-instance extractor's `fill` option decides per
group at plan time from the roster's current-instance count — `"per-instance"`, `"batched"`, or
`{ batchAbove: n }` — and omitted, the batched phase is not added at all, so the phase list and
every request are byte-identical to before. The mode each collection used is reported on the
result as `fillModes`: additive, and never persisted.

**The isolation trade is unmeasured.** One batched call sees every instance, where per-instance
keeps siblings out of scope; no measurement says what that costs in accuracy, which is why the
default did not move. A real-model smoke run is the planned check, not a gate.

**The per-group choice is a plain value a planner can later set.** `fill` is data, not a
callback; when the agentic layer's planner exists (ADR 0011), it can set the mode per group
without the phase changing.

Design: `docs/roadmap/design/group-partition-and-batched-fill-design.md` §6.
