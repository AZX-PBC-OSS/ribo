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

### 2.1 `[gapfill]` alone is a silent, successful, empty extraction

`gapFillPhase` declares no `requires` and no `produces` (`gap-fill-phase.ts`). Its real dependency
is the **shape of `draft.fields`** — a base phase having populated complete envelopes — and
`PhaseMeta` cannot express that. So the list passes `validatePhases`, `findAbstainedLeaves` finds
nothing on an empty draft, the phase plans no items, the engine no-ops, and `{}` parses against the
optional group schemas. Zero calls, zero fields, `status: ok`.

The source already knows: gap-fill's own comment concedes "nothing enforces that for a
`gapFillPhase` used standalone."

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

### 4.1 The draft-state axis

```ts
interface PhaseMeta {
  // … existing: id, requires, produces, concurrency, onItemFailure, maxRetries
  /** This phase can populate an empty draft's `fields`. */
  readonly seedsDraft?: boolean;
  /** This phase only does useful work over a draft another phase populated. */
  readonly requiresDraft?: boolean;
}
```

Both default to `undefined`, read as `false`, so every existing phase list keeps validating. The
seven shipped phases declare:

| Phase            | `seedsDraft` | `requiresDraft` | Why                                               |
| ---------------- | ------------ | --------------- | ------------------------------------------------- |
| `inventory`      | —            | —               | Writes a note, never touches `fields`             |
| `fill`           | yes          | —               | Writes envelopes from the roster                  |
| `gapfill`        | —            | **yes**         | Re-asks about leaves another phase left abstained |
| `extractorPhase` | yes          | —               | Runs a whole extractor into the draft             |
| `presence`       | yes          | —               | Seeds every group with null envelopes             |
| `span`           | —            | **yes**         | Adds spans to leaves that already have values     |
| `classify`       | —            | **yes**         | Reads present leaves                              |

**`validatePhases` gains two rules**, both the same order-sensitive shape as the existing
`requires` check, and both rejecting at construction:

1. A phase declaring `requiresDraft` must be preceded by one declaring `seedsDraft`.
2. At least one phase in the list must declare `seedsDraft` — a list that never populates `fields`
   can only return an empty extraction, and returning one successfully is worse than refusing.

Rule 2 is what closes §2.1. It is deliberately about the _list_, not a pair, because the failure it
catches is a whole plan that does nothing.

**Why booleans rather than declaring which groups or leaves.** Because the useful question is
"could this list possibly produce data", and that is answered by presence. A finer axis would need
phases to declare which leaves they write, which none of them knows until `plan` runs.

### 4.2 Group scoping

A new optional member on the factories that walk groups — `fillPhase`, `presencePhase`,
`classifyPhase`, and `inventoryPhase`:

```ts
readonly groups?: readonly string[];
```

Absent means every group, which is today's behaviour. Present means **filter `prepared` to these
keys** before planning. A key naming no prepared group throws at construction, with the unknown key
and the available ones named — a silent empty filter is how a scoped phase becomes a no-op nobody
notices.

`gapFillPhase` and `spanPhase` are deliberately **not** scoped: both work from what the draft
already contains, so their scope is the draft's, not a caller's.

### 4.3 Fill that narrows from the draft

`fillPhase` gains `narrowToAbstained?: boolean`, default `false`.

When true, `plan` skips a job whose leaves are already committed in the draft — the same question
`findAbstainedLeaves` answers for gap-fill, asked at job granularity rather than leaf granularity.
A second fill then re-asks only about what the first did not get.

**Default false, because true changes behaviour for every existing caller** and the three-phase and
scoped-instance presets were measured with the current semantics.

**Why an option and not a separate phase kind.** It is the same prompt, the same merge, the same
parse — only the job list narrows. A separate factory would duplicate all of that to vary one
predicate.

### 4.4 Export the on-device phases

`presencePhase`, `spanPhase`, `classifyPhase`, `classifyWrappedPhase` and their note keys join
`@azx/ribo-extractor-ondevice`'s barrel, as openai's three already have with `rosterNoteKey`.

This widens a public surface deliberately: they become supported API, and their options types are
then a compatibility commitment. That is the cost of composition being possible at all outside the
package.

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
2. **Wave 2 — group scoping** on the four group-walking factories.
3. **Wave 3 — `narrowToAbstained`** on `fillPhase`.
4. **Wave 4 — the on-device barrel**, plus the optional `id` SP4 needs (moved here from SP4's
   Wave 1, since it is the same edit to the same factories).
5. **Wave 5 — guide, ADRs, changeset.**

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
- **Group scoping might want to be per-plan rather than per-construction**, which is the shape SP4's
  review rejected — `PlannedPhase.groups` had no consumer. Building it as a construction option
  now means SP4b must either forward it or leave it out of the plan vocabulary. This design assumes
  the latter and says so.

## 8. Must-fail tests

- A list of `[gapfill]` alone is **rejected at construction** — the pin for §2.1, and the reason
  this sub-project exists.
- `[inventory, fill]` validates; `[inventory, gapfill]` is rejected (no seeding phase before a
  `requiresDraft` one); `[fill, gapfill]` validates.
- A list where no phase declares `seedsDraft` is rejected even if every `requires` is satisfied.
- Every existing phase list in the repo still validates unchanged — the presets are the pin.
- A scoped `fillPhase` plans jobs for only the named groups; an unknown group key throws at
  construction naming the key and the available ones.
- `narrowToAbstained: true` skips a job whose leaves are committed and keeps one whose leaves are
  not; `false` (the default) plans both, so the presets are unaffected.
- The four on-device factories are reachable from the package barrel, pinned the way that package
  pins its other exports.
