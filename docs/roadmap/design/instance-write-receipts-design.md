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

**A caution surfaced and then corrected during design.** An earlier draft of this
document also proposed changing `linkTargets` (`instance-identity.ts`) from
position-indexed to key-indexed, reasoning that it shared the same latent bug class as
the deleted `writtenInstances`. Closer reading of `instance-write-step.test.ts`
(specifically the reopen-and-remove-an-instance regression test at line 436, and every
other test's direct use of `Outbox.submitSessionReview` without ever calling
`buildReviewRequest`/`resolveReview`) showed two things: instance keys are **not
reliably available** wherever a review outcome can legally be submitted from (only
`linkTargets` might carry them, and only when a human made a link decision — `linkTargets`
is genuinely optional, by design, unlike structural identity), and — because nothing
consumes `receipts` yet (§4) — keying by position vs. key made no provable difference to
correctness for this design's actual scope. Re-keying `linkTargets` was dropped, and
`linkTargets` is unchanged by this design. What's kept instead is a **new, dedicated,
required** field carrying real instance keys — see §3.2.

## 2. Why position-keying and content-hash-keying are both ruled out for the receipts key itself

Two alternatives were considered and rejected:

- **Content hash of identifying fields** (reusing `snuggProAdapter`'s
  `IDENTIFYING_FIELDS`/`rankCandidates`). Rejected because an edited instance changes
  its hash — amend would create a duplicate record instead of updating the existing
  one, which defeats the entire point of "safe amend."
- **Array position**, matching today's `linkTargets` and the deleted
  `writtenInstances`. Rejected on the same grounds `writtenInstances` was deleted for:
  it is not identity, and a reader should not have to reason about whether a position
  still means the same thing across a review cycle.

The chosen approach is to key by the instance's own key (`k1`, `k2`, ...) rather than
its position. That key already exists earlier in the pipeline — the review tree's
`ReviewInstanceNode.key` (`review.ts:210`) — it's `resolveReview` that currently
computes it internally (via `buildInstancePositions`) and then discards it, keeping
only the position it derives. This design makes `resolveReview` keep it.

**Verified, not assumed: instance keys are stable across the amend scenario the ticket
actually names.** `Outbox.reopenSessionForReview` (`queue/outbox.ts:888-896`) only
re-extracts (`status: "extracting"`) when the recording set moved since the last
extraction (`setMoved`); a `done` session being amended with its recording set
unchanged — "this session completed its write, so amending it means reviewing that
extraction again" (`outbox.ts:862`) — goes straight to `awaiting-review` with
`session.extracted` untouched. `collectFields` (`review.ts:453-546`) is a deterministic
walk that assigns `k1`, `k2`, … by array position in that same, unchanged data, so the
common amend case (re-review the same recordings) reassigns the *identical* keys in
the *identical* order. Instance-key-indexed receipts are therefore directly reusable
by whatever future work reads them, for exactly the scenario the ticket names.

A reopen where the recording set *did* move re-extracts and can reassign keys
differently — that is a harder, separate identity problem (matching a new instance to
an old receipt when neither the position nor the key can be trusted to mean the same
thing twice), and it is not solved by key-indexing alone. This design does not attempt
it: per §4, nothing consumes `receipts` yet, so no code depends on cross-re-extraction
key stability. The existing `existingRecords`/`instanceLinks` mechanism (surfacing the
vendor's own records for a human to re-link against) is the tool built for that harder
case, and it works independently of anything this design adds.

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

### 3.2 `ReviewOutcome` gains a required `instanceKeys` field

`ReviewOutcome`'s `accepted` and `edited` branches (`review.ts:328-354`) gain a new,
**required** (not optional, unlike `linkTargets`) field:

```
instanceKeys: Readonly<Record<string /* group path */, readonly string[]>>
```

Present for every group that has at least one surviving instance, absent (as `{}`,
never omitted — it is required) otherwise. `resolveReview` computes it from the same
`positions` map (`review.ts:707-736`) that already determines `fields[group]`'s array
order: `Array.from(indexMap.keys())` per group, in the exact iteration order
`buildInstancePositions` inserted them (first-mention order — the same order
`setAtPath` uses to build the array). Because both are derived from one shared map in
one function call, `instanceKeys[group].length` and `fields[group].length` are
structurally in lockstep for any outcome `resolveReview` produces — there is no code
path where one has an entry the other lacks.

**Required, not optional, is the point.** `linkTargets` is optional because a link
decision is a human choice that may not exist. Instance identity is not a choice — it
exists for every surviving instance — so leaving it optional would let a hand-built
outcome (bypassing `resolveReview` entirely, as every current
`instance-write-step.test.ts` fixture does via `Outbox.submitSessionReview`) omit real
keys and fall back to something synthetic. Making it required means `PersistedReviewOutcome`
(inferred directly from `reviewOutcomeSchema`, per `review.ts:1089-1090`'s own
convention) forces every caller — real or test — to supply real keys or fail to
compile and fail `reviewOutcomeSchema.parse` at `submitSessionReview` (`outbox.ts:730`).

**A schema-level parity check, for the callers the type system can't fully protect.**
A hand-built outcome can still supply the right *type* with the wrong *length* — a
2-element `fields.hvac` beside a 3-element `instanceKeys.hvac`, say. `reviewOutcomeSchema`'s
`accepted` and `edited` branches gain a `.refine()` checking, for every group key
present in `fields`, that `instanceKeys[group].length === fields[group].length` (when
`fields[group]` is an array). This runs at the same trust boundary `resolveReview`'s own
consistency checks already occupy — a real review can never fail it (see above), and a
malformed hand-built one is refused loudly at submit time instead of misbehaving
silently in the write step.

**Backward compatibility: a session schema migration backfills existing data.**
`reviewOutcome` is re-validated against `reviewOutcomeSchema` whenever a session
document is read back (`sessionDocumentSchema`'s `reviewOutcome: reviewOutcomeSchema.optional()`,
`session-schema.ts:172`), so making `instanceKeys` required would fail that parse for
every real, already-persisted session whose `reviewOutcome` predates this field. The
sessions v1→v2 migration (§3.4) backfills `instanceKeys` for any existing `reviewOutcome`
missing it, synthesizing sequential keys (`k1`, `k2`, …) matching each collection
group's array length. This is exactly correct, not merely a safe-enough guess: for any
session actually in flight (`writing` or `failed`) at migration time, the array order
already *is* first-mention order — nothing has re-reviewed or reordered it — so the
backfilled keys describe the same instances a freshly-computed `resolveReview` would
have assigned. A `done`/`dead` session's `reviewOutcome` also gets backfilled for
parse-safety, even though nothing reads its `instanceKeys` again unless it is amended
(and an amend re-reviews from `session.extracted`, producing a fresh `reviewOutcome`
that replaces the backfilled one entirely).

### 3.3 The write step reads real keys, not positions

`toInstanceWriteStep`'s per-instance loop (`instance-write-step.ts:104-113`) reads the
instance's real key off `session.reviewOutcome.instanceKeys[group][index]` — available
at exactly the same array position it already iterates by, since `fields[group]` and
`instanceKeys[group]` are aligned by construction (§3.2). `index` remains what
`deriveInstanceIdempotencyKey` derives from (its job is "stable across retries of this
exact queue item," not cross-review identity — position is the right input for that,
unchanged), while the *key* read alongside it is what receipts get stored under (§3.4).

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

Two changes land in one version bump, per the existing pattern
(`SESSION_MIGRATION_STRATEGIES`, `session-schema.ts:241-243`, and the v0→v1 precedent
that added `extractionUsage`):

- `receipts` is added as a new top-level optional session field. New documents simply
  start without it — no transformation needed for that half.
- Any existing `reviewOutcome` (`accepted`/`edited`, `status !== "discarded"`) missing
  `instanceKeys` gets it backfilled: for each group present in `reviewOutcome.fields`
  as an array, synthesize `["k1", "k2", …]` matching that array's length. Per §3.2,
  this is exactly correct for any session actually mid-cycle, and safe (never read
  again before being replaced) for a `done`/`dead` one.

The migration function is therefore **not** identity — it inspects and conditionally
rewrites `reviewOutcome`, mirroring how `OUTBOX_MIGRATION_STRATEGIES`' v5→v6 entry
(`database.ts:195-241`) is the fuller precedent for a migration that does real,
per-document work rather than only widening the schema.

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

- `review.test.ts`: `resolveReview` produces `instanceKeys` in lockstep with `fields`
  for a plain accept, for a partial rejection within one instance (that instance's key
  still appears), and for a fully-rejected instance (its key correctly does not
  appear, and the array is shorter by one). `reviewOutcomeSchema`'s new `.refine()`
  rejects a hand-built outcome whose `instanceKeys[group].length` disagrees with
  `fields[group].length`.
- `adapter.test.ts` / `write-step.test.ts` / `instance-write-step.test.ts`: update
  every stub adapter to return `{ uuid }`; update every hand-built `ReviewOutcome`/
  `Outbox.submitSessionReview` call to include real `instanceKeys` (mechanical: one
  `"k1".."kN"` entry per collection-group array's length, matching the fixture's own
  data). Assert `toInstanceWriteStep`'s resolved `SessionWriteResult.receipts` carries
  the correct `(group, key, uuid)` triples — including the reopen-and-remove-the-first-
  instance scenario already pinned at `instance-write-step.test.ts:436`, now asserting
  the surviving instance's receipt is keyed by *its own* key, not by whatever position
  it happens to occupy after the removal.
- `session-schema.test.ts`: pin the v2 schema; confirm a v1 document with no
  `reviewOutcome` migrates cleanly (identity for that half); confirm a v1 document
  with a `reviewOutcome` missing `instanceKeys` gets it backfilled correctly, matching
  each group's array length; confirm a v2 document (already carrying `receipts` and/or
  `instanceKeys`) round-trips unchanged.
