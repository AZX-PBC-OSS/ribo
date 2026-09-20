# 0008. A phase declares whether it seeds the draft, or needs one seeded

Status: Accepted
Date: 2026-09-19

## Context

`PhaseMeta`'s `requires`/`produces` model the **notes** channel: a phase names the note keys it
reads and writes, and `validatePhases` checks, in order, that nothing requires what no earlier
phase produced. Six of the eight shipped phases express their real dependency that way and are
correctly ordered by it.

`gapFillPhase` cannot. Its dependency is the **shape of `draft.fields`** — it re-asks about leaves
an earlier phase left abstained — and there is no note key for "the draft has been populated". So
`[gapfill]` alone passed every check.

What happened next was not what we first believed. The claim inherited from review was that such a
list is a silent success returning `{}`. It is not: `enveloped()` strips top-level `.optional()`
and rebuilds with `z.strictObject`, so every group key is required, and a missing one is rejected.
The run dies at the closing trust-boundary parse.

It dies **retryably**. `SchemaParseError` is classified transient, so the relay re-runs the whole
phase list — re-spending every earlier phase's model calls — and repeats until the item is `dead`.
A mis-wired list is not a wrong answer; it is an expensive, repeating failure.

## Decision

Two optional booleans on `PhaseMeta`, `seedsDraft` and `requiresDraft`, and one rule in
`validatePhases`: **a phase declaring `requiresDraft` must be preceded by one declaring
`seedsDraft`.** Order-sensitive, checked before a phase absorbs its own declaration, so a phase
cannot satisfy itself.

Four phases declare: `fill`, `presence` and `extractorPhase` seed; `gapfill` requires. The other
four are untouched — `span`, `classify` and `classify-wrapped` read notes and already declare them,
and `inventory` is deliberately unmarked even though its merge writes `[]` entries for stated-none
groups, because those are scaffolding rather than extracted data and marking it would make
`[inventory, gapfill]` validate.

**There is deliberately no "at least one phase must seed" rule.** It was designed and dropped: it
would have rejected roughly fifty existing `phasedExtractor` constructions in the test suite to buy
one diagnostic, and `[inventory]` alone is not clearly wrong — an all-stated-empty roster
legitimately yields `{hvac: []}`.

## Consequences

A mis-wired list now fails at construction, for free, instead of after spending the pipeline's
calls and then spending them again on every relay retry.

The cost is two more members on a contract every phase implements, serving exactly one phase today,
and **nothing checks a declaration against behaviour** — a phase claiming `seedsDraft` that writes
no fields satisfies the rule and fails at the parse anyway. The declaration is a promise, not a
proof.

`phaseBuilder` copies metadata member-by-member rather than by spread, so both members had to be
added to that copy list. Omitting them would leave every real phase reading `undefined`, the rule
silently never firing, and the suite green — which is why the pin is written through the builder
rather than an object literal.
