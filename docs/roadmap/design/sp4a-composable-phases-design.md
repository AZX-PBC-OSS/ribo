# SP4a — Phases a planner could actually choose between

**Date:** 2026-09-18
**Status:** Draft — not reviewed, no implementation started.
**Question answered:** the prerequisite SP4 turned out to have. Before a model can compose a
strategy, the pieces have to compose.
**Depends on:** `phased-extraction-design.md` (SP1 — `Phase`, `PhaseMeta`, `validatePhases`).
**Blocks:** `sp4-agentic-layer-design.md`.

---

## 1. The answer, before the argument

**SP4's design review found that a planner over today's seven phases can express subsets and
repeats of two linear chains — the "router over three fixed strategies" SP1 §8 named as the
failure mode.** The machinery was buildable; the vocabulary was not worth planning over. This
sub-project widens the vocabulary. The planner waits.

Three changes, in the order they matter:

- **A draft-state axis on `PhaseMeta`** (`seedsDraft`, `requiresDraft`). `requires`/`produces`
  model the **notes** channel and nothing models the **fields** channel, which is why a phase list
  of `[gapfill]` alone passes every check and returns a successful, empty extraction.
- **Group scoping**, so a phase can target a subset of groups. This is what makes _selection_ a
  real decision rather than a formality — today every fill fills everything.
- **Fill that narrows from the draft**, so _repetition_ means something. Today a second
  `fillPhase` plans identical jobs and overwrites the first.

Those three turn "subsets and repeats of two chains" into a decision space. None of them needs a
model, and each is independently useful to a human composing a strategy by hand.

## 2. Evidence, all of it from reading the shipped phases

### 2.1 A mis-wired list fails late, retryably, after spending the calls

**An earlier draft of this section claimed `[gapfill]` alone is a silent, successful, empty
extraction. That is false and was checked: `{}` does not parse.** `enveloped()` strips top-level
`.optional()` and rebuilds with `z.strictObject`, so every group key is required, and
`enveloped.test.ts` pins that a missing top-level key is rejected. The closing trust-boundary parse
therefore fails.

The claim came from shipped prose — `presence-phase.ts`'s header says the group schemas are
`.optional()` so a missing group "succeeds silently". That comment is wrong (its _conclusion_, that
the seed is load-bearing, survives: without it a document silent on one group fails the whole run).
Correcting it belongs in this wave.

**What is actually wrong is worse in a different way.** `[gapfill]` alone plans nothing, the engine
no-ops, and the run dies at the closing parse with a `SchemaParseError` — which is **retryable**. So
the relay re-runs the whole phase list, spending every earlier phase's calls again, and repeats
until the item is `dead`. A mis-wired list is not a silent wrong answer; it is a loud, expensive,
repeating one.

Rejecting at construction is free. That is the justification for the draft-state axis, and it is
narrower than the one this design first gave.

### 2.2 A second `fillPhase` is a no-op that overwrites the first

`fillPhase.plan` reads the roster note, `options.prepared` and the transcript — **never
`draft.fields`**. Two fill phases plan identical jobs from the same roster, and the merge indexes by
`instanceIndex`, so the second overwrites. Of the seven shipped phases only `gapfill` re-runs
meaningfully, because its `plan` re-reads the draft for still-abstained leaves.

This matters beyond the planner: it means "run the expensive pass again on what's missing" is not
currently expressible by hand either.

### 2.3 No phase can be scoped to a subset of groups

`prepared: readonly PreparedGroup[]` is fixed at construction. `ClassifyPhaseOptions.groups` is the
host's schema walk, not a filter. So "this dictation is all HVAC — do that group first, cheaply" is
not expressible. Every fill fills everything.

### 2.4 Four of the seven phases are not exported

`@azx/ribo-extractor-ondevice` exports only `threePhaseExtractor`; `presencePhase`, `spanPhase`,
`classifyPhase` and `classifyWrappedPhase` are package-private. Any composition story is
managed-only until that changes — which for an offline-first library is the wrong half.

This is the third feature in this program found unreachable through a barrel, after
`rankCandidates` and `HVAC_IDENTIFYING_FIELDS`.

## 3. What this cannot mean

**Not a general dataflow graph.** Phases stay a _list_, run in order, over one shared draft. The
draft-state axis adds two booleans, not a dependency solver. SP1 chose a list deliberately and
nothing here reopens it.

**Not a group-level dependency system.** Group scoping filters what a phase works on. It does not
let phase A declare "I need group X populated by phase B" — that is the dataflow graph again.

**Not a change to what a phase IS.** `plan`/`run`/`merge` over a draft, existentially quantified
per item. Every change here is metadata a phase declares or an option a factory accepts.

## 4. Design

### 4.1 The draft-seeded marker (rewritten — this section originally built an axis)

```ts
/** Produced by any phase whose merge populates `draft.fields`; required by a phase that reads them. */
export const draftSeededNoteKey: NoteKey<true> = noteKey("draft-seeded");
```

The first version of this section added a `seedsDraft`/`requiresDraft` boolean axis to `PhaseMeta`
plus a `validatePhases` rule, reasoning that `requires`/`produces` model the **notes** channel and
nothing models the **fields** channel. That reasoning did not survive contact with the rest of the
design. The list-level rule the axis existed to enable — "at least one phase must seed the draft" —
was dropped as too invasive (it would have rejected every `phasedExtractor` fixture whose phases
declare no notes, and `[inventory]` alone is not clearly wrong), leaving the axis to serve exactly
one phase's dependency through a second, parallel mechanism the note-key vocabulary already had.
ADR 0010 records the reversal; 0008 stands as the record of why the axis looked right.

So: a phase whose dependency is the **shape of `draft.fields`** declares
`requires: [draftSeededNoteKey]`, and a phase whose merge populates the draft declares the key in
`produces` **and writes it** in its merge — which the engine's per-phase-boundary check verifies
against what the phase really did, making the declaration a proof rather than a promise. The
existing order-sensitive `requires` check is the whole rule set; `validatePhases` gained nothing.
The phases declare:

| Phase              | `requires`           | `produces`                              |
| ------------------ | -------------------- | --------------------------------------- |
| `inventory`        | —                    | `rosterNoteKey`                         |
| `fill`             | `rosterNoteKey`      | `draftSeededNoteKey`                    |
| `gapfill`          | `draftSeededNoteKey` | —                                       |
| `extractorPhase`   | —                    | `draftSeededNoteKey`                    |
| `presence`         | —                    | `presenceNoteKey`, `draftSeededNoteKey` |
| `span`             | `presenceNoteKey`    | `spansNoteKey`                          |
| `classify`         | `spansNoteKey`       | `unsupportedNoteKey`                    |
| `classify-wrapped` | `unsupportedNoteKey` | —                                       |

`[gapfill]` alone is rejected, as is `[inventory, gapfill]` — `inventory` is deliberately **not** a
producer of the marker, because its `[]` entries for stated-none groups are scaffolding rather than
extracted data, and letting them satisfy gap-fill is exactly the mis-wiring to reject. `[fill,
gapfill]` validates; `[gapfill, fill]` does not, because order matters; and a phase listing the key
in both `requires` and `produces` cannot satisfy itself, because a phase's own `produces` is
absorbed after its `requires` are checked. All five cases are pinned in `validate-phases.test.ts`.

### 4.2 Group scoping — designed, checked, ABANDONED

Scoping a phase to a subset of groups was the change that would have made _selection_ a real
decision. It is unsound under this repo's schema, and the reason is worth recording so it is not
re-proposed.

**The closing parse requires every top-level group key.** `enveloped()` strips top-level
`.optional()` and rebuilds with `z.strictObject`, and `enveloped.test.ts` pins that a missing key
is rejected. **And a phase's merge writes only the groups it ran jobs for** — `fillPhase.merge`
starts from `{ ...draft.fields }` and adds entries per outcome. So scoping `fillPhase` to `["hvac"]`
leaves every other group's key absent, and the run dies at the parse.

That applies to every _seeding_ phase, which is every phase scoping would have been useful on. The
phases where scoping is safe are the refiners — `gapfill`, `span` — and those already take their
scope from what the draft contains, which is why §4 excluded them in the first place.

**A sound version exists and is a bigger design than this sub-project.** Scoping would have to be a
plan-level property with a coverage invariant: the union of the scoped phases must cover every
group, checked at construction. That is the group-level dependency system §3 rules out.

**What this costs.** Selection was the strongest of the three widenings — "this dictation is all
HVAC, do that group and skip the rest" is exactly the decision a planner should be able to make.
Without it, the remaining widening is repetition (§4.3), and a planner's decision space is
correspondingly smaller. §7 records what that means for SP4b.

### 4.3 Fill that narrows from the draft

`fillPhase` gains `narrowToAbstained?: boolean`, default `false`.

When true, `plan` skips a job whose leaves are already committed in the draft — the same question
`findAbstainedLeaves` answers for gap-fill, asked at job granularity rather than leaf granularity.
A second fill then re-asks only about what the first did not get.

**The merge needed a fix for this to be safe, and the reason is worth recording.** This design
argued narrowing is sound because `fillPhase.merge` starts from `{ ...draft.fields }`, so earlier
results survive. That is true for singleton entries and **was false for collection groups**: the
merge rebuilt each collection array as `new Array(job.instances)` and wrote it over the draft
wholesale, so a narrowed second fill blanked the slots it had skipped. Narrowing would have
destroyed data. The base is now the draft's own array when it holds one. A full fill is unaffected,
because every slot's job runs.

**Default false, because true changes behaviour for every existing caller** and the three-phase and
scoped-instance presets were measured with the current semantics.

**Why an option and not a separate phase kind.** It is the same prompt, the same merge, the same
parse — only the job list narrows. A separate factory would duplicate all of that to vary one
predicate.

### 4.4 The transport-agnostic phases live in core (rewritten — this section originally exported them from ondevice)

`presencePhase`, `spanPhase`, `classifyPhase`, `classifyWrappedPhase`, their note keys and the
`extractGroups` schema walk moved to `@azx/ribo-core` (SP4a wave 5), where they are exported beside
`extractorPhase`. The original section exported them from `@azx/ribo-extractor-ondevice`'s barrel,
mirroring how openai's phases are exported there — but the on-device home was an accident of where
the preset lives, not a property of the phases: they ask a `ChatClient` which leaves are present,
what spans support them and which are unsupported, and nothing in that is on-device. With the
`ChatClient` seam itself moved to core (the seam is the interface the phases speak), the phases
moved with it, and a host composes them from core while the on-device package keeps only
`threePhaseExtractor` — the preset that tunes them to the device (`concurrency: 1`, the device-sized
`perCallCeilingMs`, zero retry delay), which is the genuinely on-device part.

The compatibility commitment stands, moved rather than widened twice: the phases, their options
types and their note keys are supported core API, and `@azx/ribo-extractor-ondevice`'s barrel no
longer re-exports them.

## 5. What this cost, stated plainly

**Two more booleans on a contract every phase implements**, and the honest risk is that
`seedsDraft`/`requiresDraft` is a two-value approximation of something richer. If a third state
appears, this axis was the wrong shape.

**Group scoping is only as good as the group keys**, which are strings checked at construction.
A caller who scopes to `"hvac"` on a schema whose key is `"hvacSystems"` gets a throw, which is the
right outcome, but there is no type-level connection between the two.

**`narrowToAbstained` makes `fillPhase` two phases wearing one name.** The doc comment carries the
distinction; nothing in the type does.

**Four new public exports** in the on-device package, permanently.

## 6. Sequencing

1. **Wave 1 — the draft-state axis** and `validatePhases`' two new rules. Declare it on all seven
   phases. This is the one that closes a live hole and is worth doing even if nothing else is.
2. **Wave 2 — `narrowToAbstained`** on `fillPhase`, plus the optional `id` SP4 needs on all
   eight factories (the same edit to the same files).
3. **Wave 3 — the on-device barrel exports.**
4. **Wave 4 — guide, ADRs, changeset.**

Group scoping was wave 2 and is abandoned (§4.2).

Then re-open `sp4-agentic-layer-design.md` with a vocabulary worth planning over.

## 7. How this could be wrong

- **Nobody composes a strategy by hand today**, so widening the vocabulary may serve only the
  planner — and the planner is deferred. If SP4b is never built, waves 2 and 3 are unused API. Wave
  1 is not: it closes a hole that exists now.
- **`narrowToAbstained` may be the wrong granularity.** Job-level narrowing skips a job whose leaves
  are all committed; a job that is half-filled still re-asks about everything. Leaf-level narrowing
  is what gap-fill does and is a different phase.
- **The draft-state axis is declared by hand** on each phase, so it can be declared wrongly, and
  nothing checks the declaration against behaviour. A phase claiming `seedsDraft` that writes no
  fields satisfies rule 2 and produces the empty extraction anyway.
- **Without scoping, the decision space a planner gets is thin.** Repetition and ordering are what
  remain. That is a materially weaker case for SP4b than this design opened with, and it should be
  weighed before the planner is built rather than after.

## 8. Must-fail tests

- A list of `[gapfill]` alone is **rejected at construction** — the pin for §2.1. Without it the
  run dies at the closing parse with a RETRYABLE error, so the relay re-spends every earlier
  phase's calls on each retry.
- `[inventory, fill]` validates; `[inventory, gapfill]` is rejected (no seeding phase before a
  `requiresDraft` one); `[fill, gapfill]` validates.
- **`[inventory]` alone still validates**, and that is deliberate — see §4.1's footnote. Pin it, so
  a future reader does not re-add the list-level rule.
- The on-device chain `[presence, span, classify]` validates **unchanged**, on its existing note
  declarations plus presence's new `seedsDraft` — the pin that the axis did not disturb six phases
  that were already correct.
- A list where no phase declares `seedsDraft` is rejected even if every `requires` is satisfied.
- Every existing phase list in the repo still validates unchanged — the presets AND the ~50
  hand-rolled fixtures in `phased-extractor.test.ts`, none of which declares either member. This is
  the pin that dropping the list-level rule bought.
- `narrowToAbstained: true` skips a job whose leaves are committed and keeps one whose leaves are
  not; `false` (the default) plans both, so the presets are unaffected.
- The four on-device factories are reachable from the package barrel, pinned the way that package
  pins its other exports.
