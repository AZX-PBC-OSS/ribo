# 0010. A draft-shape dependency is a note key, not a second axis

Status: Accepted
Date: 2026-09-19

## Context

ADR 0008 added a `seedsDraft`/`requiresDraft` boolean pair to `PhaseMeta` and one `validatePhases`
rule to go with it, for exactly one phase: `gapFillPhase`'s dependency is the **shape of
`draft.fields`** — it re-asks about leaves an earlier phase left abstained — which the notes
channel's `requires`/`produces` could not then express.

Two things moved under it before it ever shipped in a release. The list-level rule the design
wanted the axis for — "at least one phase must seed the draft" — was dropped as too invasive (it
would have rejected every `phasedExtractor` fixture whose phases declare no notes, and `[inventory]`
alone is not clearly wrong). What remained was the single order-sensitive check the note-key
mechanism already provides. And the engine had since grown a per-phase-boundary check that verifies
a declared `produces` key against what the merge really wrote — exactly the "declaration without
behaviour" gap 0008 named as its own cost.

## Decision

Delete the axis. A phase whose dependency is the shape of `draft.fields` requires
`draftSeededNoteKey` — an ordinary branded note key in core — and a phase whose merge populates
`draft.fields` produces it, writing the key into the draft's notes in its merge. `validatePhases`
gains no rule: the existing requires-before-produces check is the whole mechanism, and it already
enforces order and refuses self-satisfaction. The engine's boundary check is what turns the
declaration into a proof.

## Consequences

Two fewer members on a contract every phase implements, one fewer validation rule, and no new
mechanism — the marker is one constant over vocabulary that already existed. The five cases the
axis's tests pinned are re-pinned through the key unchanged in effect: `[gapfill]` alone rejected,
`[inventory, gapfill]` rejected, `[fill, gapfill]` passes, order matters, and a phase producing and
requiring the marker cannot satisfy itself.

The honest record: the justification for the axis — the list-level seeding rule — was dropped under
review, and the API it justified was not, and nobody noticed. Reversing the API is what this ADR
does; the record of why 0008 looked right at the time stays in its file.
