# Architecture Decision Records

A decision with consequences, one per file, written when it is made and never rewritten
afterwards. If a later decision reverses this one, that is a **new** ADR, and this one is marked
`Superseded by NNNN` — the record of what we believed and why stays intact, because the reasoning
is the point.

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

| #                                                                        | Decision                                                                                  | Status   |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------- |
| [0001](./0001-consensus-arbiter-returns-an-index.md)                     | The consensus arbiter returns an index, not an envelope                                   | Accepted |
| [0002](./0002-judging-verdicts-terminal-vs-transient.md)                 | A judging verdict's error class follows who failed, not how badly                         | Accepted |
| [0003](./0003-judging-combinators-refuse-row-provenance.md)              | Judging combinators refuse row and none provenance at construction                        | Accepted |
| [0004](./0004-judging-wrappers-emit-no-progress-units.md)                | A wrapper that delegates and judges emits no progress units                               | Accepted |
| [0005](./0005-cache-key-covers-the-whole-prompt.md)                      | An extraction cache key covers the whole prompt, and a hit reports zero calls             | Accepted |
| [0006](./0006-budget-is-a-detector-not-a-governor.md)                    | The budget combinator detects overspend; it does not prevent it                           | Accepted |
| [0007](./0007-consensus-first-survivor-is-structurally-authoritative.md) | Consensus takes its structure from the first survivor and drops what only others produced | Accepted |
| [0008](./0008-draft-state-is-declared-not-inferred.md)                   | A phase declares whether it seeds the draft, or needs one seeded                          | Accepted |
| [0009](./0009-group-scoping-is-unsound-under-a-required-key-schema.md)   | Group scoping is unsound under a required-key schema                                      | Accepted |
