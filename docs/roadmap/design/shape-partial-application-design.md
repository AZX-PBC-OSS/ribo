# Partial application for the shape applier: collect every refusal, apply the rest

**Date:** 2026-09-22
**Status:** Draft — for review. No implementation plan written yet.
**Question answered:** "`deriveExtractionShape` refuses an operation set all-or-nothing, and a model
proposes the set with a repair loop feeding the refusal back. How does the applier report every
refusal it can find in one pass, and what does it mean to apply the operations that survive?"
**Depends on:** ADR 0016 (`docs/adr/0016-shape-proposer-one-shot-with-repair.md`), the Stage 1
applier (`deriveExtractionShape`), and spike 0009's live evidence
(`docs/spikes/0009-basedata-proposer/README.md`).

---

## 1. The problem, in the source

`deriveExtractionShape`
(`packages/ribo-extractor-openai/src/shape/shape-operations.ts:100`) is synchronous and model-free:
normalize the caller's zod schema into a patch tree, bucket the operations, apply them, run
`enveloped()`, derive the mapping, verify the artifact against itself (`shape-operations.ts:107-297`).
Every refusal on the way is a `throw`, and the throw aborts the whole derivation:

| Refusal                                                     | Thrown at                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| A bracketed (instance-key) path in any operation            | `shape-operations.ts:63-72`                                |
| Duplicate drop, retype, or same-group regroup               | `shape-operations.ts:117-145`                              |
| Retype outside the closed string→number set                 | `shape-operations.ts:127-134`                              |
| A drop naming a path the schema lacks                       | `shape-operations.ts:149-157`                              |
| A retype not naming a leaf — possibly a dropped path        | `shape-operations.ts:164-173`                              |
| A retype whose source leaf is not a string                  | `shape-operations.ts:174-181`                              |
| A regroup naming an absent group, or a leaf                 | `shape-operations.ts:310-322`                              |
| A move at the group, array-crossing, or not found           | `shape-operations.ts:336-356`                              |
| A destination across a dropped path; colliding or prefixing | `shape-operations.ts:385-419`                              |
| An object emptied in either tree                            | `shape-operations.ts:193-195`, via `shape-tree.ts:168-182` |
| Provenance naming a dropped group                           | `shape-operations.ts:202-214`                              |
| A declaration naming a dropped or absent group/leaf         | `shape-operations.ts:236-281`                              |
| The schema itself (scalar array, union, record)             | `shape-tree.ts:79-100`                                     |

Throwing is deliberate — "an error at derivation, where the schema author is present, beats the same
failure at extraction" (`shape-operation.ts:50-54`) — and the throw text is load-bearing: ADR 0016
feeds it verbatim to the model as repair feedback
(`operations-proposer.ts:439-459` and `:490-497`). But the applier stops at the **first** refusal it
reaches in input order. Two consequences, both observed:

- **A repair turn sees one refusal, so N bad ops cost N repair turns** — and the default budget is
  one (`operations-proposer.ts:567`). At exhaustion the proposer returns `[]`
  (`operations-proposer.ts:601-605`): no shaping at all, the good operations lost with the bad.
- **A caller applying a model's proposal directly has no middle option** between "throw away the
  whole set" and "catch, parse the message by hand, strip one op, retry".

  > **Correction, 2026-09-22.** This bullet originally attributed "one bad operation out of 91
  > zeroed 14 good nests" to a report from the field app, adding that the numbers were "not
  > checkable here" because that app lives in a separate repo. **That attribution was false, and
  > impossible.** `nest` exists only inside an unmerged PR; it is on no published version of
  > `@azx/ribo-extractor-openai` (still `0.0.0`) and not on `origin/main`, so a consumer of these
  > packages cannot have encountered one nest, let alone fourteen. The numbers themselves are
  > right — they are what the live run measured, independently, below — but they were dressed as
  > an unfalsifiable external citation. Kept visible rather than deleted: a claim immunised from
  > review by "not checkable here" is the shape of error worth being able to recognise again.

  The live-run evidence (`nest-live-run-evidence.md` §2) measures the cascade end to
  end against a real vendor schema: one retype out of a 91-operation proposal named a leaf the same
  proposal also dropped, the applier refused the whole set, the repair turn did not find which of
  the two ops to retract, and the run exhausted to `[]` — every good operation, including the 14
  good nests, gone with it. The in-repo version of the same story is spike 0009: on a flat 294-leaf
  schema the model proposed 19 regroups, the applier refused 18, and the whole proposal was zeroed
  (`docs/spikes/0009-basedata-proposer/README.md:26-35`); the spike then hand-rolled a recovery loop
  over captured model turns to find a validating subset (`run.mjs:302-313`) — the workaround every
  caller will otherwise write.

The applier is the component that knows which operation it refused and why. Collecting what it can
report, and applying what survives, belongs here and nowhere else.

## 2. The two changes

1. **Collect every refusal in one pass.** The applier stops throwing at the first bad operation and
   reports every refusal it can find, classified (§4). The proposer's repair turn receives all of
   them at once: two bad ops — or eighteen — cost one repair turn, not N.
2. **Partial application.** A sibling of `deriveExtractionShape` returns both the artifact derived
   from the operations that survived and the refusal list (§5). `deriveExtractionShape` becomes a
   thin wrapper over it with unchanged refusals (§8). At repair exhaustion the proposer hands the
   surviving subset onward instead of `[]` (§7).

The changes compose but are separable: change 1 alone fixes the repair economics; change 2 alone
removes the caller's hand-rolled loop; together, exhaustion-with-refusals becomes rare and, when it
happens, non-catastrophic.

## 3. What "refused" means — three classes

The hard part is that the operations are interdependent. A `retype` or a regroup move naming a
dropped path is refused as not-found — the composition rule states this outright ("drop composes
with nothing"; `shape-operation.ts:33-35`, implemented at `shape-operations.ts:147-148` and
`:168-173`) — so one refused operation cascades. The design's core move is to classify refusals by
what they are defeasible against:

| Class             | Meaning                                                                                                       | Collected independently?                           | Examples                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Local**         | The operation is defective against the caller's schema alone, with no other operation applied.                | Yes — one refusal per operation, checkable per op. | Drop of a nonexistent path (`:152-155`); retype of a non-string leaf (`:174-181`); a bracketed path (`:63-72`); a move crossing an array (`:343-349`, `:378-384`).                                     |
| **Consequential** | The operation is defective only because another operation **that is applied** removed or occupied its target. | Yes, but the refusal names the cause.              | Retype or move on a dropped path (`:168-173`, `:350-355`); destination across a dropped path (`:385-398`); a nested drop under an applied drop (§6); a declaration naming a dropped leaf (`:268-275`). |
| **Set-level**     | No single operation is defective; the refusal belongs to the set as a whole.                                  | No — collected once for the key or conspiring set. | Duplicate drop/retype/regroup (`:119-142`); a set of drops that together empty a parent object (`:193-195`).                                                                                           |

A **local** refusal means: this operation cannot be given effect, full stop. A **consequential**
refusal means: this operation cannot be given effect _alongside the operations that were applied_ —
remove the cause and it may become applicable. A **set-level** refusal means: some subset of the set
is jointly inconsistent, and the applier will not pick which member to blame.

Today the applier names the victim, not the culprit — a retype on a dropped path is refused with "it
may name a dropped path, a group, or nothing at all" (`:170-171`), leaving the repair model to guess
whether to retract the retype or the drop. The consequential class exists precisely to carry the
culprit: its refusal record names the operation that removed the target.

The live-run evidence measures this failure directly (`nest-live-run-evidence.md` §2): the refusing
retype was `ashraeRequiredAdditionalCfmImproved`, a leaf the same proposal also dropped; the refusal
pointed at the retype (victim), and the repair turn could not decide whether to retract the retype
or the drop. `cause` is the field that records the named culprit, and it is what the repair turn
lacked in this measurement.

One boundary stays absolute: defects of the **schema** (scalar arrays, unions, records;
`shape-tree.ts:79-100`) and defects of the caller's **declarations that no drop explains** —
`requiredOnCreate` naming a leaf the schema never had (`:268-275`) — are refused hard, aborting the
derivation with today's messages. No operation subset can repair them, so no partial artifact can
exist; the throw keeps the failure at the schema author's desk, which is the Stage 1 argument
(`shape-operation.ts:50-54`).

## 4. Change 1 — the collection pass

The applier's state machine is re-expressed as a fixed sequence of collecting passes rather than a
sequence that throws. No operation is mutated-in-place-then-discovered-broken; each pass validates
declaratively and records:

1. **Schema** — `buildObjectNode` as today (`:109`). A schema defect throws (§3).
2. **Local checks and bucketing** — every operation's paths parsed (`:63-72`), the retype closed set
   checked (`:127-134`), duplicates detected (`:119-142`). Each failure is a refusal record; bucketing
   continues past it.
3. **Drops, declaratively** — every drop is looked up against the pristine schema; not-found is a
   local refusal. Then the surviving drop set is filtered for emptiness (§6) and nested drops are
   marked consequential (§6). What survives is the **applied drop set** — computed set-wise, not by
   sequential mutation (§6).
4. **Retypes** — validated against the schema plus the applied drop set: not-found becomes a
   consequential refusal whose cause names the covering drop; kind checks remain local (`:174-181`).
5. **Regroups** — one refusal unit per regroup operation, never per move within it (§9). Group
   checks (`:310-322`) and per-move checks run against the applied drop set; a move naming a dropped
   path is consequential. Intra-regroup collisions (`:357-366`, `:400-419`) are local to that regroup.
6. **Declarations and provenance** — validated against the final patch (`:202-281`). A conflict with
   an applied drop refuses the **drop** (consequential, cause naming the declaration) — the
   declaration is the caller's invariant, and in the repair-loop context the drop is the model's
   revisable input. A conflict with nothing to blame throws.
7. **Build** — the artifact is built from what survived, and `assertShapeMapping` still runs as the
   post-condition (`:283-287`). A partially-applied artifact is a full `DerivedExtractionShape`, never
   a schema with holes.

No fixpoint is needed, and none is allowed: passes 4 and 5 validate against the _final_ applied drop
set, so a consequential refusal always names a drop that actually applied, and refusing drops (the
only refusal that changes the tree — a retype replaces a leaf in place, `:184-187`, and a regroup
removes then reinserts, `:422-434`) can only restore leaves, never create a new refusal. One pass in
this order terminates.

**What the repair turn gets.** The proposer's shape branch (`operations-proposer.ts:439-459`) calls
the partial surface instead of the throwing one: an empty refusal list is today's success; otherwise
`failure: "shape"` carries **one line per refusal** — each the applier's own message for that
operation, prefixed with the operation it names — and `repairFeedback` (`:462-497`) interpolates the
list into the user turn while the assistant turn still shows the model its prior output verbatim
(`:573-574`). ADR 0016's contract — "repair text is the applier's own error message verbatim"
(ADR 0016:41) — holds per refusal; what changes is that the turn carries all of them. Spike 0009's
eighteen refused regroups would have landed in one repair turn instead of exhausting the budget
(`docs/spikes/0009-basedata-proposer/README.md:26-35`).

## 5. Change 2 — the partial surface

**A sibling function, not a flag.** `deriveExtractionShapePartially(schema, options)` — same inputs,
same options type — returns two things: `shape`, a full `DerivedExtractionShape` derived from the
operations that survived, and `refusals`, the sorted refusal list (§6). A mode flag on the existing
function is the smell this repo has named twice — "a boolean bolted onto a policy function"
(`post-docs-findings.md` P3) and per-group options that never stopped acceding
(`per-group-composition-design.md` §5). A sibling also lets the throwing function keep its signature
and its guarantee unchanged.

**The contract, in three sentences.** Applied and refused **partition the input exactly** — every
operation is in exactly one of the two states; there is no third state and no silent discard.
`refusals` is empty if and only if the artifact is exactly what `deriveExtractionShape` would return
— the two are the same code path, so equivalence is by construction. A non-empty `refusals` list is
the only way the result is smaller than the proposal asked: **the applier never silently produces a
smaller shape.**

Each refusal record names:

| Field       | What it carries                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `operation` | The caller's operation, verbatim.                                                                              |
| `index`     | Its position in the caller's array — identity for diffing, and what makes applied + refused = input checkable. |
| `class`     | `local`, `consequential`, or `set` (§3).                                                                       |
| `reason`    | The applier's own message — the same prose a throw carries today.                                              |
| `cause`     | Present only on consequential refusals: the operation or declaration that removed or occupied the target.      |

**Set-level cases have an op or they do not:**

- **Duplicates of drop or retype** — the duplicated path is dropped (or retyped) identically either
  way, so duplication is redundancy, not conflict: one instance is applied and the duplicates get one
  set-level refusal naming the path and the count. Zeroing a good op over bookkeeping is the failure
  this design exists to stop.
- **Duplicate same-group regroups** — _not_ mergeable: two regroups carry two move sets, and choosing
  one silently discards the other's intent (merging records would last-write-wins an overlapping
  move). All of them are refused, with today's message — "merge the moves into one operation"
  (`:139-141`) — which the proposal directive already instructs (`operations-proposer.ts:239-242`).
- **A set of drops emptying a parent** — `refuseEmptyObjects` names the emptied object, not the drops
  (`shape-tree.ts:169-182`), and only drops can empty an object (§4). The applier refuses **every
  drop under the emptied path**, one record each, each reason naming the emptied path: no single one
  of them is at fault, and picking a survivor would be the applier silently reordering the model's
  intent. Symmetric blame over maximality, deliberately. With the conspiring drops refused, the
  parent's leaves are restored and the artifact is well-formed.

Everything refused is reported; everything else is applied; the artifact is complete or the function
throws.

## 6. Determinism, and a defect this fixes

The operations are documented as a set, not a sequence (`shape-operation.ts:30-31`), so the same set
must yield the same split regardless of input order. The bucketing already gives an order-independent
artifact — maps keyed by unique paths, duplicates refused (`:114-145`) — but the drop application
does not: drops are applied sequentially against a mutating tree (`:149-157`), so the set
`drop "a.b"` plus `drop "a"` applies both when the nested drop comes first, and throws not-found when
the parent comes first. That is a live order-dependence in the pinned source, and it violates the set
contract today.

The partial surface fixes it by defining drops declaratively: a drop is **applied** iff its path
exists in the schema, no applied drop's path properly contains it, and dropping it — together with
all other applied drops — leaves no object empty. Computed outermost-first (fewest segments, then
lexicographic), this is one deterministic pass, and a nested drop under an applied parent becomes a
**consequential** refusal naming the parent drop — the same not-found rule the composition rule
already states (`shape-operation.ts:33-35`), now order-independent.

Two more determinism requirements: the refusal list is **sorted canonically** — by class, then
operation kind, then path or group — never by discovery or input order (today the first throw in
input order decides what a caller sees); and the collision messages that name a _pair_ of moves
(`:357-366`, `:400-419`) derive that pair from the moves sorted canonically, so the named pair does
not depend on the record's key order.

## 7. Where partial application sits relative to the repair loop

**Repair turns still go first — unchanged.** A refusal list is feedback for the model, not a licence
to skip repair: the default budget (one attempt, `operations-proposer.ts:567`) now gets one shot at
fixing _all_ refusals at once, which is strictly better feedback than one refusal.

**At exhaustion, the surviving subset replaces `[]`.** This is the point where the source says
otherwise: ADR 0016 pins "exhaustion returns `[]`. Always." (ADR 0016:23), and the guide repeats it
(`docs/guide/from-a-schema.md:241-245`). The pin is challenged here, on the ADR's own reasoning. The
`[]` default was argued as "keep the pipeline open with an unshaped derivation" (ADR 0016:23) — the
surviving subset is the same property, held more often and more fully: a mostly-good proposal that
would have zeroed everything instead mostly applies, and still never throws. `[]` remains the value
when nothing survives, so the pinned behaviour is a special case of the new one, not a contradiction.
Two boundaries: the two transport-exhaustion exits (`operations-proposer.ts:550-564` and `:591-599`)
keep returning `[]` — no proposal arrived, so there is nothing to partially apply; and
`proposeExtractionShape` composes exactly as today (`:623-630`), applying the survivors with the
caller's declarations, where a declaration conflict still throws (§10, open question 3).

The cost is named plainly: ADR 0016's documented diagnostic — a host surfaces the failure by checking
the operations array for `[]` (ADR 0016:35) — gets weaker. A survivor list of 89 out of 91 does not
announce itself. Open question 1 records the trade and the recommendation.

The amendment is recorded here rather than in a new ADR, following the precedent of ADR 0016's own
inline amendment of its transport-retry scope (ADR 0016:27); the changeset text carries it too (§8).

## 8. Public API and versioning

`@azx/ribo-extractor-openai` gains exports: `deriveExtractionShapePartially`, the result type, and
the refusal record type. That is **additive — a minor changeset**, the same bump the applier and
proposer landed with (`.changeset/derived-extraction-shape.md`,
`.changeset/propose-shape-operations.md`).

Behaviour changes to existing exports, and their honesty requirements:

- `deriveExtractionShape` becomes a wrapper: run the partial surface, and if `refusals` is non-empty,
  throw the **canonically-first** refusal with its message unchanged. Every single-refusal set —
  which is every case the existing suite pins (`shape-operations.test.ts:207-360`) — throws a
  byte-identical message. A multi-refusal set may name a different refusal than input order used to;
  that is the determinism fix (§6), documented in the changeset, not a breaking change to any pinned
  message.
- `proposeShapeOperations`' repair feedback carries all refusals (a prompt-content change) and its
  exhaustion value widens from `[]` to the surviving subset (§7). The signature is unchanged; the
  changeset must state the exhaustion amendment explicitly, the way
  `.changeset/propose-shape-operations.md:18-21` documented the `[]` value it introduced.

Nothing is published yet (AGENTS.md §5.1's note on the export condition applies here equally), so no
major is owed; if a reviewer judges the exhaustion amendment breaking for the `[]` diagnostic, the
fallback is gating the new value behind an option — rejected in §9.

## 9. Considered and rejected

- **A mode flag on `deriveExtractionShape`** (`refusals: "throw" | "collect"`). The boolean-on-a-policy-function
  smell, named twice in this repo's own reviews (§5). A sibling composes; a flag accretes.
- **Per-move granularity inside a regroup.** A regroup is one operation — "merge the moves into one
  operation" (`:139-141`) — and refusing half its moves would invent a nesting the model never
  proposed while breaking the applied + refused = input partition. Atomic per regroup.
- **Auto-merging duplicate same-group regroups.** Disjoint move keys would merge safely, but
  overlapping keys are ambiguous, and the directive already tells the model to merge. The refusal
  stands (`:139-141`).
- **A fixpoint over refusal batches** (re-validate after each batch until stable). Unnecessary — the
  pass order in §4 makes refusals reference only applied causes, and refusing drops can only restore
  leaves — and dangerous: an unbounded validation loop over a model's output is the multi-turn
  bargain ADR 0016 already declined (ADR 0016:12).
- **Collecting refusals by catching throws per operation.** Several refusals are visible only in
  combination — emptiness, duplicates, collisions — and the tree would be rebuilt per attempt. The
  passes already know how to keep going; catching would re-derive what they know.
- **Keeping `[]` at exhaustion and applying partially only inside the repair loop.** Loses the
  salvage: the incident's shape — a mostly-good set at budget exhaustion — is exactly what the
  surviving subset rescues.
- **Partial application inside `proposeExtractionShape` for declaration conflicts.** The declarations
  are the caller's own invariant, supplied after the model's turns are over; throwing there is the
  schema-author's-desk rule (§3), not a refusal to collect.

## 10. Open questions

1. **Exhaustion diagnosability.** With the surviving subset returned at exhaustion, the `[]`-check
   ADR 0016:35 documents stops signalling partial failure. _Recommendation:_ accept the loss — the
   collect-all repair turn (§4) makes exhaustion-with-refusals rare — and revisit a result-carrying
   proposer return (a breaking change) when a host actually needs it.
2. **Empty-by-design vs exhausted-to-empty.** A legitimate empty proposal ("no operations warranted",
   `operations-proposer.ts:249`) and an exhausted one are both `[]`/all-refused today, and the
   distinction ADR 0016:35 calls real stays unnamed in the return value. _Recommendation:_ defer with
   question 1 — naming it requires the same breaking result-type change.
3. **The proposer's probe never sees declarations.** `runAttempt` applies the ops bare
   (`operations-proposer.ts:450`), so a drop that conflicts with `requiredOnCreate` surfaces only
   later, in `proposeExtractionShape` (`:629`), as an unrepairable throw the model never got a chance
   to fix. _Recommendation:_ thread the declarations into the probe in the same change — it is
   internal, needs no API change, and closes exactly the class of failure this design exists for.
4. **Machine-readable refusal codes.** The `reason` is prose, and prose is what the repair turn
   consumes; a host auditing refusals gets `class` and `cause`. _Recommendation:_ stay with prose
   until a second consumer needs to branch on codes (ADR 0016:41's no-special-formatter rule).

## 11. Must-fail tests

- A set of five good operations plus a drop naming a nonexistent path plus a retype of a number leaf:
  the partial surface returns an artifact identical to the five good operations' artifact and exactly
  two refusal records, each carrying the caller's verbatim operation, its index, class `local`, and
  the applier's own message — while `deriveExtractionShape` on the same input still throws, naming
  one of the two.
- The cascading partial case: a good drop of `a.b`, a retype of `a.b.c` (bad only because of the
  drop), and three other good operations — the artifact equals the good operations' artifact with
  `a.b` dropped, the retype is refused as `consequential` with `cause` naming the drop, the drop gets
  no refusal, and the other three apply.
- The reverse cascade: the same drop refused for emptiness (its parent holds only that leaf) with a
  retype under it — the drop is refused as `set` with the emptied path named, the retype **applies**,
  and the artifact keeps the leaf.
- The set `drop "a"` plus `drop "a.b"`, submitted in both input orders — each order yields refusal
  lists naming the same paths with the same classes, and byte-identical artifacts, pinning the fix to
  today's order-dependent throw (`shape-operations.ts:149-157`).
- A set whose drops empty a two-leaf parent — both drops refused, the parent intact in the artifact,
  the rest of the set applied, each refusal naming the emptied path.
- A duplicate drop of one path: applied once, one `set` refusal naming the path and count; duplicate
  same-group regroups: **both** refused with today's merge-the-moves message.
- A pre-existing empty object in the caller's schema with zero operations: a hard whole-result
  refusal in both surfaces, message unchanged (`shape-tree.ts:169-182`).
- A regroup with one array-crossing move among clean moves: the whole regroup refused (atomic), other
  groups' regroups applied, the refusal naming the offending move.
- A `requiredOnCreate` leaf removed by an applied drop: the drop refused as `consequential` with
  `cause` naming the declaration; the same declaration naming a leaf the schema never had: a hard
  throw.
- The wrapper's equivalence: for every set where the partial surface reports refusals,
  `deriveExtractionShape` throws, and the thrown message equals the canonically-first refusal
  record's `reason` byte for byte.
- The repair turn: a fake chat whose first proposal contains two bad operations and whose second
  contains the fix — the repair user turn names **both** refusals, and the proposal is accepted after
  exactly one repair attempt at the default budget.
- Exhaustion: a fake chat whose final proposal is mostly good but never fully valid —
  `proposeShapeOperations` returns the surviving subset, not `[]`; a final proposal that is entirely
  refusable still returns `[]`; and the two transport-exhaustion exits (`operations-proposer.ts:550-564`,
  `:591-599`) still return `[]` — no proposal arrived on that turn to partially apply.
- Every partial artifact passes `assertShapeMapping` — no refusal path skips the post-condition
  (`shape-operations.ts:283-287`).
