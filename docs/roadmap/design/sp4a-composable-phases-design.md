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

Both default to `undefined`, read as `false`, so every existing phase list keeps validating.

**The axis serves exactly one phase today, and the first draft of this section got that wrong.**
It claimed `span` and `classify` would need `requiresDraft`. They do not: `spanPhase.plan` reads
`draft.notes.get(presenceNoteKey)` and `classifyPhase.plan` reads `draft.notes.get(spansNoteKey)`,
and both **already declare those as `requires`**. Six of the seven phases express their
dependencies correctly through the notes channel:

| Phase              | `requires`           | `produces`           | `seedsDraft` | `requiresDraft` |
| ------------------ | -------------------- | -------------------- | ------------ | --------------- |
| `inventory`        | —                    | `rosterNoteKey`      | —            | —               |
| `fill`             | `rosterNoteKey`      | —                    | **yes**      | —               |
| `gapfill`          | —                    | —                    | —            | **yes**         |
| `extractorPhase`   | —                    | —                    | **yes**      | —               |
| `presence`         | —                    | `presenceNoteKey`    | **yes**      | —               |
| `span`             | `presenceNoteKey`    | `spansNoteKey`       | —            | —               |
| `classify`         | `spansNoteKey`       | `unsupportedNoteKey` | —            | —               |
| `classify-wrapped` | `unsupportedNoteKey` | —                    | —            | —               |

`gapfill` is the only phase whose dependency is on the **shape of `draft.fields`** rather than on a
note, and that is precisely why `PhaseMeta` cannot express it and why `[gapfill]` alone passes
every gate.

**`validatePhases` gains two rules**, both the same order-sensitive shape as the existing
`requires` check, and both rejecting at construction:

1. A phase declaring `requiresDraft` must be preceded by one declaring `seedsDraft`.

**There is no second rule.** An earlier draft added "at least one phase must declare `seedsDraft`",
to catch `[inventory]` alone. It is dropped for two reasons, both found by review. It would reject
roughly fifty existing `phasedExtractor` constructions in the test suite — every hand-rolled
fixture would have to declare `seedsDraft` — which is a large, purely mechanical edit to buy one
diagnostic. And `[inventory]` alone is not clearly wrong: its merge writes `fields[key] = []` for
stated-none and zero-current collection groups, so an all-stated-empty roster legitimately produces
`{hvac: []}`.

Rule 1 costs nothing by comparison: no existing fixture declares `requiresDraft`, so it never fires
on one, and it still rejects `[gapfill]` alone — the case that motivated the axis.

¹ `inventory` is deliberately **not** marked `seedsDraft` even though its merge can write `[]`
entries. Those are scaffolding for groups the roster said are empty, not extracted data, and
marking it would make `[inventory, gapfill]` validate — which is exactly the mis-wiring rule 1
exists to reject.

**Rule 2 is the one that earns the axis.** Rule 1 alone could have been done with a payload-free
marker note — a `draftSeededNoteKey` that seeding phases produce and `gapfill` requires — reusing a
mechanism that already works. Rule 2 cannot: "no phase in this list ever populates `fields`" is a
property of the whole list, not of a pair, and no `requires`/`produces` arrangement expresses it.
`[inventory]` alone is a vacuous success for exactly that reason — it produces a roster note and
writes no fields — and a marker note would not catch it.

Given rule 2 forces a real declaration, `requiresDraft` is one more boolean and is more honest than
a note carrying no payload.

**Why booleans rather than declaring which groups or leaves.** The useful question is "could this
list possibly produce data", which presence answers. A finer axis would need phases to declare
which leaves they write, which none of them knows until `plan` runs.

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
