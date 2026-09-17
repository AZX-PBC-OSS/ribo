# Migrations Belong to the Document, Not to the Backend — Design

**Date:** 2026-09-17
**Author:** AZX
**Status:** Draft — revised twice after cross-family review, no implementation plan written yet
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
- versions pinned as literals in tests, so a bump is an edit someone has to make on purpose
- a zod ↔ `RxJsonSchema` field-set equality guard, so the two _descriptions_ of one document cannot
  drift apart
- a browser test that exercises a real v0 → v1 migration end to end
- **identity strategies declared rather than skipped**, because RxDB calls the migration plugin for
  every version above 0 and a bumped schema with no strategy makes the storage _fail to open_
  (`database.ts:229`). Missing work fails loudly, at open, on the first device to try
- an expand/contract split for the one migration that needed it, because RxDB strategies are
  per-document and cannot span collections (`database.ts:203`)
- every rung's reason recorded in a doc comment (`database.ts:144-232`), which is more archaeology
  than most repositories keep

None of that is being replaced, and the fifth bullet is a property the design below must be careful
not to lose.

## 3. The three gaps

**It is all inside one backend package.** The port says nothing about versions, and the conformance
kit — the executable form of the contract, published to third parties at `@azx/ribo-core/testing` —
has zero migration coverage. Everything above is a courtesy the first backend happened to extend.

**Nothing anywhere ties a shape change to a version bump.** This is worth stating precisely, because
the loose version of it flatters this proposal. `schema.test.ts` enforces two things: that zod and
`RxJsonSchema` describe the same field set, and that the version constant is the literal someone last
wrote. Neither relates the shape to the version. Change both descriptions together and leave the
version alone, and every test in the repository is green. That is exactly the hole #38 went through,
and what caught it was review, not a test.

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

**Where that boundary sits today, stated accurately.** An earlier draft claimed the boundary was
already crossed in both directions, with `backfillSessions` in core. That was wrong, and the
correction strengthens the case rather than weakening it. `migratedSessionId` (`database.ts:97`),
`backfillSessions` (`database.ts:429`) and `sessionDocumentFromMigratedGroup` (`database.ts:470`)
all live in the RxDB package; `openOutboxDatabase` calls the backfill at `database.ts:392`. Core's
`capture-schema.ts:192` mentions it only in a doc comment. So _all_ the domain knowledge sits in the
backend — which is the problem, in its pure form.

The one thing that does cross, and crosses the wrong way, is the `legacy` carrier: a migration-only
field declared in core's zod schema (`capture-schema.ts:200`) whose existence is dictated by one
backend's per-document constraint. Core already carries a field shaped by RxDB's limitations. That
qualifies the purity claim above — some of the rungs' purity was _bought_ by hiving the impure part
off into a second phase, which §6 has to account for rather than inherit silently.

## 5. The rung — the per-document half

A ladder is an ordered list. Rung `i` moves a stored document from shape version `i` to `i + 1`, so a
ladder of length N describes every shape from 0 to N. Core exports one ladder and one version per
collection, beside the zod schema each describes.

A rung is a two-branch union. Both branches carry a required `reason` — prose saying why the version
advanced. One branch carries an `upgrade` that transforms a document; the other carries
`rewrite: "none"`, the explicit statement that stored documents are already correct.

**The identity case must be written, not omitted.** An earlier draft made it the _absence_ of
`upgrade` and argued the absence was more expressive. That was wrong, and the argument against it is
the one §2's fifth bullet already makes. `{ reason }` with nothing else is precisely what a
half-finished rung looks like — what you commit meaning to fill the transform in later. Today,
forgetting a strategy makes RxDB refuse to open: loud, immediate, on the first device. Under an
absence-means-identity ladder the adapter would synthesise identity from the omission, and a
forgotten rewrite would **succeed silently**, surfacing much later as a parse failure on one
document, or not at all if the change involved optional fields. Trading a loud failure for a silent
one, in exactly the case where someone forgot to do the work, is the wrong trade. `rewrite: "none"`
costs one field per identity rung, is greppable, and cannot be reached by forgetting.

`upgrade` takes and returns a loose record rather than the current document type. This is a
correctness improvement, not a concession: today's identity strategies are typed
`(doc: CaptureDocument) => doc` (`database.ts:238`), which is a lie, because a v1 document is not a
v7 `CaptureDocument`. Only the v5 to v6 rung, the one someone actually thought about, correctly takes
a loose record. The ladder makes that uniform.

**A rung's expressiveness is bounded, and the bound is part of the contract:** a rung is a
per-document, synchronous, JSON-only rewrite. It cannot read another document, write another
collection, or touch attachment bytes. Everything outside that bound is §6 or §9.

**An `upgrade` must be pure and idempotent**, because a backend may resume a partially applied
migration from a checkpoint and run a rung twice. Core tests three things per ladder, all of which
are possible only because the rungs are data:

- apply each `upgrade` twice and assert the second application changes nothing
- a golden fixture per non-identity rung: a version-N document in, the expected version-N+1 document
  out. This is where the ctx-versus-recording bug class is actually caught, and nothing pins rung
  behaviour today
- apply the whole ladder to a version-0 fixture and assert the result parses under the current zod
  schema — the net for a rung marked `"none"` that should have rewritten something

## 6. The backfill — the cross-collection half

The ladder cannot be the whole story, and the v5 to v6 migration is the proof. Its expand half is a
pure per-document rung. Its **contract** half — `backfillSessions` — groups migrated recordings by
derived session id, builds one session from each _whole group_, derives session status from the group
rather than from any single row, and only then clears the carriers. A per-document fold structurally
cannot do that, which is why the split exists.

A backend author who read §5 alone and applied only rungs would migrate v5 rows into
`legacy`-carrying documents whose `sessionId`s point at sessions that are never created, with bags
that nothing clears. Silently. That is the same class of failure this document exists to prevent, so
the design has to answer where the second phase lives rather than leave it implied.

**It lives in core, written against the port.** `backfillSessions` uses exactly four operations —
find all captures, get one session by id, insert a session, modify a capture — and every one maps
onto `StorageBackend`'s `find`, `get`, `insert` and `modify`. Nothing in it needs RxDB;
`sessionDocumentFromMigratedGroup` is already pure and moves cleanly, and only the loop around it is
RxDB-typed. So core exports a named backfill per collection pair, typed against the port, and a
backend's migration sequence becomes: apply the rungs using whatever mechanism the engine provides,
then call the backfill. The backend still owns when; core owns what.

This is the payoff from having built the port at all — the cross-collection phase was the one piece
that looked irreducibly backend-shaped, and the port turns out to express it exactly.

The idempotency hinge at `database.ts:449` stays as written and becomes part of the contract: the
backfill checks whether the session already exists before inserting, so a crash between the insert
and the clear leaves the next open able to finish the job rather than collide on a primary key.

## 7. Enforcement: one mechanical guard and one stop sign

An earlier draft claimed a single invariant — ladder length equals version number — was "the entire
enforcement mechanism" and "the guard that would have caught the bug this repository shipped once
already". **That was false**, and both reviewers found it independently. It is worth recording why,
because the error is the seductive kind: it made the proposal sound like it closed the hole it was
describing.

Replay #38 under that invariant. `cec0c87` records what happened: #38 added the optional
`extractionUsage` field to the session document and left the schema at version 0. Under the proposed
design the sessions ladder is empty, the version is 0, `0 === 0` holds, and the zod schema quietly
gains a field. Every test is green and the bug ships identically. The invariant relates the ladder to
the version; the bug is between the _shape_ and the version, which nothing in the ladder ever looks
at. The same is true of a capture-side replay at version 7: edit `captureDocumentSchema` and
`captureRxSchema.properties` together, touch neither the version nor the ladder, and `7 === 7` still
holds.

So enforcement is two guards doing different jobs.

**Guard A, mechanical: the ladder has exactly as many rungs as the version number.** This catches a
version bumped without a rung — which RxDB already catches at open, but no other backend would — and
a rung added without a bump, which is a dead rung nothing catches today. It is real, and it is
bookkeeping. One trap to state explicitly for the implementer: the version constant must be
maintained independently and **not** derived as `ladder.length`, or the assertion becomes a tautology
and the test is vacuum.

**Guard B, a stop sign: a committed version-to-shape-signature table.** Each entry records the
document's field signature — a sorted `field:optionality` string, readable rather than a hash, so the
assertion diff names the field that changed — against the version it belongs to. A shape edit makes
the current signature disagree with the entry for the current version. The only routes back to green
are reverting, or bumping the version, adding a rung, and recording a new entry. Under Guard B, #38
fails the moment the field is added, and the failure message contains `extractionUsage`.

A table rather than a single pinned literal, because the history is the point: it is the only record
of what each version's shape actually was, and a future rung author reading it can see what they are
transforming from.

Guard B does not mechanically force a bump; it forces a deliberate edit at exactly the right moment,
next to a comment saying what changing it strands. That is weaker than mechanical enforcement, and it
is the same pattern `persisted-names.test.ts` already uses for the collection names — the strongest
precedent here for guarding a value that types cannot guard.

**Guard B's limit, stated rather than discovered later:** a field signature does not see changes
inside a field. Both the interesting cases in this repository are interior, and the repository has
treated them oppositely one version apart. `recording` gained a `kind` discriminator with **no bump**,
pinned by a test that says so (`schema.test.ts:157`) and made safe for old rows by a `z.preprocess`
stamp. `transcript` gained an optional `annotations` and **did** bump, to v7 — and `database.ts:189`
is admirably candid that the bump is not needed to read the field and buys a clean failure on
_downgrade_ instead, since `transcriptSchema` is a `strictObject` and old code would otherwise reject
a new document deep inside the application. Whether those two are reconcilable under one rule is
§13.2; until it is answered, the rung's required `reason` is where each interior change has to
justify itself.

Both guards live in core, so every backend inherits them. That is the actual improvement over
today — not that the hole closes, but that guarding it stops being a courtesy of whichever backend
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

A third party implements the other half: read the stored version, apply each rung that carries an
`upgrade` however their engine prefers, call the backfill, record the new version. They own
detection, batching, checkpointing and atomicity.

## 9. Attachments: a limit, stated

The ladder transforms documents. Captures also hold bytes: `AUDIO_ATTACHMENT_ID`
(`capture-schema.ts:18`) and the chunk names derived from `sourceId` (`chunk-names.ts:12`). A rung has
no vocabulary for either, and a backend author who reads core's ladders as the complete migration
story will miss them — a failure that presents as a migrated document whose audio is gone.

Three plausible members of the class: re-encryption at rest, re-encoding for codec or quota reasons,
and a change to the attachment naming scheme itself.

There is a real tension to name. §11's argument for refusing a port operation — migration happens
inside the backend's own construction — also **guarantees** that no rung can ever call
`putBlob`/`getBlob`/`removeBlob`. Yet RxDB's own strategies receive documents that _can_ reach their
attachments. So attachment migration is possible for the first backend and impossible in the shared
contract. That asymmetry is further evidence for §5's bound: the rung signature is RxDB's per-document
mechanism generalised, not a contract derived from first principles.

**This design does not address attachment migration, and does not regress anything** — no migration
in the repository's history has needed it. Inventing blob I/O for rungs leads directly to the port
widening §11 refuses. So it is recorded as a limit here and in the guide page, and one cheap guard is
added now, because it is the same failure the repository has already been bitten by once:
**`AUDIO_ATTACHMENT_ID` and `chunkPrefix`'s output format get pinned as literals in
`persisted-names.test.ts`.** That file pins the three collection names and calls them "what an
auditor's recordings are actually filed under"; `audio-${sourceId}-000000-00` is literally the key the
audio bytes live at, and it is not pinned. `capture-schema.ts:172` already says `sourceId` must never
change because it names attachments — and a pure document rung could violate that with no error at
all.

## 10. Every rung's reason, recovered

An earlier draft claimed capture rungs 0 to 3 pre-dated the repository's recorded history and were
unrecoverable. **That was wrong.** The reasons are all in the doc comment at `database.ts:144-232`,
in the very file this document cites elsewhere — the search went to changesets and git history and
missed the source. Only the originating _commits_ are lost to the initial-release squash; every
reason survives.

| Ladder         | Rung   | Reason                                                                                 |
| -------------- | ------ | -------------------------------------------------------------------------------------- |
| captures       | 0 to 1 | optional `reviewOutcome` — the review gate                                             |
| captures       | 1 to 2 | optional `capture`; revision 9 later removed `canonicalAttachmentId` and `step`        |
| captures       | 2 to 3 | optional `preview` — live transcription                                                |
| captures       | 3 to 4 | optional `extractedBy` — on-device extraction provenance                               |
| captures       | 4 to 5 | R1.6 instance modeling — a house can have two of things                                |
| captures       | 5 to 6 | the session entity splits out of the capture; expand half of expand/contract           |
| captures       | 6 to 7 | optional `transcript.annotations`; the bump buys a clean downgrade failure, not a read |
| sessions       | 0 to 1 | optional `extractionUsage` added at v0; this bump is the #38 fix                       |
| sessions       | 1 to 2 | review outcomes carry explicit per-instance keys                                       |
| plugin storage | 0 to 1 | the scope becomes a kind and an id; the owner stops being a plugin                     |

Rungs 0 to 5 of the capture ladder are all "an absent optional field needs no transformation" —
`rewrite: "none"` with a real reason, which is exactly the shape §5 argues for.

## 11. What this deliberately does not do

**No new port operation.** The first instinct was a seventh obligation and a `StorageBackend` method.
It is wrong, though not for the reason an earlier draft gave: the backend object does exist before
migration, since the host constructs it. Three better reasons. Migration happens _inside_ the
backend's own construction, before anything implementing the port is observable to a caller. RxDB
refuses to open on a version mismatch, so a core-side pass running after open is not merely
unobservable but infeasible — it would require declaring a version core does not believe. And most
simply: **the ladder is data, not behaviour.** Backends import it exactly as they already import the
zod schemas; nothing is asked of a backend at runtime that a value cannot carry, so no method is
needed.

**No conformance coverage.** Testing migration in the kit would mean extending `ConformanceSubject` —
today just `createBackend` plus documents — with an "open this name declaring version N" capability, a
significant widening of a contract published one PR ago, to test a property backends express in
completely different ways and that the ephemeral memory backend structurally cannot express at all.
The rung-level coverage that _is_ cheap needs none of that machinery, because the ladders are pure
data; it is in §5 and it lands in stage 1.

The consequence, stated plainly rather than hidden: **because the ladders are exported values rather
than port methods, nothing obliges a backend to read them at all.** A backend can ignore every word of
this and still pass the conformance kit. What changes is that the transformations are published,
versioned, shared, behaviour-tested and guarded in core instead of being one backend's private good
practice. Given that refusal, the guide page in §12 is the only thing a backend author will actually
meet, so it must carry §5's expressiveness bound, §6's backfill requirement and §9's attachment limit.

**Not consumer API migration.** Changesets already carry that, and this repository writes them well.

## 12. Sequencing

1. The rung union and the three ladders in core, with the reasons of §10, Guard A, Guard B, and the
   three per-rung test kinds of §5. Core exports gain `*_DOCUMENT_VERSION` and `*_DOCUMENT_UPGRADES`
   from the package root (§13.1).
2. `migratedSessionId`, `backfillSessions` and `sessionDocumentFromMigratedGroup` move to core,
   rewritten against `StorageBackend` per §6. The RxDB strategies become the adapter; each
   `RxJsonSchema` derives its `version`. The existing version-pin tests in the rxdb package stay —
   they now pin the adapter's output, which is a different and still useful property.
3. The attachment-name pins of §9.
4. Documentation: a contributor rule in AGENTS.md, and a guide page on the migration story for
   backend authors and hosts, carrying §5, §6 and §9.

Each stage ends green on `check.sh`, `docs:build`, `changeset status` and `pack-and-consume`.

## 13. Open questions

1. **Root or subpath export?** _Answered: root._ Backend authors already import the zod schemas and
   collection names from the root, and a second entry point carries per-subpath build, resolve and
   publish costs (AGENTS.md §5.1) for vocabulary with a readership of about three.
2. **Is there one rule covering interior changes, or two cases that genuinely differ?** `recording`
   gaining `kind` did not bump; `transcript` gaining `annotations` did. §7 records both and the
   candid reasoning behind the second. A rule that fits both is plausible — bump when old code would
   _reject_ a document new code writes, not when the engine merely cannot see the field — but it has
   not been checked against the `kind` case's `z.preprocess` handling, and asserting it without
   checking is how the last three errors in this document happened.
3. **Does a rung want a `since` marker naming the release that introduced it?** It would make §10
   durable rather than a one-time recovery, but it is a field that can go stale and nothing would
   check it.
4. **What happens when a host is on a newer core than the data allows?** Partly answered already:
   `database.ts:189` states the policy for one case — bump so a stale bundle fails at open rather
   than deep in a read. Whether that generalises to every rung, and what a non-RxDB backend owes here,
   is open.
