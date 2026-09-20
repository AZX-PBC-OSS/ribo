# 0008. A draft-shape dependency is a note key, not a second axis

Status: Accepted
Date: 2026-09-19

## Context

`PhaseMeta`'s `requires`/`produces` model the **notes** channel: a phase names the note keys it
reads and writes, and `validatePhases` checks, in order, that nothing requires what no earlier
phase produced. Most shipped phases express their real dependency that way and are correctly
ordered by it.

`gapFillPhase` cannot. Its dependency is the **shape of `draft.fields`** — it re-asks about leaves
an earlier phase left abstained — and there was no key for "the draft has been populated". So
`[gapfill]` alone passed every check.

It does not then fail cheaply. `enveloped()` strips top-level `.optional()` and rebuilds with
`z.strictObject`, so every group key is required and a missing one is rejected: the run dies at the
closing trust-boundary parse. And `SchemaParseError` is classified transient, so the relay re-runs
the whole phase list — re-spending every earlier phase's model calls — until the item is `dead`. A
mis-wired list is an expensive, repeating failure.

The alternative considered was a dedicated axis: `seedsDraft`/`requiresDraft` booleans on
`PhaseMeta` plus a matching `validatePhases` rule. What made it look necessary was a list-level
rule — "at least one phase must seed the draft" — that no note key can express. That rule was
dropped as too invasive: it would reject every `phasedExtractor` fixture whose phases declare no
notes, and `[inventory]` alone is not clearly wrong, since an all-stated-empty roster legitimately
yields `{hvac: []}`.

## Decision

No axis. A phase whose dependency is the shape of `draft.fields` requires `draftSeededNoteKey` — an
ordinary branded note key in core — and a phase whose merge populates `draft.fields` produces it,
writing the key into the draft's notes in its merge. `validatePhases` gains no rule: the existing
requires-before-produces check enforces order and refuses self-satisfaction already, and the
engine's per-phase-boundary check — which verifies a declared `produces` against what the merge
really wrote — is what turns the declaration into a proof rather than a promise.

`inventoryPhase` deliberately does **not** produce the marker, even though its merge writes `[]`
entries for stated-none groups. Those are scaffolding, not extracted data, and marking it would
make `[inventory, gapfill]` validate — the mis-wiring the check exists to reject.

## Consequences

A mis-wired list fails at construction, for free, instead of after spending the pipeline's calls
and then spending them again on every relay retry.

No new mechanism: the marker is one constant over vocabulary that already existed, so the contract
every phase implements gains nothing and `validatePhases` gains no rule to keep in step with it.

The cost is that the dependency reads as a convention rather than a declaration — "produces
`draft-seeded`" says less at a glance than `seedsDraft: true` — and a reader has to know the marker
to see why `[gapfill]` is rejected. The pin is written through `phaseBuilder` rather than an object
literal, since the builder copies metadata member-by-member and a member missed there reads
`undefined` off every real phase with the suite still green.
