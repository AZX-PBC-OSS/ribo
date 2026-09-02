# Three Things the Session Should Own — Design

**Date:** 2026-09-01
**Author:** AZX
**Status:** Draft — for review, no implementation plan written yet
**Repos:** `azx/ribo`
**Depends on:** the session entity (`0f20c72`), the v6 migration repair (`01f3e7a`)

---

## 1. What prompted this

The session entity landed in `0f20c72` and moved extraction, review and write state off the
recording. It stopped short in three places, each of which shows up as a host working around
something core knows but does not expose:

- A session that reaches `done` can never be corrected, so "I misheard the R-value" has no answer
  short of a second session.
- The session owns the write but not the destination it writes to. `relay.ts:402` recovers the
  destination by picking an arbitrary transcribed recording.
- `useReview` returns a flat map of leaf paths, so every host rebuilds the group/instance tree that
  `collectFields` had in hand and flattened.

None of the three is large. Together they are the difference between the session being a real entity
and being a place state was moved to.

## 2. What the three have in common

Each is core holding a fact it declines to model.

The session knows a second review is meaningful — `writtenInstances` exists precisely so a retry
resumes rather than replays — and the state machine has no path to one. The session knows where it
writes and reads that from a recording. The schema walk knows the shape and returns paths.

The result each time is the same: a host reconstructs the fact, and the reconstruction is where the
bugs are. `parseFieldPath` in three review models, the assumption that all recordings in a session
share a `ctx` asserted in a comment at `relay.ts:57` and enforced nowhere, `presentButEmpty` as a
second collection the host cross-references to decide whether a group is absent, empty, or
populated.

## 3. Amending a done session

### 3.1 The state machine is the only blocker, and only because nothing is written

`FINISHED_SESSION_STATUSES` holds `done` and `dead`; `reopenSessionForReview` rescues only `dead`,
on the explicit reasoning that "`done` means the write reached the host tool (reopening would
double-write)" (`outbox.ts:719`).

That reasoning is sound and currently vacuous. `snuggProAdapter.write` throws unconditionally
(`adapter.ts:81`) because vendor egress is gated. Nothing has reached the host tool, so nothing can
be double-written. Letting a `done` session return to `awaiting-review` is safe today for the same
reason the guard exists: there is no write to conflict with.

It will not stay safe. When egress lands, a second review of an already-written session must update
the records it created rather than create more, and that requires keeping the identifier the vendor
assigned. Core does not: `ToolAdapter.write` returns `void` (`adapter.ts:238`). That is a separate
piece of work, tracked as an Asana ticket ("Ribo: instance identity is the array index, so nothing
already written can be corrected"), and this design deliberately does not attempt it.

What this design does commit to is not building a substitute for it in the meantime.

### 3.2 `writtenInstances` is deleted, not repaired

`writtenInstances` records, per collection group, a boolean per array position: true means that
instance was already written and the write step skips it (`instance-write-step.ts:109`). Its purpose
is to let a retry resume mid-patch rather than replay instances that already succeeded.

It is also a live correctness bug. `reopenSessionForReview` preserves it (`outbox.ts:757`), while
`buildInstancePositions` (`review.ts:611`) assigns array indices by first-mention order among the
paths that _survived_ review. So: the first instance of a group writes, the second fails, the session
dies. A reviewer reopens it, deletes the first instance as a mishearing, and resubmits. The survivor
is now index 0, the marker at index 0 is still true from the deleted instance, and the survivor is
silently never written. The write step's own error message recommends this exact recovery path
(`instance-write-step.ts:84`).

Three repairs were considered and rejected.

**Reset the markers on each review cycle.** Does not work. The per-instance idempotency key is
derived from the same array position (`instance-write-step.ts:51`), so the survivor writes under the
key the deleted instance already burned. A vendor honouring `Idempotency-Key` replays the old
response and the survivor still does not land. Silent skip becomes silent dedupe.

**Key the markers by review instance key rather than position.** Requires the keys at write time,
and `resolveReview` flattens them into positions before the write step sees anything. That plumbing
is real work, and it buys a marker that still renumbers whenever extraction re-runs.

**Key the markers by a content hash of the instance.** Self-contained and it does fix the reopen
case. It is also cleverness substituting for the identifier we threw away, and it makes an edited
instance look like a new one — an orphan plus a duplicate rather than an update.

The marker defends a partial-write resume that cannot occur, because no write occurs. While it
exists it carries the bug and invites all three repairs. Deleting it removes the bug, removes the
temptation, and leaves the field free for the receipts that will replace it.

The cost is honest and small: when egress lands, a write interrupted mid-collection will re-attempt
instances it already sent, relying on the per-instance idempotency key alone. That key is what the
guarantee was always supposed to rest on; the marker was belt over braces
(`instance-write-step.ts:14-23` says as much).

### 3.3 What amend is

There is no new method. `reopenSessionForReview` widens its accepted source status from `dead` to
either terminal status, `done` or `dead`. Everything else it does is already what an amend needs:
clear `reviewOutcome`, reset `attempts`, and refuse a session missing `extracted` or
`extractedFromRecordingIds` — a session with nothing to re-present cannot be reviewed afresh. Its
refusal message branches on which status it found, since "already written" and "gave up" are
different things to explain.

Keeping the existing name is deliberate. It already means "re-park this session at
`awaiting-review`", which is exactly what both cases are; a second method would be the same body
under a second name, and renaming to `amendSession` would churn call sites and prose to no end. The
user-facing word can still be "amend" without the API using it.

**`attempts` resets, so an amended session gets a fresh write budget.** The counter is documented as
a per-cycle budget reset on every fresh entry into `awaiting-review`
(`session-schema.ts:95-101`), and an amendment is a new cycle by construction — the reviewer changed
something, so the previous cycle's exhaustion says nothing about this one's chances.

**`lastError` is cleared on a successful write.** `reopenSessionForReview` deliberately preserves
`lastError` because it explains why a `dead` session needed reopening (`outbox.ts:730`). That is
right for `dead` and wrong for `done`, because nothing clears the field on success: `#sessionWrite`
patches status, attempts and `writeResult` only (`relay.ts:420`), so a session that failed once,
retried and succeeded arrives at `done` still carrying an error it already recovered from. An amend
would then present a stale failure as current. The fix belongs at the success patch rather than in
the reopen path — a `done` session should not be carrying an error at all.

Amend does not re-extract. It re-reviews the extraction already on the session, so the instance keys
come off the same snapshot and mean the same things they meant the first time. Re-extraction after
adding a recording is a different feature, out of scope in §7.

## 4. The session owns its destination

`SessionWriteInput.ctx` is documented as "parsed from one of the session's recordings' `ctx`" and
recovered by finding the first transcribed recording (`relay.ts:402`). The comment at `relay.ts:57`
asserts that all recordings in a session share a `ctx` because they are for the same job. Nothing
enforces it, and the field app — where jobs switch under one outbox — is precisely the host that can
break it. `instance-write-step.ts:71` already apologises for the arrangement in its own error text.

`openSession` takes a required `ctx`. The write step reads `session.ctx`; the recording hunt is
deleted.

**`Recording.ctx` stays.** It is redundant for writing once the session owns the destination, and
deleting it is tempting for that reason. It lives on the outbox collection, which is at v6 with real
user data on devices, and removing it buys tidiness at the price of a migration on the one
collection where migrations hurt. The session becomes authoritative for the write; the recording
keeps its capture-time copy and nothing reads it for writing. Both sides get a comment saying so, so
the next reader does not re-derive the question.

The sessions collection is at v0 and has not shipped to any device, so `ctx` is a new field rather
than a migration.

That is true of the collection and not of the path that _creates_ sessions from migrated recordings.
`buildSessionDocument` (`database.ts:390-425`) is the contract half of the v5 → v6 split, minting
session documents from v5 recordings that carried session-level state, and it has nothing to put in
two new required fields. Both are recoverable from the recordings, and recovering them is the same
thing the relay does today, done once at migration time rather than on every write: `ctx` from the
first recording in the group, and `ref` from the `assessmentId` that `migratedSessionId`
(`database.ts:69-78`) already digs out of `recording.ctx`.

`migratedSessionId` is worth noticing on its own account. It is the id-as-assessment-id trick §4.1
rejects, already sitting in the migration — which is some evidence the trick is what a host reaches
for when there is no field for the thing it means.

The v6 migration strategy itself is not touched. It has run on real devices, and editing an executed
strategy is the failure `01f3e7a` was written to fix.

### 4.1 `ref`, and why it is not `ctx`

The host also needs to ask "does a session already exist for this job?" when an auditor opens a job —
resume the existing walkthrough, or start a new one. `SessionQuery` filters on status and limit only,
so today that is answered by making the session id _be_ the assessment id.

`ctx` does not answer it. It is opaque to core by construction, so RxDB cannot index it and a query
over it is a scan.

`openSession` therefore takes a required `ref`: a bounded, indexed string naming what the session is
for. The lookup becomes a real query, and the session keeps its own generated id.

`ref` is a plain string and core gives it no structure. It is not parsed, not validated beyond a
length bound, and carries no meaning core acts on — the same posture as `ctx`, minus the opacity that
makes `ctx` unindexable. Whatever the host puts there is the host's business; core's only contract is
that it can be queried on and that two sessions may share one.

The alternative — keeping id-as-assessment-id — is not merely a trick, and was seriously considered:
if a job can only ever have one session, the primary key expresses exactly that and the lookup is as
fast as it gets. It was rejected because it makes a second session for the same job unrepresentable,
and a re-audit, a return visit to finish a basement, or a QA pass are all plausible. `ref` is not
unique and is not expected to be.

## 5. The review tree

`ReviewFields` is a flat `Record<FieldPath, ReviewField>`, with group and instance structure encoded
in the path text. `collectFields` (`review.ts:394`) walks the schema with the tree in hand and
flattens it; every host rebuilds it with `parseFieldPath`.

Group state arrives separately as `presentButEmpty`, a list of array paths that appeared in the
extraction as empty arrays. A host deciding whether a group is absent, empty, or populated must
cross-reference two collections — and the three-state distinction is exactly the kind a host gets
wrong once each.

`ReviewRequest` gains a tree: groups, their instances, and their leaves, with a state of `absent`,
`empty` or `populated` on each group. `presentButEmpty` folds into that state and stops being a
separate collection.

**It goes on `ReviewRequest`, in core, not on `useReview`.** The structure exists in
`buildReviewRequest`; the playground and any non-React host want it as much as the hook layer does.

**The flat map stays**, as the decision channel. `resolveReview` is path-keyed, and `ReviewFields`'
insertion order is contractual — `review.ts:160-174` is explicit that schema-declaration order is
part of the contract and that `editedFields` and `rejectedFields` follow it. The tree is built from
the same walk and presents the same leaves. Two views, one source: the tree must not become a second
place a leaf can exist.

This is also the vocabulary the instance-identity work will need, since receipts have to be keyed by
instance rather than by array position. Building it now means that work inherits a shape rather than
inventing one.

## 6. Decisions

| ID  | Decision                                                                | Why                                                                                                                             |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `reopenSessionForReview` widens to accept `done` as well as `dead`      | The data an amend needs is already persisted; the state machine was the only blocker, and only because no write occurs          |
| D2  | `writtenInstances` is **deleted**, not repaired                         | It defends a resume that cannot happen, carries a live bug, and every repair substitutes for the identifier we discard          |
| D3  | Amend does not re-extract                                               | Keys come off the same snapshot, so receipts and decisions keep meaning what they meant                                         |
| D4  | `openSession` takes a required `ctx`; the write step reads it           | The session owns the write; recovering the destination from an arbitrary recording is unenforced and the field app can break it |
| D5  | `Recording.ctx` stays                                                   | Deleting it means a migration on the v6 collection with real user data, to buy tidiness                                         |
| D6  | `openSession` takes a required indexed `ref`; the id stays generated    | `ctx` is opaque and unindexable; id-as-assessment-id makes a second session for a job unrepresentable                           |
| D7  | The tree goes on `ReviewRequest`, not `useReview`                       | The structure exists in core's schema walk; non-React hosts need it too                                                         |
| D8  | The flat `ReviewFields` map is retained as the decision channel         | Its ordering is contractual and `resolveReview` is path-keyed; the tree is a second view, never a second source                 |
| D9  | `presentButEmpty` folds into a per-group `absent \| empty \| populated` | A three-state fact split across two collections is a bug every host writes independently                                        |
| D10 | An amended session gets a fresh `attempts` budget                       | `attempts` is already a per-cycle budget; the reviewer changed something, so the last cycle's exhaustion predicts nothing       |
| D11 | `ref` is an unstructured string core never parses                       | Same posture as `ctx`, minus the opacity; the contract is that it is queryable and non-unique                                   |
| D12 | `lastError` is cleared on a successful write                            | Nothing clears it today, so a recovered session reaches `done` carrying a stale error an amend would present as current         |

## 7. Out of scope

- **Instance identity and receipts.** `ToolAdapter.write` returning the created record's id, the
  session storing those, and the write step updating rather than creating. Gated on Helix egress
  signing and tracked as its own Asana ticket. §3.2 exists to avoid pre-building a substitute for it.
- **Re-extraction after adding a recording.** Renumbers instances against receipts and needs
  `rankCandidates` plus a human decision. `recordingSetChanged` (`session-extract.ts:45`) is defined
  with zero callers and there is no path back to `open`, so none of it exists yet regardless.
- **Reading records created elsewhere** — another device, the Snugg Pro web UI. Needs the vendor read.
- **Deleting `Recording.ctx`** (D5).

## 8. Testing

The tests that must fail before the change and pass after:

- A `done` session with an extraction moves to `awaiting-review` on `reopenSessionForReview`, and a
  second submitted review reaches the write step. A `done` session missing `extracted` is refused,
  with a message naming `done` rather than `dead`. A session in any active status is still refused.
- A session that exhausted its attempts, was reopened from `dead`, and succeeded, reaches `done` with
  no `lastError`. A session reopened from `done` starts its next write cycle with `attempts` at zero.
- The reopen case from §3.2, written against the current behaviour so it fails today: partial write,
  session dies, reopen, remove the first instance of a group, resubmit — the surviving instance
  reaches the adapter. This test outlives the marker's deletion and guards the receipts work later.
- A session whose recordings carry divergent `ctx` values still writes to the session's destination,
  and the write step never reads a recording.
- Two sessions sharing a `ref` are both returned by a `ref` query.
- A group absent from the extraction, a group present as an empty array, and a populated group each
  report their own state on the tree — and `presentButEmpty` no longer appears on `ReviewRequest`.
- The tree's leaves and the flat map's keys are the same set, over a schema with nested objects and a
  collection group.

Existing pins that will move: `session-schema.test.ts` pins the zod description against the RxDB
schema field-for-field, so removing `writtenInstances` and adding `ctx` and `ref` are edits there
too, not just in the schema.

## 9. Sequencing

The three are independent and can land in any order. The tree (§5) is worth doing first, because the
instance-identity work will want its vocabulary and because it is the change with no persistence
consequences at all.

Amend (§3) and the `writtenInstances` deletion ship together — deleting the marker without amend
leaves the reopen bug fixed but the capability missing, and adding amend without deleting the marker
puts a second review through the code path that carries the bug.

## 10. Open questions

1. `FINISHED_SESSION_STATUSES` becomes a list with no member the relay treats as truly terminal —
   both `done` and `dead` now have a human-driven way out. Whether the constant still earns its name,
   or wants renaming to something like `RESTING_SESSION_STATUSES`, is worth deciding while the
   docstrings are being edited anyway.
2. A session whose every recording is discarded — carried over unresolved from the session-entity
   design (§12.1 there). Amend does not settle it, and it is the one case where `done` means "nothing
   happened" rather than "the write landed".
