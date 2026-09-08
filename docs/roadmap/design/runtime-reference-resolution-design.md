# Runtime reference resolution: capture the words, resolve at write time

**Date:** 2026-09-08
**Status:** Approved for planning. Extends
[job-collections-foundation-design.md](./job-collections-foundation-design.md).

## 1. The problem, and why it is one problem, not two

Doc 20 flags two fields that cannot be extracted as ordinary enum or free-text values because
their valid values are not known until runtime: `POST /jobs/{jobId}/incentives`'
`fromTemplateUuid` (§4.3 — resolves against a **program**-scoped template list,
`GET /programs/{programId}/incentive-templates`, needing a job→program hop first) and
`PUT /jobs/{jobId}/tickets/{ticketId}` (§5.1 — has **no create endpoint anywhere in the spec**, so
addressing a ticket means selecting one already returned by `GET /jobs/{jobId}/tickets`, not
minting a new instance the way every other repeating group does).

These read as different problems — a foreign-key lookup versus an instance-selection problem —
but they are the same shape: **a spoken reference that only resolves against a list fetched at
call time, which extraction cannot see and must not guess.** Doc 20 §4.3 states the constraint
directly: "resolution must be able to **fail visibly** — a spoken measure matching nothing in the
program's catalog has to surface to the auditor for disambiguation rather than be guessed." The
same is true of a ticket reference matching no open ticket, and will be true again for the
custom-fields overlay `docs/implementation/17-snuggpro-field-reconciliation.md` §4 already flagged
as future work ("a generated static base schema plus a runtime-discovered overlay").

## 2. Decision: capture verbatim now, resolve at review/write time

**Extraction captures what was said as plain text.** `fromTemplateUuid` and a ticket reference are
NOT modeled as lookup/FK-typed leaves — they are ordinary string captures, the same kind of leaf
`concern`'s free-text fields already are. No network call happens during extraction, and nothing
about the recording/extraction path changes for these fields versus any other free-text field.

**Resolution happens later, at review or write time** — whichever point in the existing pipeline
is already online and about to call the real Snugg Pro API. At that point, fetch the real
candidate list (the job's program's incentive templates; the job's open tickets) and match the
captured text against it. A confident match resolves automatically; anything else — no match,
multiple plausible matches — surfaces to the human reviewer rather than being guessed. This is not
new complexity added to the write path: `write()` is already a scaffolded stub gated on the
Helix HMAC ask (A1, per the foundation design doc §2), so resolution logic slots into work that
was already deferred, not into new deferred work.

**Why not resolve at extraction time instead.** Fetching a program's template list or a job's
open tickets during extraction would couple the extraction step to live network/account access.
Recording capture in this app is offline-first — nothing else in the extraction path requires a
network call — and introducing one here for two fields would be a real behavioral change, not a
schema change. It would also let the model guess a match with more apparent confidence than the
data supports, which is the opposite of what doc 20 §4.3 asks for.

## 3. What this means for the two tranches it unblocks

**Incentives** (doc 20 tranche 3): of its 3 fields, `recommendations` is already excluded from
extraction entirely (doc 20 §5.7 — it references same-session UUIDs from a tranche we dropped).
`amount` is an ordinary number capture. `fromTemplateUuid` becomes a plain string capture under
this decision — "the spoken rebate name is... the only thing an extractor can contribute besides
the amount" (doc 20 §5.7), captured as free text rather than blocked on a lookup. The tranche is
now 2 capturable fields, no different in kind from `concern`.

**Tickets** (part of doc 20 tranche 4, "workflow verbs"): `message` (free text) and `status`
(4 verbatim values, extracted from the live spec's prose — see the sibling `stage` mini-tranche)
become ordinary captures. Instance identity is the harder part doc 20 §5.1 already names: a
ticket's only distinguishing content is its `message` text, with no natural key the way "the attic
over the garage" anchors an hvac instance. This still needs the roster's discriminator mechanism
(foundation design §3) for grounding which spoken passage belongs to which ticket-shaped mention —
but the actual binding to a real, pre-existing `ticketId` is deferred to the same review/write-time
resolution step as `fromTemplateUuid`, not solved by the discriminator.

`stageId` (the job's single current workflow stage — a singleton, not a repeating resource) is
unaffected by any of this: it is a real, closed 10-value set, just documented in prose instead of
a spec `enum` key. It was never blocked on this decision and is its own small, ordinary mini-tranche.

## 4. What this does not do

- Does not implement the resolution matching logic itself (exact match, fuzzy match, or otherwise)
  — that is real design/implementation work for whoever unblocks `write()`, scoped to when A1
  lands, not decided here.
- Does not design the review UI's presentation of an unresolved/ambiguous reference — a future
  task, likely alongside whatever review-UI work accompanies real write-back.
- Does not change how any other tranche's fields are captured — this decision is scoped to fields
  that are provably lookup/selection-shaped (found so far: `fromTemplateUuid`, ticket references;
  expected to recur for custom fields).

## Sources

- [Doc 20 §4.3 — template references](../../implementation/20-job-collections-field-reconciliation.md)
- [Doc 20 §5.1 — job, stage and tickets](../../implementation/20-job-collections-field-reconciliation.md)
- [Doc 20 §5.7 — incentives](../../implementation/20-job-collections-field-reconciliation.md)
- [job-collections-foundation-design.md](./job-collections-foundation-design.md)
