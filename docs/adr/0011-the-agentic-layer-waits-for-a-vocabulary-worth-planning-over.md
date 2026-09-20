# 0011. The agentic layer waits for a vocabulary worth planning over

Status: Accepted
Date: 2026-09-19

## Context

The last part of the meta-extractor program was a planner: hand it a schema and LLM options and it
composes the strategy itself — a model emitting a phase list, a pure `buildFromPlan`, and drivers
differing only in when planning happens. The machinery is straightforward, and the admission
control already existed: a structured-output enum of the host's registry keys, a zod parse,
`validatePhases`.

Reviewing it against the phases that exist produced two facts that the machinery cannot fix.

**`fillPhase.plan` never reads `draft.fields`.** It reads the roster note, `prepared` and the
transcript. So "fill, then fill again with what the first pass learned" — the strategy used to
justify letting a plan name a phase kind twice — planned identical jobs, and the merge overwrote
the first pass.

**`gapFillPhase` could not declare what it needs.** Its dependency was the shape of `draft.fields`,
which the notes channel could not express, so a plan of `[gapfill]` alone passed every gate.

Together: a planner over those phases could express **subsets and repeats of two linear chains**.
That is the "router over three fixed strategies" the phased-extraction design named as this
program's failure mode, arriving through the front door.

## Decision

Build the vocabulary first; defer the planner.

Shipped instead: the draft-shape dependency as a note key (ADR 0008), so a mis-wired list is
refused at construction; `narrowToAbstained`, so a second fill does useful work; an optional `id`
per factory, so a list can use a kind twice; the phases and chat seam moved to core with an
additive `requires` (ADR 0010), so hosts can compose at all.

## Consequences

**The decision space a planner would get is thinner than when this started, and that is the thing
to weigh before reopening it.** Three widenings were designed; one was abandoned as unsound
(ADR 0009), and it was the strongest — selection. What remains is repetition and ordering.

Two further arguments against reopening soon, both recorded rather than resolved:

- The technical case is prospective. A planner composing a schema that ships with the binary is
  doing what a developer could do by hand and test. It earns its place when the schema arrives at
  runtime — a host with many adapters, or a per-customer schema. This repo has one adapter.
- Nothing measures whether a planner beats a fixed list. A sibling sub-project designed, built and
  **deleted** a combinator on exactly that evidence, and the same standard should apply here.

The planner design's own review findings — a `Planner` contract that was never specified, plan
arguments with no consumer, `planOnce` returning a promise that composes with no construction site
in the repo — are not recorded here because they describe an artefact that was never built. They
would need re-deriving against whatever the vocabulary looks like when this reopens, which is the
honest state rather than a loss.
