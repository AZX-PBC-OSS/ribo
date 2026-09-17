# Migrations Belong to the Document, Not to the Backend — Design

**Date:** 2026-09-17
**Author:** AZX
**Status:** Draft — revised after cross-family review, no implementation plan written yet
**Depends on:** the storage port (`bf640fb`, #67)

---

## 1. What prompted this

The storage port shipped and the observation that followed it was that we do not really talk about or
handle migrations. Both halves are true, and the port sharpened the problem rather than causing it:
core now owns the document shapes and `@azx/ribo-storage-rxdb` owns the migrations, and nothing
connects the two.

Before the split, RxDB lived in core and the whole story — shape, version, strategy — sat in one
package where a reader tripped over it. Now a second backend author reads `StorageBackend`, learns
fifteen operations and six obligations, and is told nothing about persisted data having versions at
all. They can satisfy every conformance case and destroy an auditor's recordings on their first
release.

## 2. What is already there, and is good

This is not a greenfield. The RxDB backend's migration discipline is careful and deliberate:

- strategies per collection — `CAPTURE_MIGRATION_STRATEGIES` (`database.ts:237`),
  `SESSION_MIGRATION_STRATEGIES` and `PLUGIN_STORAGE_MIGRATION_STRATEGIES` (`schemas.ts`)
- versions pinned as literals in tests, so a bump is an edit someone has to make on purpose —
  `schema.test.ts:154` asserts `captureRxSchema.version` is 7, and sessions and plugin storage do the
  same
- a zod ↔ `RxJsonSchema` field-set equality guard, so the two _descriptions_ of one document cannot
  drift apart
- a browser test that exercises a real v0 → v1 migration end to end
- identity strategies declared rather than skipped, because RxDB fails to _open_ — not to migrate —
  when a version above 0 has no strategy
- an expand/contract split for the one migration that needed it, because RxDB strategies are
  per-document and cannot span collections (`database.ts:203`)

None of that is being replaced. The question is only where it lives.

## 3. The three gaps

**It is all inside one backend package.** The port says nothing about versions, and the conformance
kit — the executable form of the contract, published to third parties at `@azx/ribo-core/testing` —
has zero migration coverage. Everything above is a courtesy the first backend happened to extend.

**Core owns the shape, and nothing anywhere ties a shape change to a version bump.** This is worth
stating precisely, because the loose version of it flatters this proposal. `schema.test.ts` enforces
two things: that zod and `RxJsonSchema` describe the same field set, and that the version constant is
the literal someone last wrote. Neither relates the shape to the version. Change both descriptions
together and leave the version alone, and every test in the repository is green. That is exactly the
hole #38 went through, and what caught it was review, not a test.

**It is written down nowhere anyone would look.** `grep -i migrat AGENTS.md` returns one line, a
clause about what the rxdb package owns. There is no guide page. The reasoning exists in the storage
port design's §6.3, but that is about one specific bump, filed under a design that is now merged
history. The most expensive fact in this repository — that a same-version shape change is a DB6 that
strands every recording on every existing device, which shipped once already — has no durable home.

## 4. The line: core owns the transformations, the backend owns the scheduling

The tempting minimal fix is for core to export the version number and leave everything else alone.
That is a trap, and reading the strategies shows why.

**Every migration transformation in this repository is already a pure function of domain data.** Not
one of them touches RxDB. Its involvement is entirely _when_ they run.

So exporting only the number would invite every backend to reimplement "v5 to v6 means lift six
fields into `legacy`, narrow the status machine, and derive `sessionId` from the recording's ctx."
That is domain knowledge. Duplicating it across backends is how you get the failure the v5 to v6
strategy already documents in its own comment: the recording was passed where its `ctx` was wanted,
the `"assessmentId" in ctx` test was therefore always false, every row on a device fell through to
the singleton, and one session swallowed every job the auditor had ever captured. Nothing threw. The
storage simply grouped wrongly, silently.

The split is therefore:

| Concern                                                        | Owner       |
| -------------------------------------------------------------- | ----------- |
| What the current shape version is                              | core        |
| What each version-to-version transformation does               | core        |
| What version the data on disk is at                            | the backend |
| When to run, per-document or in bulk, checkpointing, atomicity | the backend |
| The engine's own mechanism for expressing all of it            | the backend |

**Where that boundary actually sits today, stated accurately.** An earlier draft of this document
claimed the boundary was already crossed in both directions, with `backfillSessions` in core. That
was wrong, and the correction strengthens the case rather than weakening it. `migratedSessionId`
(`database.ts:97`), `backfillSessions` (`database.ts:429`) and `sessionDocumentFromMigratedGroup`
all live in the RxDB package. Core's `capture-schema.ts:192` mentions `backfillSessions` only in a
doc comment. So _all_ the domain knowledge sits in the backend — which is the problem, in its pure
form.

The one thing that does cross, and crosses the wrong way, is the `legacy` carrier: a migration-only
field declared in core's zod schema (`capture-schema.ts:200`) whose existence is dictated by one
backend's per-document constraint. Core already carries a field shaped by RxDB's limitations. That
is worth naming, because it qualifies the purity claim above — some of the purity of the rungs was
_bought_ by hiving the impure part off into a second phase, which §6 now has to account for.

## 5. The rung — the per-document half

A ladder is an ordered list. Rung `i` moves a stored document from shape version `i` to `i + 1`, so a
ladder of length N describes every shape from 0 to N. Core exports one ladder and one version per
collection, beside the zod schema each describes.

A rung carries a required `reason` and an optional `upgrade`.

`reason` is prose: why the version advanced. It is required even when nothing is rewritten, because
an identity rung asserts "stored documents are already correct", and that is a claim that deserves a
stated justification rather than an empty slot.

`upgrade` transforms one stored document, and is **omitted** when stored documents need no rewrite.
The absence is the statement. Version 6 to 7 is exactly this case: `recording` gained a nested
`kind`, no backend validates inside `recording`, nothing on disk changes, and the version moved
anyway so that the change was explicit rather than invisible. The argument for absence over
`doc => doc` is behavioural rather than aesthetic: `doc => doc` is what you type reflexively to
satisfy a compiler, whereas omitting `upgrade` forces the decision and the required `reason` forces
the justification into the artifact. Neither encoding catches a _wrong_ decision; absence makes the
wrong one slower to reach.

`upgrade` takes and returns a loose record rather than the current document type. This is a
correctness improvement, not a concession: today's identity strategies are typed
`(doc: CaptureDocument) => doc` (`database.ts:238`), which is a lie, because a v1 document is not a
v7 `CaptureDocument`. Only the v5 to v6 rung, the one someone actually thought about, correctly takes
a loose record. The ladder makes that uniform.

**An `upgrade` must be pure and idempotent**, because a backend may resume a partially applied
migration from a checkpoint and run a rung twice. That requirement needs a test rather than a
sentence, so core tests every rung: apply it twice and assert the second application changes nothing,
and apply the whole ladder to a version-0 fixture and assert the result parses under the current zod
schema. The second of those is also the best available net for a rung that should have rewritten
something and did not.

## 6. The backfill — the cross-collection half

The ladder cannot be the whole story, and the v5 to v6 migration is the proof. Its expand half is a
pure per-document rung. Its **contract** half — `backfillSessions` — groups migrated recordings by
derived session id, builds one session from each _whole group_, decides session status from the group
rather than from any single row, and only then clears the carriers. A per-document fold structurally
cannot do that, which is why the split exists.

A backend author who read §5 alone and applied only rungs would migrate v5 rows into
`legacy`-carrying documents whose `sessionId`s point at sessions that are never created. Silently.
That is the same class of failure this document exists to prevent, so the design has to answer where
the second phase lives rather than leave it implied.

**It lives in core, written against the port.** `backfillSessions` uses exactly four operations —
find all captures, get one session by id, insert a session, modify a capture — and every one maps
onto `StorageBackend`'s `find`, `get`, `insert` and `modify`. Nothing in it needs RxDB. So core
exports a named backfill per collection pair, typed against the port, and a backend's migration
sequence becomes: apply the rungs using whatever mechanism the engine provides, then call the
backfill. The backend still owns when; core owns what.

This is the payoff from having built the port at all — the cross-collection phase was the one piece
that looked irreducibly backend-shaped, and the port turns out to express it exactly.

The idempotency hinge at `database.ts:449` stays as written and becomes part of the contract: the
backfill checks whether the session already exists before inserting, so a crash between the insert
and the clear leaves the next open able to finish the job rather than collide on a primary key.

## 7. Enforcement: one mechanical guard and one stop sign

An earlier draft claimed a single invariant — ladder length equals version number — was "the entire
enforcement mechanism" and "the guard that would have caught the bug this repository shipped once
already". **That was false**, and it is worth recording why, because the error is the seductive kind:
it made the proposal sound like it closed the hole it was describing.

Replay #38 under that invariant. `cec0c87` records what happened: #38 added the optional
`extractionUsage` field to the session document and left the schema at version 0. Under the proposed
design the sessions ladder is empty, the version is 0, `0 === 0` holds, and the zod schema quietly
gains a field. Every test is green and the bug ships identically. The invariant relates the ladder to
the version; the bug is between the _shape_ and the version, which nothing in the ladder ever looks
at.

So enforcement is two guards doing different jobs.

**Guard A, mechanical: the ladder has exactly as many rungs as the version number.** This catches a
version bumped without a rung and a rung added without a bump. It is real but it is bookkeeping. One
trap to state explicitly for the implementer: the version constant must be maintained independently
and **not** derived as `ladder.length`, or the assertion becomes a tautology and the test is vacuum.

**Guard B, a stop sign: the document's shape signature, pinned as a literal.** A sorted
`field:optionality` string — readable, not a hash, so the assertion diff names the field that
changed. Under Guard B, #38 fails at the moment the field is added, and the failure message contains
`extractionUsage`.

Guard B does not mechanically force a bump; it forces a deliberate edit at exactly the right moment,
next to a comment saying what changing it strands. That is weaker than mechanical enforcement and it
is the same pattern `persisted-names.test.ts` already uses for the collection names, which is the
strongest precedent in this repository for guarding a value that cannot be guarded by types.

**Guard B's limit, stated rather than discovered later:** a top-level field signature does not see
nested changes. Version 6 to 7 was precisely that — `Transcript` gained an optional `annotations`
field nested inside `recording`, which RxDB stores as an opaque object. The signature would not have
moved, and the bump happened because a person decided it should. Whether the signature should be deep
is §13.2.

Both guards live in core, so every backend inherits them. That is the actual improvement over
today — not that the hole closes, but that the guarding stops being a courtesy of whichever backend
chose to write it.

## 8. What moves, and what the RxDB package becomes

The RxDB package keeps its schemas, its indexes, its attachment flags and its open-time behaviour. It
stops being the home of the transformations and becomes an adapter over core's ladders: a small
function converting a ladder into RxDB's `migrationStrategies` object, which is keyed by _target_
version and requires an entry for every version above 0. That requirement is satisfied in the
adapter, where it belongs — it is RxDB's rule, not a fact about captures. Each `RxJsonSchema`'s
`version` is derived from core's constant rather than written as a literal.

`migratedSessionId`, `backfillSessions` and `sessionDocumentFromMigratedGroup` move to core. That is
the point of the change, not a side effect of it.

A third party implements the other half: read the stored version, apply each rung that has an
`upgrade` however their engine prefers, call the backfill, record the new version. They own
detection, batching, checkpointing and atomicity. They never own what the transformation is.

## 9. Attachments: a limit, stated

The ladder transforms documents. Captures also hold bytes: `AUDIO_ATTACHMENT_ID`
(`capture-schema.ts:18`) and the chunk names derived from `sourceId` (`chunk-names.ts:12`). A rung has
no vocabulary for either, and a backend author who reads core's ladders as the complete migration
story will miss them — a failure that presents as a migrated document whose audio is gone.

Three plausible members of the class: re-encryption at rest, re-encoding for codec or quota reasons,
and a change to the attachment naming scheme itself.

**This design does not address them, and does not regress anything** — RxDB's `migrationStrategies`
are document-only today, so the limit is the one the repository already has, and no migration in its
history has needed attachment access. Inventing blob I/O for rungs would lead directly to the port
widening §11 refuses. So it is recorded as a limit here and in the guide page, and one cheap guard is
added now, because it is the same failure the repository has already been bitten by once:
**`AUDIO_ATTACHMENT_ID` and `chunkPrefix`'s output format get pinned as literals in
`persisted-names.test.ts`.** That file currently pins the three collection names and calls them "what
an auditor's recordings are actually filed under"; `audio-${sourceId}-000000-00` is literally the key
the audio bytes live at, and it is not pinned. `capture-schema.ts:172` already says `sourceId` must
never change because it names attachments — a pure document rung could violate that with no error at
all.

## 10. The reasons we can recover, and the three we cannot

The ladders must be populated with reasons, and this is archaeology, not authorship.

| Ladder         | Rung   | Reason                                                              | Source                                         |
| -------------- | ------ | ------------------------------------------------------------------- | ---------------------------------------------- |
| captures       | 3 to 4 | on-device extraction provenance — `extractedBy`; identity migration | `.changeset/ondevice-extraction-provenance.md` |
| captures       | 4 to 5 | R1.6 instance modeling — a house can have two of things             | `session-entity-design.md` commit table        |
| captures       | 5 to 6 | the session entity splits out of the capture                        | the existing strategy's own comment            |
| captures       | 6 to 7 | `Transcript` gains optional `annotations`, nested in `recording`    | `.changeset/transcript-annotations-v7.md`      |
| sessions       | 0 to 1 | optional `extractionUsage` added at v0; the bump is the #38 fix     | `cec0c87`                                      |
| sessions       | 1 to 2 | review outcomes carry explicit per-instance keys                    | `SESSION_MIGRATION_STRATEGIES[2]`              |
| plugin storage | 0 to 1 | the scope becomes a kind and an id; the owner stops being a plugin  | the existing strategy's own comment            |

Capture rungs 0 to 1, 1 to 2 and 2 to 3 **pre-date the repository's recorded history**.
`git log --all --diff-filter=A` on the schema files terminates at "Initial public release — Ribo",
which was a squash. Their reasons are not recoverable here.

Those three rungs should say so. "Unknown; predates the initial public release" is honest domain
information — it tells a future reader not to go looking, which is worth more than an invented
plausible reason and considerably more than a bare `doc => doc`.

## 11. What this deliberately does not do

**No new port operation.** The first instinct was a seventh obligation and a `StorageBackend` method.
It is wrong, though not for the reason an earlier draft gave: the backend object does exist before
migration, since the host constructs it. What is true is that migration happens _inside the backend's
own construction_, before anything implementing the port is observable to a caller — and that version
state is a construction concern the port is deliberately versionless about. A `migrate` method would
invite core to schedule what only the backend can schedule. Exporting the ladder as a value means the
adapter imports it directly and the port's surface is unchanged.

**No conformance coverage.** Testing migration in the kit would mean extending `ConformanceSubject`
with an "open this name declaring version N" capability — a significant widening of a contract
published one PR ago, to test a property that backends express in completely different ways and that
the ephemeral memory backend structurally cannot express at all.

The consequence, stated plainly rather than hidden: **because the ladders are exported values rather
than port methods, nothing obliges a backend to read them at all.** A backend can ignore every word
of this and still pass the conformance kit. What changes is that the transformations are published,
versioned, shared and guarded in core instead of being one backend's private good practice. Given
that refusal, the guide page in §12 is the only thing a backend author will actually meet, so it has
to carry the backfill requirement from §6 and the attachment limit from §9.

**Not consumer API migration.** Changesets already carry that, and this repository writes them well.

## 12. Sequencing

1. The rung type and the three ladders in core, with reasons recovered per §10, plus Guard A, Guard B
   and the per-rung idempotence tests of §5. Core exports gain `*_DOCUMENT_VERSION` and
   `*_DOCUMENT_UPGRADES`.
2. `migratedSessionId`, `backfillSessions` and `sessionDocumentFromMigratedGroup` move to core,
   rewritten against `StorageBackend` per §6. The RxDB strategies become the adapter; each
   `RxJsonSchema` derives its `version`. The existing version-pin tests in the rxdb package stay —
   they now pin the adapter's output, which is a different and still useful property.
3. The attachment-name pins of §9.
4. Documentation: a contributor rule in AGENTS.md, and a guide page on the migration story for
   backend authors and hosts, carrying §6 and §9.

Each stage ends green on `check.sh`, `docs:build`, `changeset status` and `pack-and-consume`.

## 13. Open questions

1. **Should the ladder be exported from the package root or a subpath?** Root is simpler and matches
   how the schemas are exported today. A subpath would keep migration vocabulary away from consumers
   who never implement a backend, at the cost of a second entry point to maintain.
2. **Should the shape signature of Guard B be deep rather than top-level?** Deep would have caught the
   v6 to v7 change; it also makes the pinned literal large and noisy, and every nested change in an
   opaque field becomes a forced edit whether or not it is stored. §7 records why the shallow version
   is not sufficient; this is the decision about whether that is acceptable.
3. **Does a rung want a `since` marker naming the release that introduced it?** It would make the
   archaeology of §10 durable rather than a one-time recovery, but it is a field that can go stale and
   nothing would check it.
4. **What happens when a host is on a newer core than the data allows?** Downgrade is undefined today
   in every backend. The ladder does not change that, and naming it here is not the same as solving
   it.
