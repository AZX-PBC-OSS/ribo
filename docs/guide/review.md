# Review

A model's draft is not the thing that gets written. A human looks at every field, reads the quote
that justifies it, and accepts, corrects, or drops each one — and that step has to survive a tab
closing, a reload, a shift ending mid-review. The contract is three things: what a reviewer is
shown, what they report back, and what the gate before a write enforces.

## A contract, not a UI

`buildReviewRequest` and `resolveReview` are the two functions this page is about, and neither one
renders anything. `buildReviewRequest` takes an adapter's values schema, an extraction, and the
transcript it came from, and produces a `ReviewRequest`: every leaf, presented flat, with its
provenance envelope and its own schema attached. `resolveReview` takes that request back together
with a `ReviewSubmission` — one `FieldDecision` per leaf, `"accepted"`, `"edited"`, or `"rejected"` —
and classifies what happened into a `ReviewOutcome`: `accepted`, `edited`, or `discarded`.

```ts
import { buildReviewRequest, resolveReview } from "@azx/ribo-core";

const request = buildReviewRequest(extracted, transcript, adapter.schema);

// however a UI collects `decisions` and `instanceLinks`...
const outcome = resolveReview(request, { status: "submitted", decisions, instanceLinks });
```

What the human reported (`ReviewSubmission`) is split from what it means (`ReviewOutcome`). A UI can
only be trusted to report what happened; deciding whether a draft was touched at all, and which
fields were touched, is classification logic that has to come out the same way no matter which UI
produced the submission — so it lives here, as a pure function, rather than in every review screen
that gets built against this contract.

## Flat dotted leaf paths, not top-level keys

A review request is shaped as one entry per leaf, not one per top-level field. The reason is
concrete: a real adapter's field set nests a group of several independently-true-or-false tests
under one key — a health and safety checklist is the case that
motivated this. Mapping review over the top-level key gives that whole group a single provenance
envelope and a single accept-or-reject verdict, so an auditor who wants to accept the ambient-CO
reading while correcting the gas-leak one cannot: the only options are approve the group wrongly, or
reject a test result that was actually right. A matrix of independent test results has to review as
one row per test, not one row per group.

So `buildReviewRequest` addresses **leaves**, by dotted path — `"health.healthGasLeak"`, not
`"health"` — walking the values schema's shape recursively and stopping at the first key that is
not itself a nested object. A collection group's instances get bracketed instance keys
(`"hvac[k1].hvacSystemEquipmentType"`), assigned in the order the extracted data emits them, because
the schema fixes every leaf within an instance but only the data can say how many instances exist.

## Each leaf carries its own schema

Every `ReviewField` in the resulting `ReviewFields` map holds, alongside the envelope and the
groundedness flags, the _declared_ schema for that leaf — `field.schema`, taken directly from the
adapter's values schema, wrappers and all. That is the one thing a generic review UI needs in order
to render an editor and validate an edit without importing anything tool-specific: ask the schema
what kind of value it wants, render the matching control, and call `field.schema.safeParse(edit)`
before accepting the edit at all.

`stripOptionalNullable`, exported from `@azx/ribo-core`, is the one primitive a UI needs on top of
that. A patch leaf is always wrapped in some combination of `.optional()` and `.nullable()`, and a UI
deciding _what kind of editor to render_ — a `ZodEnum` gets a select, a `ZodString` gets a text
field — has to see past those wrappers to the real type underneath, the same way `buildReviewRequest`
itself does when deciding whether a key is a leaf or a nested object to recurse into. It is exported
precisely so a UI does not have to reimplement that walk against zod's raw API and risk disagreeing
with the one `buildReviewRequest` already performs.

## The gate is decision completeness, not a groundedness check

`resolveReview` does **not** refuse a submission for containing an ungrounded field, and there is no
core-level rule that says an ungrounded leaf must be corrected before a submission is accepted. What
it refuses is a submission that is missing a decision for _any_ leaf of the request, grounded or
not: `completenessIssues` walks every path `buildReviewRequest` produced, checks that the
submission's `decisions` object has an explicit entry for it, and lists every path that doesn't —
throwing a `ReviewValidationError` naming every problem at once rather than one at a time. A field
the reviewer never looked at is indistinguishable from one they silently accepted, and the contract
refuses that ambiguity. Extra decisions the request never asked for are refused the same way, so a
UI and the schema it renders against cannot silently disagree about what the field set even is.

`ReviewField.isGrounded` and the finer three-tier `ReviewField.groundedness` (`"grounded"` |
`"near-miss"` | `"ungrounded"`, see [Provenance](/guide/provenance)) ride along on every field
precisely so a UI can _prioritize_ — put the suspicious fields first, flag them visually, make it
hard to miss one — but nothing in `resolveReview` inspects either flag. A UI is free to build a
stricter policy on top: the playground's own `ReviewPanel`, for instance, disables its submit button
while any untouched, ungrounded leaf remains. That is an application choosing to be more careful than
the contract requires, not a guarantee the contract itself makes. The contract's guarantee is wider:
every leaf gets an explicit human decision, not just the ones that look suspicious.

`resolveReview` validates one more thing per leaf: an accepted or edited value has to parse against
`field.schema`, the same schema the UI rendered the editor from. That is a second check on top of the
one `toWriteStep` runs at write time (see [Write-back](/guide/write-back)), and it exists so an
invalid value fails while the reviewer who typed it is still looking at the field, not as a dead
queue item discovered later.

## The gate is a session status, not a callback

Review does not block anything while it waits for a human. A session that finishes extraction lands
at `awaiting-review`. The relay does not treat it as active, so it drains past a parked session on
every run instead of retrying it. There is nothing to retry — a person has not looked yet, and the
relay processes a strictly ordered queue, so blocking on one parked session would stall every
recording behind it.

**`storage.sessions.submitReview` is the only way out.** It takes the `id` and a
`PersistedReviewOutcome` — the persisted mirror of what `resolveReview` returned — and only succeeds
from `awaiting-review`; a session anywhere else refuses with an error naming its actual status. An
`accepted` or `edited` outcome moves the session to `writing`, where the relay picks it up on its
next drain and hands `outcome.fields` to the write step (see [Write-back](/guide/write-back)). A
`discarded` outcome moves it straight to `done` — there is no audio to drop, unlike discarding a
recording, so the session is simply finished and `reviewOutcome` records why.

**`storage.sessions.reopenForReview` is the supported way back in**, from `done` or `dead`, and it is
explicitly not a raw `patchSession` call: it re-validates that the session still has an extraction
to show, clears the stale `reviewOutcome`, and resets the retry budget. It also handles a case a
plain re-park could not — a recording added or discarded after a session's last review — by comparing
the current eligible recording set against the one the stored extraction was computed from. If the
set has moved, the session lands at `extracting` instead, so the relay re-extracts before parking it
for review again; if it hasn't, it lands straight back at `awaiting-review` with the existing draft.

## Instance-identity review

Dictation can describe an instance of a collection group — a second HVAC system, say — that already
exists as a record in the host tool. Deciding whether that instance updates an existing record or
creates a new one is also a review-time human decision, and three types carry it:

- **`ExistingRecord`** — one record the host tool already has for a collection group: a `uuid` and
  the plain `fields` the host returned for it. These enter at the review boundary, in
  `ReviewRequest.existingRecords`, and never at extraction — a model is never handed them, so it
  cannot be steered by what already exists.
- **`RankedCandidate`** — an `ExistingRecord` with a `contradicts` flag, produced by a tool-specific
  ranking (an adapter's own contradiction check against a few identifying fields). Candidates that
  don't contradict the dictated instance sort first; the strongest one can be pre-highlighted, but it
  is never linked automatically.
- **`InstanceLinkDecision`** — the human's actual call: `{ kind: "create" }`, the default, or
  `{ kind: "link"; uuid }` naming the existing record to update instead. Submitted alongside the
  field decisions, keyed by instance path (`"hvac[k1]"`), in `ReviewSubmission.instanceLinks`.

`resolveReview` turns a submission's link decisions into `LinkTargets` on the outcome — one array per
collection group, aligned by position with the same group's resolved instances, `null` where the
default create applies and a `string` uuid where a human linked one. Absent a decision for an
instance, the answer is always create: the safe default never silently overwrites an existing record.

## Next

[Write-back](/guide/write-back) covers what happens to a `ReviewOutcome` once it reaches `writing` —
the trust boundary a reviewed patch is parsed through before anything reaches a host tool.

[React Hooks](/guide/react) covers `useReview`, the hook a React host consumes this contract
through — `ReviewRequest` in, `ReviewOutcome` out, with the same `resolveReview` rules underneath.
