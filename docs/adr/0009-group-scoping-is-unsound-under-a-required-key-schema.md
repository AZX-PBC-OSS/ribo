# 0009. Group scoping is unsound under a required-key schema

Status: Accepted
Date: 2026-09-19

## Context

A phase scoped to a subset of groups — "this dictation is all HVAC, fill that and skip the rest" —
was designed as the change that would make _selection_ a real decision rather than a formality.
Every fill currently fills everything.

It was the strongest of three proposed widenings to the phase vocabulary, and the one a planner
would most need.

## Decision

**Not built.** Two facts, each verified, make it unsound:

- The closing trust-boundary parse **requires every top-level group key**. `enveloped()` strips
  top-level `.optional()` and rebuilds with `z.strictObject`; `enveloped.test.ts` pins that a
  missing key is rejected.
- A phase's merge **writes only the groups it ran jobs for**. `fillPhase.merge` starts from
  `{ ...draft.fields }` and adds an entry per outcome.

So scoping `fillPhase` to `["hvac"]` leaves every other group's key absent and the run dies at the
parse. That applies to every _seeding_ phase — which is every phase scoping would have been useful
on. The phases where it is safe are the refiners, `gapfill` and `span`, and those already take
their scope from what the draft contains.

**`narrowToAbstained` was kept, and the distinction is the whole decision.** Narrowing skips work
that is **already done**, so those keys are in the draft and survive the merge's copy. Scoping
skips work that was **never done**, so those keys never appear at all.

## Consequences

A planner's decision space is repetition and ordering, not selection. That is materially thinner
than the case SP4a opened with, and it should be weighed before the agentic layer is built rather
than after — it is recorded in that design's §7.

A sound version exists and is a larger design: scoping as a **plan-level** property with a coverage
invariant, where the union of the scoped phases must cover every group, checked at construction.
That is the group-level dependency system SP4a's §3 rules out, and it would need the phase list to
stop being a plain ordered list.

The cheap alternative — making the extraction schema's group keys optional — is not available.
Every key being required **is** the anti-hallucination rule: a model must emit an explicit `null`
for "not mentioned" rather than omitting the key, so an omission cannot masquerade as an answer.
Relaxing it to enable scoping would trade a guarantee this library is built on for a convenience.
