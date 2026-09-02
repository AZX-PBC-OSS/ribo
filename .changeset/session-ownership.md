---
"@azx/ribo-core": major
"@azx/ribo-ui-react": major
---

The session owns its shape, its write destination, and a second review.

**The review contract returns a tree.** `buildReviewRequest` walked groups, instances and leaves and returned only a flat path-keyed map, so every host rebuilt the structure with `parseFieldPath`. `ReviewRequest` now carries the walk's own output — groups, their instances, their leaves, in schema-declaration order — and `useReview` surfaces it as `tree`. The flat `fields` map stays as the decision channel: `resolveReview` is still path-keyed and its ordering is still the contract, so the tree is a second view over the same leaves, never a second source.

`ReviewRequest.presentButEmpty` is replaced by a per-group state of `absent | empty | populated`. "There are none of these" and "never mentioned" are opposite write instructions and neither produces a leaf, so the distinction used to require cross-referencing two collections — a three-state fact every host got to reconstruct for itself.

**The session owns its write destination.** `Outbox.openSession` now requires `ctx`, the opaque destination the adapter parses, and the relay reads it from the session instead of recovering it from whichever transcribed recording it found first. That recovery rested on an unenforced assumption that every recording in a session shares a `ctx`; a host whose jobs switch under one outbox could break it. `Recording.ctx` is unchanged and still carries the capture-time copy.

`openSession` also requires `ref`, a bounded indexed string naming what the session is for, and `SessionQuery` gains a matching filter — so "the session for this job" is a query rather than a trick played on the primary key. `ref` is not unique: a job may have more than one session.

**`writtenInstances` is deleted.** It recorded a boolean per array position so a retry could skip instances already written, and position is not identity: `reopenSessionForReview` preserved the marker while `resolveReview` renumbered the instances that survived review, so a reviewer who deleted an instance could silently strand its neighbour — never written, no error anywhere. Repairing the marker was rejected because the per-instance idempotency key is positional too, so every repair substitutes for the vendor record id that `ToolAdapter.write` discards. An interrupted write now re-attempts instances it already sent, resting on that idempotency key alone.

**A `done` session can be reviewed again.** `reopenSessionForReview` accepts either terminal status rather than only `dead`, so a submitted review can be amended. Its refusal messages name the status they found. `lastError` is now cleared on a successful write, so a session that failed and recovered no longer arrives at `done` carrying the error it overcame.

Breaking changes:

- `Outbox.openSession()` requires `{ ctx, ref }`; it can no longer be called bare.
- `SessionItem` gains `ctx` and `ref`, and loses `writtenInstances`.
- `ReviewRequest` gains `tree` and loses `presentButEmpty`; `useReview` returns `tree` in its place.
- `ToInstanceWriteStepOptions` loses `outbox` — the step no longer persists anything.
- `reopenSessionForReview` accepts `done` as well as `dead`.
