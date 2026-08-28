# Session-Scoped Review and Instance Modeling — Design

**Date:** 2026-08-28
**Author:** AZX
**Status:** Draft — for review, no implementation plan written yet
**Repos:** `azx/ribo` (Project A), `franklin/franklin-field-app` (Project B)
**Depends on:** ribo R1.6 (`8579e00`), extractor arbitration (`7fd7ba3`), on-device extraction (`0577609`)

---

## 1. What prompted this

The field app should adopt ribo's support for **multiple model instances** — a house with two HVAC
systems. That is ribo #31, "R1.6 instance modeling: a house can have two of things, end to end":
`hvac`, `attic`, `wall`, `window` and `dhw` become collections; `basedata` and `health` remain
singletons.

The app's vendored tarballs sit at `e6167be`. ribo's `origin/main` is three commits ahead:

| Commit    | What it brings                                                                      |
| --------- | ----------------------------------------------------------------------------------- |
| `0577609` | On-device extraction; `ExtractStep` returns `{ fields, engine? }`; outbox schema v4 |
| `7fd7ba3` | Extractor arbitration — `fallbackExtractor`, `raceExtractor`, arbiter contract      |
| `8579e00` | R1.6 instance modeling; outbox schema v5; `instanceLadder`; instance review         |

Vendoring packs a whole checkout (`scripts/refresh-ribo.mjs`), so a refresh brings all three. There
is no cherry-pick.

## 2. Why this is not a dependency bump

Three findings turned an upgrade into a design.

**There is no "refresh now, adopt later."** Once the adapter makes those five groups arrays, review
paths carry bracketed instance keys — `hvac[k1].hvacDuctLeakage`. `groupReviewFields`
(`src/screens/reviewModel.ts:110`) splits on the first dot and would render those as garbage
categories. Review work is forced by the refresh, not chosen alongside it.

**`useReview` cannot be adopted as it stands.** It reads `item.extracted` and `item.transcript` off
an `OutboxItem` (`use-review.ts:405-408`) and submits to one item. The field app has neither on any
item: the extraction is job-scoped in `app_job_extractions`, and the transcript is synthesised by
`jobTranscript(assessmentId, record.transcriptText)` — every recording's text joined in capture
order (`Review.tsx:433`). Its submit fans one resolved outcome across every recording on the job
(`Review.tsx:570`).

**That mismatch has a single cause.** `useReview` assumes _one item = one extraction = one review =
one submit_. ADR-0037 replaced it with _one job = one extraction = one review = N submits_. Every
awkwardness downstream — the fan-out, its partial-failure window, five stored copies of one
decision — is that assumption restated.

## 3. The root cause, and the entity that is missing

ribo is deliberately host-agnostic. `recording.ts:14`: _"`ribo-core` is host-agnostic: it has no idea
what a recording is about. A host does — a job, …"_. So the field app reinvented the grouping:

- `assessmentIdOf` digs `assessmentId` out of `recording.ctx`, typed `ctx?: unknown` — a foreign key
  smuggled through an opaque blob.
- `runJobExtraction.ts` is ~90 lines of entirely generic logic: join transcripts in capture order,
  cache by recording set, re-extract when the set changes.
- `app_job_extractions` is a store for a concept ribo does not have.
- `write-step.ts:44` already records the absence hurting: _"two recordings from two different
  assessments sit in the same outbox."_

**The missing entity is a set of recordings captured together.** That is a _capture_ concept, not a
domain one, so adding it does not cross the host-agnosticism line — `assessmentId`, `companyId` and
`apiBaseUrl` stay in `ctx` where they belong.

A `ReviewSubject` carrying `{ extracted, transcript, targets }` was considered and **rejected**: once
the parent owns those three things, `useReview(session, …)` already has everything the subject was
invented to carry. It was a workaround for the missing entity.

## 4. Decisions

| #   | Decision                                               | Reasoning                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Adopt instances end to end                             | Extract, review and edit two HVAC systems. Not a minimum-viable absorb.                                                                                                                                                                        |
| D2  | `instanceLadder`, arbiter accepts tier 3 at exhaustion | An auditor in a basement gets a record rather than nothing. Tier 3 cannot represent a second system, so review must surface `usage.strategy`.                                                                                                  |
| D3  | Identity / link-vs-create is **out of scope**          | Task 11 needs `GET /jobs/{jobId}/hvac`. The app has no vendor egress — review parks at `writing` and stops (`relay.ts` `write` is "f2-unreachable"). With no records to read, every instance resolves to create, which is already the default. |
| D4  | Migrate cached extractions; do not re-extract          | Wrap the five groups. Keeps the auditor's cached work and never strands an offline auditor.                                                                                                                                                    |
| D5  | All-null group migrates to **absent**, not `[]`        | R1.6 made absent / `[]` / populated distinct. `[]` asserts "the auditor established there are none", which old data cannot support. Absent means "touch nothing" and lands on the "none described — add one" affordance.                       |
| D6  | ribo gains a first-class parent over recordings        | See §3. Deletes the mismatch at its root instead of routing around it.                                                                                                                                                                         |
| D7  | The host opens a session explicitly                    | Matches what `jobs.ts` already does. The recording set is intentional rather than inferred, and merging after the fact would mean moving extraction and review state between parents.                                                          |
| D8  | On-device extractor package not adopted                | Ships as beta, leaves more than half of stated values null. Separate decision, separate evidence.                                                                                                                                              |

**D4 is contingent on D6.** The migration was designed as `app_job_extractions` v0 → v1. If ribo's
session owns extraction storage, that collection disappears and the same transform becomes a
one-time import into ribo's store. Same logic, different destination.

**D4 carries a cost, stated plainly.** Transcript 08 in ribo's R1.6 design is a real corpus case: one
old flat `hvac` slot holding the furnace's identity fields alongside the AC's duct fields. Wrapping
it yields `[{furnace identity + AC ducts}]` — one instance asserting something false about a real
appliance, which is the exact defect R1.6 exists to fix. Migration preserves it faithfully. Only
re-extraction separates them, and a migrated record never ran the ladder, so `usage.strategy` is
absent and nothing in review flags it as pre-instance.

## 5. Entity and naming

A **`Session`** owns N **`Recording`s**. Not "job": the host's assessment id, company id and API base
stay in `recording.ctx`, so ribo keeps knowing nothing about what a session is _about_.

The field app opens a session when the auditor activates a job. `jobs.ts` keeps the Snugg Pro
metadata as a thin app-side row pointing at a session id, rather than being the grouping mechanism
itself.

_Open:_ `Session` against `Capture` / `Walkthrough`. `Session` is used throughout below.

## 6. Two state machines

The current `OutboxItem` is two entities wearing one schema.

| Stays on the recording                                         | Moves to the session                |
| -------------------------------------------------------------- | ----------------------------------- |
| `recording`, `capture`, `preview`                              | `extracted`, `extractedBy`          |
| `transcript`                                                   | `reviewOutcome`                     |
| `attempts`, `nextAttemptAt`, `lastError` (transcription retry) | `writeResult`, `writtenInstances`   |
| `audioReady`, `audioBytes`                                     | `idempotencyKey` (the vendor write) |

**Recording:** `recording → queued → transcribing → transcribed`, plus `discarded` and `dead`.
**Session:** `open → extracting → awaiting-review → writing → done`.

A session leaves `open` on the host's say-so — the auditor decides they have finished walking the
house. Same explicit-lifecycle argument as D7.

Two things fall out that argue the split is real rather than tidier:

**`writtenInstances` is already in the wrong place.** Task 12 keys write progress by group and
instance position, but instances come from the set-wide extraction, not from any one recording. It
landed on the item because that was the only entity available.

**The review gate stops being a trick.** Today the gate is the _absence_ of `awaiting-review` from
`ACTIVE_OUTBOX_STATUSES` — a state machine held open by an omission, which `relay.ts` needs a
paragraph to explain. With a session, recordings drain to `transcribed` and stop; the session holds
review state. Nothing needs to be omitted from anything.

## 7. Extraction at session level

The relay's per-item `extract` step is **deleted**, not stubbed. `relay.ts:16` currently passes
through so items reach `awaiting-review` without a per-item model call; that workaround and its
explanatory paragraph both go.

Session extraction joins every `transcribed` recording's text in capture order, excluding
`discarded` — the app's current rule at `runJobExtraction.ts:57`, promoted. `discarded` is excluded
because the contractor threw that recording away and its words should not return through a later
extraction. It runs at review-open, keyed by recording set, re-running when the set changes. The
caching logic moves out of the app essentially unchanged.

`instanceLadder` is wired here:

| Tier | Strategy                                         | Isolation                                 |
| ---- | ------------------------------------------------ | ----------------------------------------- |
| 1    | House-wide inventory → scoped per-instance fills | Structural — one slot per call            |
| 2    | Per-group call, array per collection group       | Prose rules only                          |
| 3    | Per-group call, flat singleton per group         | None — cannot represent a second instance |

The arbiter accepts tier 3 at exhaustion (D2). Review must therefore surface `usage.strategy`, or a
tier-3 result silently cannot hold the second system this project exists for.

`EXTRACTION_MODEL` stays `gpt-4o` for now. The reasoning in `src/ribo/extractor.ts` was that Claude's
strict structured output rejects the full 51-field envelope schema and `singleShotExtractor` cannot
batch. Tiers 1 and 2 issue narrower per-group calls, so that constraint may no longer bind — but
ribo's measured corpus was scored against Claude and `gpt-4o`'s quality here is unmeasured either
way. Revisiting the model is a separate, evidence-led change.

## 8. Review and write

`useReview(session, …)` — no `ReviewSubject`. One `reviewOutcome` on the session, so "the most recent
outcome is the outcome" is a stored fact rather than a read-time sort over N copies.

Submit resolves once and flips the session's status. The N-item fan-out disappears, and with it the
partial-failure question: there is no loop in which the third of five writes can fail.

`writtenInstances` lives on the session, where instance positions mean something.

Instance review comes from ribo rather than being reimplemented app-side: `buildReviewRequest`
enumerates array instances and mints positional keys (`review.ts:439`, `k1`/`k2`/…); `resolveReview`
reassembles arrays and remaps keys to positions so removing an instance cannot reattach another
instance's decisions. `addInstance`, `removeInstance` and the re-keying come from `useReview`
(Task 15). Nothing about instance identity is stored, so no migration needs to mint keys.

## 9. Migrations

Two, and the existing data cooperates.

**Outbox.** Existing rows already carry `ctx.assessmentId`, so the migration synthesises one session
per distinct assessment and attaches its recordings, moving `extracted`, `reviewOutcome` and
`writeResult` up. A row with no assessment id gets a singleton session. This stacks on the v4 and v5
identity migrations arriving from ribo.

**Cached extractions.** Each `app_job_extractions` row imports into its session's extraction slot,
with the five collection groups wrapped:

```
for each of hvac, attic, wall, window, dhw:
  absent           -> leave absent
  already an array -> leave (idempotent)
  all leaves null  -> absent            (D5)
  otherwise        -> [obj]
```

`basedata` and `health` are untouched.

## 10. What ships in the field app

- Vendor refresh to ribo `origin/main` plus the session work; `ExtractStep`'s `{ fields, engine? }`
  return breaks `relay.ts:16`, which is being deleted anyway.
- `assessmentIdOf`'s `ctx`-digging replaced by a real session reference.
- `runJobExtraction.ts` and `app_job_extractions` retired into ribo.
- `reviewModel.ts` taught the bracketed path grammar — `parseFieldPath` instead of `indexOf(".")` in
  `groupReviewFields` and `fieldLabel`.
- `Review.tsx` split into orchestration, instance section and field card. It is 854 lines today and
  instance sections push it well past that; the split is part of this work, not a follow-up.
- Instance add/remove wired from `useReview`.
- `usage.strategy` surfaced in review (D2).

## 11. Out of scope

- **Instance identity / link-vs-create** (D3) — no vendor egress to read existing records from.
- **`@azx/ribo-extractor-ondevice`** (D8).
- **Changing the extraction model** — see §7.
- **Vendor write egress.** Review still parks at `writing`. This design does not make the write step
  reachable; it only puts `writtenInstances` somewhere correct for when it is.

## 12. Open questions

1. **A session whose every recording is discarded** — `done`, or reopenable? Nothing to extract and
   nothing to review, but "done" implies a review happened.
2. **Naming** — `Session` against `Capture` / `Walkthrough` (§5).
3. **Session close and late recordings.** If an auditor closes a session and then remembers the
   crawlspace, does a new recording reopen it or start a second session? The extraction cache keys on
   the recording set and already re-runs when the set changes, so reopening is cheap — but a reopened
   session that was already submitted needs its review state defined.

## 13. Sequencing

**Project A — ribo: the session entity.** Schema split, two state machines, session-level extraction
and review, `useReview` takes a session, outbox migration.

**Project B — field app: upgrade onto it.** §10.

Roughly half of B does not depend on A — the bracketed-path work in `reviewModel.ts`, the instance
sections in `Review.tsx`, and the ladder wiring are R1.6 concerns, not session concerns. They can run
alongside A rather than queue behind it.

Two implementation plans, one per repo.
