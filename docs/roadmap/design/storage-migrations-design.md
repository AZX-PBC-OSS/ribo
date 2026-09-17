# Migrations Belong to the Document, Not to the Backend — Design

**Date:** 2026-09-17
**Author:** AZX
**Status:** Draft — approved in conversation, no implementation plan written yet
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

- strategies per collection — `CAPTURE_MIGRATION_STRATEGIES` (`database.ts`),
  `SESSION_MIGRATION_STRATEGIES` and `PLUGIN_STORAGE_MIGRATION_STRATEGIES` (`schemas.ts`)
- versions pinned as literals in tests, so a bump is an edit someone has to make on purpose —
  `schema.test.ts` asserts `captureRxSchema.version` is 7, and sessions and plugin storage do the same
- a zod ↔ `RxJsonSchema` field-set equality guard, so the two descriptions of one document cannot drift
- a browser test that exercises a real v0 → v1 migration end to end
- identity strategies declared rather than skipped, because RxDB fails to _open_ — not to migrate —
  when a version above 0 has no strategy

None of that is being replaced. The question is only where it lives.

## 3. The three gaps

**It is all inside one backend package.** The port says nothing about versions, and the conformance
kit — the executable form of the contract, published to third parties at `@azx/ribo-core/testing` —
has zero migration coverage. Everything above is a courtesy the first backend happened to extend.

**Core owns the shape; the backend owns the version.** `captureDocumentSchema` is core's.
`version: 7` is the RxDB package's. The invariant "shape change implies version bump" is enforced by
a test in the _downstream_ package. Core can neither enforce nor state it, and backend number two
inherits none of it.

**It is written down nowhere anyone would look.** `grep -i migrat AGENTS.md` returns one line, a
clause about what the rxdb package owns. There is no guide page. The reasoning exists in the storage
port design's §6.3, but that is about one specific bump, filed under a design that is now merged
history. The most expensive fact in this repository — that a same-version shape change is a DB6 that
strands every recording on every existing device, which shipped once already — has no durable home.

## 4. The line: core owns the ladder, the backend owns the application

The tempting minimal fix is for core to export the version number and leave everything else alone.
That is a trap, and reading the strategies shows why.

**Every migration strategy in this repository is already a pure function of the document.** Not one
of them touches RxDB. They are `(doc) => doc'`. RxDB's involvement is entirely _when_ they run.

So exporting only the number would invite every backend to reimplement "v5 to v6 means lift six
fields into `legacy`, narrow the status machine, and derive `sessionId` from the recording's ctx."
That is domain knowledge. Duplicating it across backends is how you get the failure the v5 to v6
strategy already documents in its own comment: passing the recording instead of its ctx made the
`"assessmentId" in ctx` test always false, every row on a device fell through to the singleton, and
one session swallowed every job the auditor had ever captured. Nothing threw. The storage simply
grouped wrongly, silently.

The split is therefore:

| Concern                                                     | Owner       |
| ----------------------------------------------------------- | ----------- |
| What the current shape version is                           | core        |
| What each version-to-version transformation does            | core        |
| What version the data on disk is at                         | the backend |
| When to run, per-document or bulk, checkpointing, atomicity | the backend |
| The engine's own mechanism for expressing all of it         | the backend |

The evidence that this is the right seam is that the boundary is already crossed in both directions.
`migratedSessionId` — pure domain logic about deriving a session id from a v5 recording's ctx — lives
in `packages/ribo-storage-rxdb/src/database.ts`. Its other half, `backfillSessions`, lives in core's
`capture-schema.ts` and is called back across the boundary from the rxdb package's `open.ts`. One
migration, expand phase in the storage package, contract phase in core. Moving the ladder into core
reunites them.

## 5. The rung

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
anyway so that the change was explicit rather than invisible. Representing that as an absent
`upgrade` beside a `reason` says more than `doc => doc` does, and it cannot be written by accident.

`upgrade` takes and returns a loose record rather than the current document type. This is a
correctness improvement, not a concession: today's identity strategies are typed
`(doc: CaptureDocument) => doc`, which is a lie, because a v1 document is not a v7 `CaptureDocument`.
Only the v5 to v6 rung, the one someone actually thought about, correctly takes a loose record. The
ladder makes that uniform. An `upgrade` must also be pure and idempotent — a backend may resume a
partially applied migration from a checkpoint and run a rung twice.

## 6. The invariant that makes a half-done bump impossible

Core asserts that each ladder has exactly as many rungs as its version number. Bump the number and
the test fails until a rung is added; add a rung and it fails until the number moves.

This is four lines, it is the entire enforcement mechanism, and — unlike every guard described in §2
— it lives in core, so every backend inherits it for free. It is also the guard that would have
caught the bug this repository shipped once already.

## 7. What moves, and what the RxDB package becomes

The RxDB package keeps its schemas, its indexes, its attachment flags and its open-time behaviour. It
stops being the home of the transformations and becomes an adapter over core's ladders: a small
function converting a ladder into RxDB's `migrationStrategies` object, which is keyed by _target_
version and requires an entry for every version above 0. That requirement is satisfied in the
adapter, where it belongs — it is RxDB's rule, not a fact about captures. Each `RxJsonSchema`'s
`version` is derived from core's constant rather than written as a literal.

`migratedSessionId` moves to core. That is the point of the change, not a side effect of it.

A third party implements the other half: read the stored version, take the ladder from the version
they are at, apply each rung that has an `upgrade` however their engine prefers, record the new
version. They own detection, batching, checkpointing and atomicity. They never own what the
transformation is.

## 8. The reasons we can recover, and the three we cannot

The ladders must be populated with reasons, and this is archaeology, not authorship. What the
changesets and design documents yield:

| Rung   | Reason                                                               | Source                                         |
| ------ | -------------------------------------------------------------------- | ---------------------------------------------- |
| 3 to 4 | on-device extraction provenance — `extractedBy`; identity migration  | `.changeset/ondevice-extraction-provenance.md` |
| 4 to 5 | R1.6 instance modeling — a house can have two of things              | `session-entity-design.md` commit table        |
| 5 to 6 | the session entity splits out of the capture                         | the existing strategy's own comment            |
| 6 to 7 | `Transcript` gains optional `annotations`, nested inside `recording` | `.changeset/transcript-annotations-v7.md`      |

Rungs 0 to 1, 1 to 2 and 2 to 3 **pre-date the repository's recorded history**.
`git log --all --diff-filter=A` on the schema files terminates at "Initial public release — Ribo",
which was a squash. Their reasons are not recoverable here.

Those three rungs should say so. "Unknown; predates the initial public release" is honest domain
information — it tells a future reader not to go looking, which is worth more than an invented
plausible reason and considerably more than a bare `doc => doc`.

## 9. What this deliberately does not do

**No new port operation.** The first instinct was a seventh obligation and a `StorageBackend` method.
It is wrong: migration happens at database-open time, before a `StorageBackend` exists, so a port
operation cannot observe it. The ladder is exported from core's storage module and the port's surface
is unchanged.

**No conformance coverage.** Testing migration in the kit would mean extending `ConformanceSubject`
with an "open this name declaring version N" capability — a significant widening of a contract
published one PR ago, to test a property that backends express in completely different ways. The
memory backend is ephemeral and has no stored version to disagree with.

The consequence, stated plainly rather than hidden: **a backend still has no enforceable obligation
to migrate, and the kit cannot prove that one does.** What changes is that the transformations are
published, versioned and shared, and that core can no longer let a shape change through without a
version to go with it. That is most of the safety for a fraction of the surface, and if it proves
insufficient the port change remains available.

**Not consumer API migration.** Changesets already carry that, and this repository writes them well.

## 10. Sequencing

1. The rung type and the three ladders in core, with reasons recovered per §8, plus the
   length-equals-version invariant. Core exports gain `*_DOCUMENT_VERSION` and `*_DOCUMENT_UPGRADES`.
2. `migratedSessionId` moves to core. The RxDB strategies become the adapter; each `RxJsonSchema`
   derives its `version`. The existing version-pin tests in the rxdb package stay — they now pin the
   adapter's output, which is a different and still useful property.
3. Documentation: a contributor rule in AGENTS.md, and a guide page on the migration story for
   backend authors and hosts.

Each stage ends green on `check.sh`, `docs:build`, `changeset status` and `pack-and-consume`.

## 11. Open questions

1. **Should the ladder be exported from the package root or a subpath?** Root is simpler and matches
   how the schemas are exported today. A subpath would keep migration vocabulary out of the way of
   consumers who never implement a backend, at the cost of a second entry point to maintain.
2. **Does a rung want a `since` marker naming the release that introduced it?** It would make the
   archaeology of §8 durable rather than a one-time recovery, but it is a field that can go stale and
   nothing would check it.
3. **What happens when a host is on a newer core than the data allows?** Downgrade is undefined today
   in every backend. The ladder does not change that, and naming it here is not the same as solving
   it.
