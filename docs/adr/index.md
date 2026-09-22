# Architecture Decision Records

A decision with consequences, one per file, written when it is made and never rewritten
afterwards. If a later decision reverses this one, that is a **new** ADR, and this one is marked
`Superseded by NNNN` — the record of what we believed and why stays intact, because the reasoning
is the point. One exception: an ADR for a decision that has not shipped in a released version is
rewritten in place, because there is no history to preserve yet.

## What belongs here, and what does not

| Goes here                                                                          | Goes elsewhere                                                                                  |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A decision a future reader could plausibly reverse without knowing why it was made | Narrative designs — `docs/roadmap/design/*-design.md`                                           |
| A rejected alternative that will look attractive again                             | How to use a thing — `docs/guide/`                                                              |
| A constraint accepted on purpose, with its cost                                    | Implementation plans — **not committed**; they are scaffolding, stale the moment the code lands |

An ADR is short by construction. If the reasoning needs a rejected-alternative tour, an invariant
argued across three layers, or a "what this cost, stated plainly" section, that is a design doc,
and the ADR cites it rather than swallowing it.

## Format

```
# NNNN. Imperative title naming the decision

Status: Accepted | Superseded by NNNN
Date: YYYY-MM-DD

## Context
The forces. What was true that made this a decision rather than an obvious step.

## Decision
What we chose, in the active voice.

## Consequences
What this buys, and what it costs. The cost half is not optional.
```

Numbers are allocated in order and never reused. Status changes are the only edit an accepted ADR
receives.

## Records

| #                                                                              | Decision                                                                                     | Status   |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------- |
| [0001](./0001-consensus-arbiter-returns-an-index.md)                           | The consensus arbiter returns an index, not an envelope                                      | Accepted |
| [0002](./0002-judging-verdicts-terminal-vs-transient.md)                       | A judging verdict's error class follows who failed, not how badly                            | Accepted |
| [0003](./0003-judging-combinators-refuse-row-provenance.md)                    | Judging combinators refuse row and none provenance at construction                           | Accepted |
| [0004](./0004-judging-wrappers-emit-no-progress-units.md)                      | A wrapper that delegates and judges emits no progress units                                  | Accepted |
| [0005](./0005-cache-key-covers-the-whole-prompt.md)                            | An extraction cache key covers the whole prompt, and a hit reports zero calls                | Accepted |
| [0006](./0006-budget-is-a-detector-not-a-governor.md)                          | The budget combinator detects overspend; it does not prevent it                              | Accepted |
| [0007](./0007-consensus-first-survivor-is-structurally-authoritative.md)       | Consensus takes its structure from the first survivor and drops what only others produced    | Accepted |
| [0008](./0008-a-phase-dependency-is-a-phase-id.md)                             | A phase dependency is a phase id, not a note key                                             | Accepted |
| [0009](./0009-group-scoping-is-unsound-under-a-required-key-schema.md)         | Group scoping is unsound under a required-key schema                                         | Accepted |
| [0010](./0010-phases-and-the-chat-seam-belong-in-core.md)                      | The chat seam and the transport-agnostic phases belong in core                               | Accepted |
| [0011](./0011-the-agentic-layer-waits-for-a-vocabulary-worth-planning-over.md) | The agentic layer waits for a vocabulary worth planning over                                 | Accepted |
| [0012](./0012-a-callers-ask-rides-a-phase-at-the-callers-own-type.md)          | A caller's ask rides a phase at the caller's own type                                        | Accepted |
| [0013](./0013-a-leaf-that-cannot-fit-any-piece-fails-the-split.md)             | A leaf that cannot fit any piece fails the split at construction                             | Accepted |
| [0014](./0014-the-schema-entry-point-composes-the-presets.md)                  | The schema entry point composes the presets; it does not widen `perGroupExtractor`           | Accepted |
| [0015](./0015-the-library-carries-no-provider-byte-cap.md)                     | The library carries no provider byte cap                                                     | Accepted |
| [0016](./0016-shape-proposer-one-shot-with-repair.md)                          | The shape-operation proposer is one-shot with one repair attempt, not a multi-turn move loop | Accepted |
| [0017](./0017-duplicate-protection-is-the-receipt-not-the-key.md)              | Duplicate protection is the write receipt, not the idempotency key                           | Accepted |
| [0018](./0018-write-returns-a-receipt-and-core-never-parses-it.md)             | `write` returns a receipt, core never parses it, and one call carries one group              | Accepted |
| [0019](./0019-a-probes-finding-and-its-code-have-different-homes.md)           | A probe's finding and its code have different homes                                          | Accepted |
