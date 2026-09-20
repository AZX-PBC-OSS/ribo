# 0008. A phase dependency is a phase id, not a note key

Status: Accepted
Date: 2026-09-19

## Context

A phase list's ordering constraints need a declaration vocabulary. Three were considered:

_A `seedsDraft`/`requiresDraft` boolean pair on `PhaseMeta`._ Dropped before it was built: it is a
second axis hard-coded to one relationship (the draft), inexpressive for every dependency that came
after, and it invites a list-level rule — "at least one phase must seed" — that would reject every
fixture whose phases declare nothing, along with `[inventory]` alone, which is not clearly wrong (an
all-stated-empty roster legitimately yields `{hvac: []}`).

_Note keys as the declaration vocabulary._ What shipped first (as "a draft-shape dependency is a
note key"): `requires` named the note keys a phase reads and `produces` the keys it writes, and
`validatePhases` checked set membership in list order. It had two defects. The branded `NoteKey<T>`
is erased at the declaration site — `requires` was `readonly string[]`, and a
`NoteKey<unknown>[]`-typed slot would _reject_ real keys, because the brand is invariant — so the
brand bought nothing where the declaration was written. Worse, it split one job across two
vocabularies: a phase already has a unique `id`, and a host composing phases thinks in ids — "run
mine after `fill`" — not in the note keys the phases happen to hand each other.

## Decision

`PhaseMeta.requires` names **phase ids**: ids of phases that must appear earlier in the same list,
checked by `validatePhases` in list order. `produces` is deleted. A caller who renames a phase must
update whoever depends on it — the ids are the caller-visible ones, and the factory defaults name
the shipped providers. Supplying `requires` on a factory's options **replaces** the default: it is
the complete list, so a caller adding a constraint must still name every provider the phase reads
from.

The notes bag is unchanged and stays the **runtime channel** — `rosterNoteKey`, `presenceNoteKey`,
`spansNoteKey` and `unsupportedNoteKey` keep being written and read by their phases. The
guarantee that a read succeeds is a **read-site throw** (`demandNote`, and a carve-out where the
producing phase's merge legitimately does not run): a phase that reads a note demands it, which is
stronger than either check it replaces, because it cannot be forgotten in a declaration.

## Consequences

**OR became AND.** The note-key check was set membership over produced keys, so a requirement could
be satisfied by _any_ producer of the key. Ids name one specific phase, so "after at least one of
{a, b, c}" is no longer expressible. The draft-shape dependency was one instance of that; it is the
general shape that matters.

**`[inventory, gapfill]` is now a legal list.** Under the note-key check it was refused at
construction as the mis-wiring the marker existed to reject; gap-fill re-asking over a draft of
nothing but scaffolding is a no-op, not a wiring error, and the list now validates. A list that
_does_ reach the closing parse incomplete still fails there, retryably.

**The per-phase-boundary `produces` verification is gone.** The read-site throw covers a different
set: it catches a reader whose note was never written, not a producer that declared a key and wrote
it conditionally. The engine's empty-plan no-op — a merge is skipped when its plan was empty — means
a producing merge's "unconditional" write has a hole, so the read sites whose producer can plan
empty (span → classify, classify → wrapped) pair the demand with an explicit carve-out for the
legitimate absence.

**The rename coupling is manufactured by this change.** Under note keys, renaming a phase broke
nothing — a caller could rename the presence phase and a default `spanPhase()` still composed. Ids
create that coupling, and the replacing semantics manage it: a caller who renames a provider names
the new id, and a caller who forgets fails validation on a dangling id instead of silently composing
against a phase that is no longer there.
