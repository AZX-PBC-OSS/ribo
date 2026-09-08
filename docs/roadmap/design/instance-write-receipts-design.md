# Instance write receipts: `ToolAdapter.write` returns an id, and amend can use it

Status: Draft — for review, no implementation plan written yet.

Tracked in Asana: "Ribo: instance identity is the array index, so nothing already
written can be corrected" (task 1218075751169739).

## 1. The problem

`ToolAdapter.write` returns `void` (`packages/ribo-core/src/adapter.ts:238`). Today
that's sound and vacuous at once: `snuggProAdapter.write` throws unconditionally
(`adapter.ts:81`), vendor egress is gated on Helix HMAC signing (Phase 4 Task 6), and
nothing has ever reached a host tool. `session-ownership-design.md` §3.1-3.2 already
walked through why a *positional* receipt scheme is a dead end — `writtenInstances`,
the old marker that tracked "already written" by array index, had a live data-loss bug
(a reopened session with a removed instance silently skipped the survivor) and was
deleted rather than repaired, because every repair considered (reset markers, key by
review instance key, key by content hash) either didn't fix the bug or substituted
cleverness for the identifier the codebase never kept.

That analysis named the real fix and declined to build it: "a second review of an
already-written session must update the records it created rather than create more,
and that requires keeping the identifier the vendor assigned." This design is that
fix.

It also surfaces a fact the prior design didn't have occasion to state: `linkTargets`
(`session.reviewOutcome.linkTargets`, `instance-identity.ts`) is *already* a second
positional structure with the identical latent bug as the deleted `writtenInstances` —
it's just untriggered because nothing writes yet. `linkTargets[group]` is "positionally
aligned to the resolved patch array... indices follow the first-mention order
established by `buildInstancePositions`" (`instance-identity.ts:47-52`). The moment
egress lands, reopening a session whose instances were edited or reordered will
silently mismatch link decisions to the wrong instance, exactly as `writtenInstances`
did. This design fixes both at once rather than shipping a receipts scheme that
inherits the bug it's meant to prevent.

## 2. Why position-keying and content-hash-keying are both ruled out

Two alternatives were considered and rejected:

- **Content hash of identifying fields** (reusing `snuggProAdapter`'s
  `IDENTIFYING_FIELDS`/`rankCandidates`). Rejected because an edited instance changes
  its hash — amend would create a duplicate record instead of updating the existing
  one, which defeats the entire point of "safe amend."
- **Array position**, matching today's `linkTargets` and the deleted
  `writtenInstances`. Rejected because it's the exact bug class §3.2 already
  documented: a reopened session whose instance list was reordered or had an instance
  removed silently pairs a receipt/link-decision with the wrong instance.

The only approach that's actually safe under instance edit, reorder, and delete is to
key by the instance's own key (`k1`, `k2`, ...) rather than by its position. That key
already exists earlier in the pipeline — the review tree's `ReviewInstanceNode.key`
(`review.ts:210`) — it's `resolveReview` that currently flattens instances into
position-indexed arrays before the write step ever sees them
(`session-ownership-design.md` §3.2, rejected-repair #2: "Requires the keys at write
time, and `resolveReview` flattens them into positions before the write step sees
anything."). This design carries the key through instead of discarding it.

## 3. Design

### 3.1 `ToolAdapter.write` returns the vendor id

```
write: (fields: V, ctx: C, meta: WriteMetadata) => Promise<{ uuid: string }>
```

`uuid` matches the existing naming convention (`ExistingRecord.uuid`,
`instance-identity.ts`) rather than introducing a second name for the same concept.
`write` stays a property, not a method, preserving the strict contravariance on `C`
that `adapter.ts:168-171` calls out.

`snuggProAdapter.write`'s stub keeps throwing (egress is still gated) but its type
signature updates to match. Every test-fixture adapter (`adapter.test.ts`,
`write-step.test.ts`, `instance-write-step.test.ts`) updates its stub return value.

### 3.2 Instance keys survive resolution into the write step

`resolveReview` (`review.ts`) and the write-step pipeline currently discard instance
keys once positions are computed. This design threads `ReviewInstanceNode.key`
alongside position through `buildInstancePositions` / `buildLinkTargets`
(`review.ts:707,799`) and into `toInstanceWriteStep`'s per-instance loop
(`instance-write-step.ts:104-113`), so each `adapter.write` call is paired with both
its array position (still needed to derive the idempotency key —
`deriveInstanceIdempotencyKey` stays positional, since the idempotency key's job is
"stable across retries of this exact queue item," not cross-review identity) and its
instance key (used for receipt storage).

### 3.3 `linkTargets` becomes key-indexed

`PersistedReviewOutcome.linkTargets` (`review.ts:337,352`) changes shape from
`Record<groupPath, ReadonlyArray<string | null>>` (position-indexed) to
`Record<groupPath, Readonly<Record<instanceKey, string | null>>>` (key-indexed).
`buildLinkTargets` (`review.ts:803-816`) changes to emit the new shape. The zod schema
at `review.ts:1074,1081` and its test pin update accordingly. `use-review.ts:233-237`
(the only other reader, which rehydrates a just-computed outcome into the review UI)
updates its `Object.entries` walk to match.

This needs **no RxDB schema version bump**: `reviewOutcome` is stored as
`{ type: "object" }` in the RxDB JSON schema (loose), even though it's validated by
`reviewOutcomeSchema` on the zod side (`session-schema.ts:172,269`). Only the zod
schema and its pin need updating.

It also needs no data migration for existing sessions: `reopenSessionForReview`
already clears `reviewOutcome` on reopen (shipped in #35, "The session owns its shape,
its write destination, and a second review"). A "done" session's stale
position-shaped `linkTargets` is wiped before a new review produces key-shaped ones,
and no history view was found reading `reviewOutcome.linkTargets` for a session that
isn't actively being reviewed.

### 3.4 Receipts: a new, durable, key-indexed session field

New optional session field, `receipts`:

```
receipts?: {
  singleton?: string;
  instances?: Readonly<Record<string /* group */, Readonly<Record<string /* instance key */, string /* vendor uuid */>>>>;
}
```

`singleton` covers the one non-array write in `instance-write-step.ts:99` (fields not
part of any collection group). `instances[group][instanceKey]` covers the per-instance
writes in the loop at `instance-write-step.ts:109`.

Unlike `reviewOutcome`, `receipts` is **not** cleared on reopen — its entire purpose is
to survive across reviews so a later amend pass can find the vendor id to update
against. This is the field a future "write step updates rather than creates" change
(explicitly out of scope here, see §5) will read.

**Mechanism: the existing `SessionWriteStep` return channel, not a new dependency.**
`relay.ts`'s `#sessionWrite` (`queue/relay.ts:433-452`) already persists whatever
`sessionWrite` (the function `toWriteStep`/`toInstanceWriteStep` produce) resolves
with, into the session's `writeResult` field: "Anything returned is persisted as
`writeResult`" (`SessionWriteStep`'s own doc comment, `relay.ts:74`). Both real
compositions currently resolve `void` (`write-step.ts:90`,
`instance-write-step.ts:66-114`), so `writeResult` is presently always absent in
practice — this channel is unused, not spoken for. `session-ownership-plan.md` Task 3
flagged that the receipts work "will need a durable channel again and should re-add it
deliberately rather than inherit an unused dependency" (the deleted `outbox` option on
`ToInstanceWriteStepOptions`); this design's answer is: reuse the return channel that
already exists for exactly this purpose, rather than adding a callback dependency.

`SessionWriteStep`'s return type changes from `Promise<ExtractedFieldMap | void>` to
`Promise<SessionWriteResult | void>`, where `SessionWriteResult` carries `fields`
(renamed from today's bare `ExtractedFieldMap`, unchanged meaning) and the new
`receipts` alongside it. `toWriteStep` captures the single `write` call's `uuid` as
`receipts.singleton`. `toInstanceWriteStep` accumulates a `receipts.instances[group][instanceKey]`
entry per successful instance write (plus `receipts.singleton` for the singleton
patch, if any), and returns the accumulated object once the loop finishes. `relay.ts`'s
`#sessionWrite` then persists `result.fields` into `writeResult` as today, and merges
`result.receipts` into the session's `receipts` field — additively (existing groups'
instance ids are kept, only the keys present in this pass's result are overwritten) so
a receipt from an earlier pass is never silently lost if a later pass's reviewed patch
happens not to touch that instance.

### 3.5 Sessions schema v1 → v2

Adding `receipts` as a new top-level optional field on the session document requires a
version bump, per the existing pattern (`SESSION_MIGRATION_STRATEGIES`,
`session-schema.ts:241-243`, and the v0→v1 precedent that added
`extractionUsage`). The migration is an identity function
(`2: (doc) => doc`) since the field is optional and new documents simply start
without it.

## 4. What this does *not* do

Consuming `receipts` to decide "update, don't create" at write time —
i.e. actually calling something like `adapter.update(uuid, fields, ctx, meta)`
instead of `adapter.write` when a receipt already exists for an instance — is out of
scope for this design, same as `session-ownership-design.md` §7 originally deferred
it. This design only makes the id available and durable; teaching the write step to
use it for amend is separate follow-up work, still gated on Snugg Pro egress actually
landing (until then there's nothing to test against). The Asana ticket referenced
above stays open until that follow-up ships.

## 5. Testing

- `adapter.test.ts` / `write-step.test.ts` / `instance-write-step.test.ts`: update
  stub adapters to return `{ uuid }`, assert the write step no longer discards it —
  specifically, that the receipt callback fires once per instance with the correct
  `(group, instanceKey, uuid)` triple, including for a resolved review whose instances
  are in a different order than first-mention (regression test for the exact bug
  class §2 rules out).
- A new test exercising `linkTargets`' key-indexed shape end to end: build a review
  with 3 instances, remove the middle one, resubmit, and confirm the surviving
  instances' link decisions stay paired with their own keys — the direct analog of the
  `writtenInstances` regression test, now for `linkTargets`.
- `session-schema.test.ts`: pin the v2 schema, confirm a v1 doc (no `receipts`)
  migrates cleanly and a v2 doc round-trips.
