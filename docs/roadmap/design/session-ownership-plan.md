# Session Ownership Implementation Plan

> **Executing this:** one task at a time, in order, each ending with its own test cycle and its own
> review. Steps use checkbox (`- [ ]`) syntax so progress is trackable. Every task's final step
> before the commit runs a mutation and reports what it saw — a test nobody has watched fail is not
> a gate.

**Goal:** Give the session the three things it should own — the shape of its own review, the
destination it writes to, and a lifecycle that admits a second review — and delete the positional
write marker that stands in for an identity we do not keep.

**Architecture:** `ReviewRequest` gains a group/instance/leaf tree built by the same schema walk that
already produces the flat map, with per-group `absent | empty | populated` state replacing
`presentButEmpty`. `openSession` takes a required opaque `ctx` (the write destination) and a required
indexed `ref` (what the session is for), so the relay stops recovering the destination from an
arbitrary recording and "the session for this job" becomes a query. `writtenInstances` is deleted
rather than repaired, and `reopenSessionForReview` widens to accept `done` as well as `dead`.

**Tech Stack:** TypeScript (ESM-only), RxDB 17 (Dexie storage, migration-schema plugin), zod 4,
Vitest 4 (`unit` = node, `browser` = real Chromium via Playwright), React 19.

**Design:** [`session-ownership-design.md`](session-ownership-design.md). Read it before Task 1.
Where this plan and the design disagree, the design wins and the plan is wrong.

## A gap this plan closes that the design did not anticipate

The design treats `ctx` and `ref` as new required fields on a collection that has never shipped, and
concludes there is no migration. That is true of the sessions collection itself and false of the
path that *creates* sessions from migrated recordings.

`buildSessionDocument` (`database.ts:390-425`) is the contract half of the v5 → v6 expand/contract
split: it mints session documents from v5 recordings that carried session-level state. It has no
`ctx` and no `ref` to supply, and `sessionDocumentSchema` is a `strictObject`, so adding two required
fields breaks it.

Both are recoverable from the recordings themselves, and doing so is not a workaround — it is the
same recovery the relay does today, done once at migration time instead of on every write:

- `ctx` comes from the first recording in the group, which is exactly what `relay.ts:402` picks.
- `ref` comes from the `assessmentId` already dug out of `recording.ctx` by `migratedSessionId`
  (`database.ts:69-78`), falling back to the same singleton sentinel that function uses.

`migratedSessionId` is worth reading before Task 2: it is the id-as-assessment-id trick the design
rejects, sitting in the migration. Task 2 converts it to a `ref` and leaves the id generated.

**Do not touch the v6 migration strategy itself** (`database.ts:160-195`). It has run on real devices.
It salvages `writtenInstances` into the recording's `legacy` bag, and it should keep doing so even
after the session field is deleted — an unread key in a bag costs nothing, and editing a strategy
that has already executed is the failure mode `01f3e7a` was written to fix. Task 3 stops *reading*
`writtenInstances` out of the bag; it does not stop it being put there.

## Global Constraints

- **ESM only.** Relative imports carry a `.js` extension though the source is `.ts`.
- **`import type`** for type-only imports — lint-enforced.
- **Comments explain WHY, not what.** This codebase comments heavily on rationale and not at all on
  mechanics. Match that, including in the docstrings this plan edits.
- **`ribo-core` must not depend on any engine package.** Seams are defined in core.
- **No back-compat burden.** The SDK has no consumers outside this repo and the field app's vendored
  copy. Breaking changes are fine; deleting persisted fields is free where the field has not shipped.
- **`sessionDocumentSchema` and `sessionRxSchema` are pinned field-for-field** by
  `session-schema.test.ts`. Every schema edit is two edits plus the pin.
- **Every test must be able to fail.** Before finishing a task, break the implementation the test
  covers, watch the test fail, restore, and report what you saw.
- **`./check.sh` is the "am I done?" signal.** A task is not finished on a green unit run alone.

---

## Task 1: The review tree

The schema walk in `collectFields` (`review.ts:394`) descends groups, instances and leaves, and
returns only a flat path-keyed map. Every host rebuilds the structure with `parseFieldPath`. This
task returns the structure core already had.

`presentButEmpty` is absorbed. A group's state becomes one of `absent` (the group was not in the
extraction), `empty` (present as an empty array — "there are none of these") or `populated`. Today a
host must consult `ReviewRequest.fields` and `ReviewRequest.presentButEmpty` together to tell those
apart, which is a three-state fact split across two collections.

**Files:**

- Modify: `packages/ribo-core/src/review.ts` — `ReviewRequest`, `collectFields`,
  `buildReviewRequest`; `presentButEmpty` removed from the public shape
- Modify: `packages/ribo-core/src/index.ts` — export the new tree types
- Modify: `packages/ribo-ui-react/src/use-review.ts` — surface the tree, drop `presentButEmpty`
- Test: `packages/ribo-core/src/review.test.ts`
- Test: `packages/ribo-ui-react/src/use-review.browser.test.tsx`

**Interfaces:**

- Produces: a tree hanging off `ReviewRequest` — groups by name, each carrying its state and, for a
  collection group, its instances keyed as review already keys them (`k1`, `k2`, …), each instance
  carrying its leaves. A leaf is the existing `ReviewField`, not a copy of one.
- Produces: the flat `ReviewFields` map, unchanged and still exported. Task 4 and every existing
  caller of `resolveReview` depend on it.
- Consumes: nothing from other tasks. This task is independent and goes first.

**The rule that governs this task:** the tree is a second *view*, never a second *source*. A leaf
exists once, in the flat map, and the tree references it. `ReviewFields`' insertion order is
contractual — `review.ts:160-174` states that schema-declaration order is part of the contract and
that `editedFields` and `rejectedFields` follow it — so the tree must be built from the same walk in
the same order, not sorted or regrouped afterwards.

- [ ] **Step 1: Write the failing tests**

In `review.test.ts`, against an adapter schema with a nested object group, a collection group and a
scalar leaf at top level:

- A group absent from the extracted data reports state `absent`.
- A group present as an empty array reports state `empty`.
- A group with two instances reports state `populated` and exposes exactly two instances, keyed `k1`
  and `k2` in first-mention order.
- The set of leaf paths reachable by walking the tree equals the key set of `request.fields`.
- Walking the tree yields leaves in the same order as `Object.keys(request.fields)`.
- `presentButEmpty` is no longer a property of `ReviewRequest`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run packages/ribo-core/src/review.test.ts`
Expected: FAIL — the tree property does not exist.

- [ ] **Step 3: Build the tree in `collectFields`**

Thread a tree accumulator through the existing recursion alongside the flat `out` map. The walk
already distinguishes the three cases it needs — `ZodObject` (recurse), `ZodArray` (a collection
group, with the empty-array case already detected where `presentButEmpty` is pushed today), and a
leaf. Group state falls out of what the walk already sees: the array node being absent, being an
empty array, or having elements.

Do not add a second traversal. A tree built by re-walking the flat map is the host code this task
exists to delete.

- [ ] **Step 4: Remove `presentButEmpty` from the public shape**

`resolveReview` consumes it at `review.ts:933` to decide which groups emit `[]`. Read the group
state off the tree instead. This is the one behavioural coupling between the two collections and it
must keep working: a group that was present-but-empty still resolves to an empty array, and an absent
group still resolves to nothing at all.

- [ ] **Step 5: Surface it from `useReview`**

`use-review.ts` returns `presentButEmpty` at line 118 and `fields` at 94. Replace the former with the
tree. Leave `fields` alone — Task 4 has no opinion about it and the decision channel is unchanged.

- [ ] **Step 6: Run the full core and hook suites** — Expected: PASS.

Run: `pnpm vitest run packages/ribo-core` and `pnpm vitest run packages/ribo-ui-react`

- [ ] **Step 7: Mutate to prove the tests bite**

Make `collectFields` report `populated` for an empty array; the state test must fail. Make the tree
omit leaves of nested objects; the leaf-set-equality test must fail. Sort the tree's groups
alphabetically; the ordering test must fail. Restore, re-run, report all three.

- [ ] **Step 8: Commit**

`git add packages/ribo-core/src/review.ts packages/ribo-core/src/index.ts packages/ribo-ui-react/src/use-review.ts` plus the two test files, and commit as
`feat(core): return the review tree, not a flat map plus a list of empty groups`.

---

## Task 2: `ctx` and `ref` on the session

The session owns the write and not the destination. `relay.ts:402` reads the destination back off
whichever transcribed recording it finds first, on the strength of a comment at `relay.ts:57`
asserting that every recording in a session shares a `ctx`. Nothing enforces that, and
`instance-write-step.ts:71` already apologises for the arrangement in its error text.

**Files:**

- Modify: `packages/ribo-core/src/queue/session-schema.ts` — two required fields, `ref` indexed
- Modify: `packages/ribo-core/src/queue/outbox.ts` — `OpenSessionInput`, `SessionQuery`, `openSession`
- Modify: `packages/ribo-core/src/queue/database.ts` — `buildSessionDocument` supplies both
- Modify: `packages/ribo-core/src/queue/relay.ts` — read `session.ctx`, delete the recording hunt
- Modify: `packages/ribo-core/src/instance-write-step.ts` and `write-step.ts` — error text
- Modify: `packages/ribo-core/src/recording.ts` — a comment on `Recording.ctx` (see below)
- Modify: `playground/src/recorder-handle.ts:130` — the one real `openSession()` call site
- Test: `packages/ribo-core/src/queue/session-schema.test.ts`, `session-outbox.test.ts`,
  `outbox.browser.test.ts`, `relay.browser.test.ts`

**Interfaces:**

- Produces: `openSession` requires `{ ctx, ref }`; `id` and `idempotencyKey` stay optional and
  generated. `SessionItem` carries both.
- Produces: `SessionQuery` gains `ref`, matched exactly. It is not unique — two sessions may share
  one, and a query returns all of them.
- Produces: `SessionWriteInput.ctx` is unchanged in type and now sourced from the session.
- Consumes: nothing from Task 1.

**`Recording.ctx` is not removed** (design D5). It becomes redundant for writing and stays because it
lives on the outbox collection, which is at v6 with real user data on devices; deleting it buys
tidiness at the price of a migration on the one collection where migrations hurt. Add a comment on
both sides saying which is authoritative, so the next reader does not re-derive the question.

- [ ] **Step 1: Write the failing tests**

- `openSession` rejects a call with no `ctx`, and rejects one with no `ref`.
- A session opened with a `ctx` returns it on the `SessionItem`.
- Two sessions opened with the same `ref` are both returned by a query on that `ref`, and a query on
  a different `ref` returns neither.
- The write step receives the *session's* `ctx` when the session's recordings carry a different one —
  the test that would have passed by accident before, and the one that pins the whole task.
- A session with no transcribed recordings still reaches the write step, where before the missing
  recording was a terminal error (`relay.ts:405`).
- `sessionRxSchema` and `sessionDocumentSchema` agree field-for-field, including the two new fields
  and `ref`'s index.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run packages/ribo-core/src/queue`
Expected: FAIL — `openSession` accepts no-argument calls today.

- [ ] **Step 3: Add the fields to both schema descriptions**

`ctx` is `unknown` and unindexed — opaque to core, same posture as `Recording.ctx`. `ref` is a
bounded string with an index; give it the same `maxLength` treatment the other indexed strings get,
since RxDB needs bounded widths to build sortable index keys. Add `ref` to `indexes` alongside
`openedAt`. Both are required, so both join `required`.

Keep the sessions collection at `version: 0`. It has not shipped to any device, so these are new
fields and not a migration — confirmed with the user before this plan was written.

- [ ] **Step 4: Require them at `openSession`, and query on `ref`**

`OpenSessionInput` currently defaults to `{}` (`outbox.ts:583`), which is what makes
`outbox.openSession()` legal. Requiring two fields removes the default. `SessionPatch` already
excludes `id`, `openedAt` and `idempotencyKey` from what may change after opening; `ctx` and `ref`
join that exclusion — the destination and the subject of a session are decided once, and re-deciding
either would strand a write or silently re-target it.

- [ ] **Step 5: Supply both in `buildSessionDocument`**

Per the gap section above: `ctx` from the first recording in the group, `ref` from the `assessmentId`
`migratedSessionId` already extracts, with the same singleton fallback. Leave `migratedSessionId`
itself in place — the session id it produces is still what groups recordings together — but note in
a comment that `ref` is now the field carrying that meaning.

- [ ] **Step 6: Delete the recording hunt in the relay**

`relay.ts:401-408` lists the session's recordings, finds the first transcribed one, and throws a
terminal error if there is none. All three go. Pass `session.ctx` straight through. Update the error
text at `instance-write-step.ts:71` and `write-step.ts` — both blame `Recording.ctx` at enqueue, and
should now name the session's `ctx` at open.

- [ ] **Step 7: Fix the playground call site**

`playground/src/recorder-handle.ts:130` calls `outbox.openSession()` bare. Give it both fields.

- [ ] **Step 8: Run everything** — Expected: PASS.

Run: `./check.sh`

- [ ] **Step 9: Mutate to prove the tests bite**

Make `openSession` default `ref` to the empty string; the rejection test must fail. Have the relay
read `ctx` off the first recording again; the divergent-ctx test must fail. Remove `ref` from
`sessionRxSchema.indexes`; the pin test must fail. Restore, re-run, report all three.

- [ ] **Step 10: Commit**

Commit as `feat(core): the session owns its write destination and what it is for`.

---

## Task 3: Delete `writtenInstances`

This task begins by writing a test for a bug that exists today, watching it fail, and then removing
the field whose presence causes it. The test outlives the deletion: when receipts arrive (the Asana
ticket "Ribo: instance identity is the array index, so nothing already written can be corrected"),
this is the test that stops them reintroducing positional identity.

**Files:**

- Modify: `packages/ribo-core/src/queue/session-schema.ts` — remove the field from both descriptions
- Modify: `packages/ribo-core/src/queue/database.ts:403,422` — stop reading it when building sessions
- Modify: `packages/ribo-core/src/instance-write-step.ts` — remove the skip, the progress write, and
  the now-unused `outbox` option
- Test: `packages/ribo-core/src/instance-write-step.test.ts`
- Test: `packages/ribo-core/src/queue/session-schema.test.ts`

**Interfaces:**

- Produces: `ToInstanceWriteStepOptions` loses `outbox`. It existed solely to persist the marker
  mid-loop. The receipts work will need a durable channel again and should re-add it deliberately
  rather than inherit an unused dependency.
- Consumes: nothing. Independent of Tasks 1 and 2.

**Do not repair the marker.** The design's §3.2 records three repairs and why each fails; the short
version is that the per-instance idempotency key is positional too (`instance-write-step.ts:51`), so
fixing the marker alone converts a silent skip into a silent dedupe against the wrong record.

- [ ] **Step 1: Write the failing test — the reopen case**

Against a fake adapter that records what it was asked to write: a session with a collection group of
two instances; the first write succeeds and the second throws; the session dies. Reopen it, remove
the *first* instance from the review, resubmit, and let the write step run.

Assert the surviving instance reached the adapter. Today it does not: it is now index 0, the marker
at index 0 is still true from the deleted instance (`outbox.ts:757` preserves it across reopen,
`review.ts:611` renumbers survivors), and `instance-write-step.ts:109` skips it.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/ribo-core/src/instance-write-step.test.ts`
Expected: FAIL — the adapter was never asked to write the surviving instance.

This failure is the bug. Read the assertion output before continuing; it is the only time anyone
will see it.

- [ ] **Step 3: Remove the field from the schema descriptions**

Both `sessionDocumentSchema` and `sessionRxSchema`, plus the pin in `session-schema.test.ts`. Also
remove the paragraph documenting it in the `SessionDocument` docstring.

- [ ] **Step 4: Stop salvaging it into constructed sessions**

`database.ts:403` reads `writtenInstances` out of the legacy bag and `:422` spreads it onto the
session. Both go.

**Leave the v6 migration strategy alone** (`database.ts:160-195`). It has run on real devices; it
should keep putting `writtenInstances` into the recording's `legacy` bag. An unread key in a bag
costs nothing, and editing an executed strategy is the failure `01f3e7a` fixed.

- [ ] **Step 5: Remove the skip and the progress write**

`instance-write-step.ts:105-119`: the accumulator, the `continue` on an already-written index, the
`markInstanceWritten` helper and the `patchSession` call. Every instance is written every attempt,
resting on the per-instance idempotency key alone — which is what the guarantee was always supposed
to rest on (`instance-write-step.ts:14-23`). Drop `outbox` from the options and from the docstring.

Record in the docstring what was given up: a write interrupted mid-collection now re-attempts
instances it already sent. That is a deliberate trade, not an oversight.

- [ ] **Step 6: Run the tests** — Expected: PASS, including Step 1's.

Run: `./check.sh`

- [ ] **Step 7: Mutate to prove the test bites**

Reintroduce a positional skip in the write loop; Step 1's test must fail again. Restore, re-run,
report.

- [ ] **Step 8: Commit**

Commit as `fix(core): delete writtenInstances — a positional marker for an identity we do not keep`,
with a body naming the reopen bug it removes and the trade it makes.

---

## Task 4: Amend — widen the reopen path to `done`

Ordered after Task 3 deliberately. Shipping amend while the marker exists puts a second review
through the code path that carries the bug.

**Files:**

- Modify: `packages/ribo-core/src/queue/outbox.ts:733` — accept `done` as well as `dead`
- Modify: `packages/ribo-core/src/queue/session-schema.ts` — the `FINISHED_SESSION_STATUSES`
  docstring, which currently states `done` has no way out
- Modify: `packages/ribo-core/src/queue/relay.ts:420` — clear `lastError` on a successful write
- Test: `packages/ribo-core/src/queue/session-outbox.test.ts`, `relay.browser.test.ts`

**Interfaces:**

- Produces: `reopenSessionForReview` accepts either terminal status. No new method — the body is the
  same, and a second name for it would be a second thing to keep in step. "Amend" stays the
  user-facing word without the API using it.
- Consumes: Task 3's deletion. Do not start this task before it lands.

- [ ] **Step 1: Write the failing tests**

- A `done` session with `extracted` and `extractedFromRecordingIds` moves to `awaiting-review`, and a
  second submitted review reaches the write step.
- A `done` session missing `extracted` is refused, with a message naming `done` — not `dead`.
- A session in any active status is still refused.
- A session reopened from `done` starts its next write cycle with `attempts` at zero (design D10).
- A session that failed a write, was retried and succeeded reaches `done` with no `lastError`
  (design D12).

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run packages/ribo-core/src/queue/session-outbox.test.ts`
Expected: FAIL — the guard at `outbox.ts:738` refuses anything that is not `dead`.

- [ ] **Step 3: Widen the guard**

Accept `done` or `dead`. The existing checks for `extracted` and `extractedFromRecordingIds` apply
unchanged — a session with nothing to re-present cannot be reviewed afresh, whichever terminal state
it came from. Branch the refusal message on which status was found: "already written" and "gave up"
are different things to explain to a caller.

`attempts` already resets to `0` in this method, which is the fresh budget D10 asks for. Leave it.

- [ ] **Step 4: Clear `lastError` on a successful write**

`reopenSessionForReview` deliberately preserves `lastError` (`outbox.ts:730`), which is right for a
`dead` session and wrong for a `done` one — because nothing clears the field on success. The success
patch at `relay.ts:420` sets status, attempts and `writeResult` only, so a session that failed once
and then succeeded arrives at `done` still carrying the error it recovered from, and an amend would
present that stale failure as current. Clear it at the success patch. A `done` session should not be
carrying an error at all.

- [ ] **Step 5: Correct the state-machine docstrings**

`session-schema.ts:14-15` draws `dead ⇢ awaiting-review` and `:64` states that `done` has no way out.
Both are now wrong. Update the diagram and the prose.

`FINISHED_SESSION_STATUSES` now has no member the relay treats as truly terminal — both members have
a human-driven way out. The design's §10.1 raises whether the constant still earns its name. Do not
rename it in this task; note the question in the docstring and leave the decision to a follow-up, so
a rename does not ride along with a behaviour change.

- [ ] **Step 6: Run everything** — Expected: PASS.

Run: `./check.sh`

- [ ] **Step 7: Mutate to prove the tests bite**

Restore the `dead`-only guard; the amend test must fail. Remove the `lastError` clear; the stale-error
test must fail. Restore, re-run, report both.

- [ ] **Step 8: Commit**

Commit as `feat(core): a done session can be reviewed again`.

---

## Not in this plan

- **Receipts and instance identity** — `ToolAdapter.write` returning the created record's id, the
  session storing them, the write step updating rather than creating. Gated on Helix egress signing
  and tracked as its own Asana ticket. Task 3 exists partly to avoid pre-building a substitute.
- **Re-extraction after adding a recording.** `recordingSetChanged` (`session-extract.ts:45`) is
  defined with zero callers and there is no path back to `open`.
- **Deleting `Recording.ctx`** (design D5).
- **Renaming `FINISHED_SESSION_STATUSES`** (design §10.1).
- **The stale D3 and §8 in `session-entity-design.md`**, which claim nothing about instance identity
  is stored while `linkTargets` is built and persisted. Worth a separate docs pass; it is not this
  plan's scope and correcting it here would bury it.
