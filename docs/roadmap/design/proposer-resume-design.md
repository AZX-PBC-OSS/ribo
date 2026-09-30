# The shape proposer resumes from committed work instead of re-proposing

**Date:** 2026-09-30
**Status:** Designed, not built.
**Question answered:** When a proposal has refused operations, how should the repair turn work so
that the operations that applied are never lost?
**Depends on:** `operations-proposer.ts` (one proposal plus repair, ADR 0016; surviving subset at
exhaustion, ADR 0024), `deriveExtractionShapePartially` and its refusal record (`shape-refusal.ts`,
ADR 0024), `leaf-inventory.ts` (the rendered field list and its declaration tags), and the shape
mapping (`shape-mapping.ts`).

---

## 1. The answer, before the argument

**Operations that apply are committed and never re-sent; a repair turn shows the model the schema as
the committed operations left it and asks only for what is still missing.** The model's reply is a
delta, added to the committed set. Replying with just the fixes, which is what broke today's loop,
becomes the correct answer by construction.

## 2. The defect this replaces

Measured 2026-09-30 in spike 0012's probes (`gpt-5.6-luna`, the Snugg Pro schema with descriptions
stripped, the proposer told to hint every field). Attempt 1 returned 448 operations; the applier
refused 2, a duplicate pair. The repair message asked for "the revised set", the model returned
only the one fixed operation, the loop accepted that valid one-operation answer as success, and 446
surviving operations were discarded.

The loop takes the last successful answer, not the best one, and every retry re-sends the whole
proposal: the model's previous answer rides along as an assistant turn (12k tokens in that case).
ADR 0024 already fixed the same loss at exhaustion; this is the successful-repair case it left
open, and it applies to any large proposal, not only hints.

## 3. What was decided, and by whom

Decided in conversation before this design was written:

- **Commit what succeeded, then resume** (the user's proposal), rather than auto-merging survivors
  back into a full re-proposal, or a one-operation-per-turn tool loop.
- **Repair only.** Resume turns happen exactly where retries happen today, when something was
  refused or an attempt failed. Continuation turns after a clean attempt, and per-group passes,
  are out of scope (§8).
- **Transport exhaustion returns the committed set**, not `[]`.

## 4. What gets committed

After each attempt that parses, the partial applier runs over the committed set plus the attempt's
new operations.

- **Committed:** every new operation that applied, except one that a refusal names as its cause.
- **Not committed, and sent back with the reason:** refused operations and the culprits they name;
  both halves of a set conflict (a duplicate pair, a field claimed by two nests); operations that
  conflict with a declaration.
- **Committed operations are never re-validated away.** A new operation that conflicts with a
  committed one is refused against it, and the reason names the committed operation. Because a
  culprit is never committed, the model never needs to retract a committed operation.
- **A new operation identical to a committed one is ignored** before validation. Without this, a
  model that re-sends an operation it already had would hit a duplicate conflict — and for
  operations whose duplicates are all refused, lose the original.
- **An attempt that fails outright** — not JSON, the wrong response schema, a model verdict such as
  a refusal or `length` — commits nothing new; the next turn carries the error.
- **Order.** The result lists committed operations in the order they were committed.

## 5. The resume turn

- **A fresh request, not a growing conversation:** the system prompt, the field list as it stands,
  and the refusal block. No previous answer is echoed back. Each turn stays about the size of the
  first, however large the proposal.
- **The field list shows committed operations as tags** on the original paths, in the vocabulary
  the declaration tags introduced: `[dropped]`, `[retyped → number]`, `[moved → <new path>]`. Paths
  stay in the caller's original space, because that is where operations are addressed; showing
  post-move paths would invite the model to name paths the applier refuses. Dropped fields keep
  their line, tagged, so the model can see not to propose them again.
- **The tags come from the derived artifact, not re-derivation.** The mapping gives each extraction
  path's `source` (a move is a source whose extraction path differs) and its `retype`; a dropped
  field is an original leaf that is no leaf's source.
- **The refusal block** is today's text — one line per refused operation, with its reason and any
  named culprit — ending with the instruction: propose only new operations, the fixes for these and
  anything else you intend; tagged operations are applied and locked.
- **The directive gains one paragraph** explaining resume turns and the tags. The first attempt's
  prompt is otherwise unchanged.

## 6. Contract, records and surroundings

- **Public API unchanged.** Same `proposeShapeOperations` signature and return type;
  `maxRepairAttempts` counts resume turns. Behaviour: a turn with no refusals returns the committed
  set plus that turn's operations. At exhaustion, the committed set plus the last turn's clean
  operations — the rule of §4 applied once more. On transport exhaustion, the committed set (still
  `[]` if it happens before anything was committed).
- **A new ADR** records repair as a resume over a committed set, amending ADR 0016 (full
  re-proposal each retry; `[]` on transport exhaustion) and ADR 0024 (exhaustion returns the final
  proposal's survivors). ADRs are not rewritten: 0016 carries amendment notes today, and the index
  marks the amendment the same way. Numbered after a fetch, across every pushed branch.
- **Stale citations.** `operations-proposer.ts` cites "ADR 0023" where it means ADR 0024 (0023 is
  the unwrapped-group decision). The header these sit in is rewritten here, so they are corrected
  here.
- **Existing tests change on purpose.** `operations-proposer.test.ts` and
  `operations-proposer-partial.test.ts` pin today's format: the echoed assistant turn and "the
  revised set". Each is updated individually, stating what it still proves; none is rewritten in
  bulk.
- **Also updated:** the guide's repair paragraph in `docs/guide/from-a-schema.md`; the file header
  of `operations-proposer.ts`, which argues for one proposal plus repair; a minor changeset for
  `@azx/ribo-core`.
- **Hints.** When the `hint` operation lands (branch `worktree-hint-operation`, not merging on
  current evidence), the field list gains a `[hinted]` tag. Not part of this change.

## 7. Tests and a real-model check

Each test is written to fail against today's loop, with a scripted chat.

1. **The collapse.** Attempt 1 returns many operations, one duplicate pair among them; the resume
   reply contains only the fix. The result is every survivor plus the fix.
2. **Culprits are not committed.** A drop and a retype on the same field: the retype is refused
   naming the drop, neither is committed, both are listed; a reply with only the drop commits it.
3. **Set conflicts.** Neither half of a duplicate pair is committed; a reply with one commits it.
4. **The resume request's shape.** A fresh request — system prompt, tagged field list, refusal
   block, no echoed answer — with `[dropped]`, `[retyped → number]` and `[moved → …]` each on the
   right field.
5. **A repeated committed operation** in a reply is ignored: no refusal, no duplicate.
6. **A new operation conflicting with a committed one** is refused naming it; the committed one
   stays.
7. **Exhaustion** returns the committed set plus the last reply's clean operations.
8. **An outright failure in a resume turn** commits nothing new, the next turn carries the error, and
   nothing committed is lost.
9. **Transport exhaustion after a commit** returns the committed set; before any commit, `[]`.

**Real-model check, not a merge gate.** Rebase the hint branch onto this change and rerun the probe
that lost 446 operations: roughly 440 hints should come back instead of 1. Needs Helix.

## 8. Out of scope

- **Continuation turns** after a clean attempt ("propose anything else"), and **per-group passes**.
  Both could raise hint coverage (small groups got 37–46% versus 2% whole-schema in spike 0012's
  probes); both are paid calls whose value needs measuring. The resume turn's format is built so
  either can reuse it.
- **Hint tags** in the field list (§6).
