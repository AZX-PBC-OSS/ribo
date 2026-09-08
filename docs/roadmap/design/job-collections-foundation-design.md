# Job collections foundation: five decisions before any tranche gets built

**Date:** 2026-09-08
**Status:** Approved for planning.

## 1. Context and scope

[Doc 20](../../implementation/20-job-collections-field-reconciliation.md) curated the field
surface beyond `basedata`: 837 writable wire fields exist across the whole Snugg Pro API, 293 of
them `basedata`'s, 544 not. Under a broad dictation-plausible stance, 378 of those 544 are
candidates, organized into 18 proposed build tranches. That curation is a field inventory, not a
design — it surfaced five open questions that building against it would hit immediately, not
details to improvise while coding. This doc decides those five, so tranche building has a
foundation rather than a series of one-off judgment calls made under deadline.

This doc does not build anything. No tranche's fields land here. It settles the shape decisions
that every tranche will otherwise re-litigate.

## 2. Decision 1 — target model: extend `V`, not a new abstraction

**Decision:** job-collection resources become additional top-level keys in the adapter's `V`
type, following the exact pattern `hvac`/`attic`/`wall`/`window`/`dhw`/`health` already use for
basedata's own sub-resources. No new "multi-target adapter" concept is introduced.

**Why this is small, not architectural.** `ToolAdapter<V, C>`
(`packages/ribo-core/src/adapter.ts:173-243`) already carries one `schema`/`extractionSchema`/
`write` for a `V` that is a union spanning 7 real endpoints, not one. `ExtractionTarget<V>`
(`packages/ribo-core/src/extractor.ts:120-123`) is literally
`Pick<ToolAdapter<V, unknown>, "name" | "extractionSchema" | "instructions" | "examples">` —
"target" is not a concept distinct from "adapter," it is the same object narrowed. Write-back
already calls `adapter.write()` once per group with only that group's keys present
(`packages/ribo-core/src/instance-write-step.ts:105-153`, splitting `fields.data` into a
`singletonPatch` for basedata/health and per-instance patches for the array-shaped groups).
Adding job-collection resources is adding more branches to a shape that already exists, not
inventing one.

**What is genuinely still open, and predates this work.** `write()` itself is scaffolded, not
implemented: `packages/ribo-adapter-snuggpro/src/adapter.ts:76-81` throws, with real egress
gated on separate HMAC-SHA256 signing work (Phase 4 Task 6). Nothing routes today's 7 groups'
write calls to distinct HTTP endpoints, because nothing performs a real write call at all. Job
collections do not add a new problem here — they add more cases to a problem that already exists
for basedata's own groups and is separately tracked. Whoever implements real egress will need a
branch per top-level key/endpoint; this doc does not attempt that, and no tranche-building work
should block on it.

**Review UI impact:** `review.ts` builds its tree by walking the schema's top-level groups
(not independently re-verified line-by-line here, but consistent with the group-keyed pattern
`instance-write-step.ts` confirms) — more groups is additive to that walk.

## 3. Decision 2 — instance identity: extend the roster mechanism, don't replace it

**Decision:** every job-collection resource that repeats per job and has no natural name field
(9 of the 12 curation flagged) gets identity the same way the roster already grounds
existence/separation/exclusion/absence claims — a discriminating description tied to a verbatim
quote — rather than inventing a second identity mechanism.

**Why this fits without changing the mechanism.** `RosterCandidate`
(`packages/ribo-extractor-openai/src/instance-fill.ts:46-52`) already carries `mentionSpan`,
`discriminator`, and `distinguishedBy` (plus `eligibility`/`eligibilitySpan` from the
roster-absence work), and `Roster` is keyed by `groupKey: string` generically — it assumes
nothing about what a group *is*. Extending this to, say, estimates or contacts means: the
adapter gains an `inventory` function and a `buildFillInstructions` entry for that group. That is
adapter-side content work in `ribo-adapter-snuggpro`, not a change to the roster's shape or to
`instance-fill.ts`'s mechanism.

**What tranche building still has to do, per resource:** write the natural-language
`buildFillInstructions` text that tells the model what distinguishes one instance of *this*
resource from another (an estimate by its total and scope; a contact by name and role) — this is
real per-resource content, not mechanical, and is scoped into each tranche's own build task
rather than solved once here.

## 4. Decision 3 — BASE/IMPROVED: per-resource judgment, no blanket rule

**Decision:** basedata's rule — exclude every `*Improved` field wholesale — does not become a
rule for job collections. Each BASE/IMPROVED pair is judged individually when its tranche is
built: is the "Improved" side a retrofit echo of the base value (drop, matching basedata's
precedent), or does it carry information with no equivalent on the base side (keep)?

**Why no blanket rule works here.** Doc 20 §1 gives concrete counterexamples basedata never had:
`hvacUpgradeAction: "Install a new non-existing system"` puts an entirely new system's
description on the Improved side with nothing on the base side to echo, and
`windowAreaNorthImproved` is how the vendor encodes *which* windows are being replaced — not a
retrofit twin of `windowAreaNorth`, a distinct fact. A blanket exclusion would silently drop both.
Doc 20's per-resource notes are the starting list of pairs already known to need this judgment;
tranche building should check every pair against that list, not assume silence means "safe to
drop."

## 5. Decision 4 — recommendations: dropped, not built

**Decision:** the recommendations tranche is not built. `recDefinitionId` is required to create a
recommendation, and no listing endpoint for it exists anywhere in the live spec (doc 20 §3) — the
API does not support creating a recommendation from an empty state, independent of extraction
quality. Extracting recommendation mentions from a transcript would produce data the app can
never write.

**Revisit condition:** if Snugg Pro adds the missing endpoint, this tranche re-enters scope with
no change to anything decided elsewhere in this doc.

## 6. Decision 5 — proposal nesting: a generic extension, not a proposal-specific one

**Decision:** proposal-side two-level nesting (an estimate's line items, per doc 20 §"two-level
nesting on the proposal side, with sequenced writes") is handled by extending
`instance-write-step.ts`'s per-instance write-sequencing to support one additional nesting level
generically, reusable by any future resource with the same shape — not a special case hard-coded
to proposals.

**Why generic, not special-cased:** the same shape (a collection whose elements are themselves
collections) is a plausible fit for other job-collection resources doc 20 didn't fully explore
(e.g., anything with sequenced line-item-style children). Building the extension once, against
proposals as the first real consumer, costs little more than a special case and avoids a second
rewrite the next time the shape recurs.

**Scope note:** this is real design/implementation work on `instance-write-step.ts`, not a
one-line change — it is scoped as its own task when the proposals tranche is built, not solved
speculatively here.

## 7. What this does not do

- No tranche's fields are added by this doc. Doc 20 remains the field inventory; this doc removes
  the blockers to building against it.
- No change to `write()`'s scaffolded state — real egress is out of scope here as it was before.
- No change to the roster/`instance-fill.ts` mechanism itself — only its per-resource content
  (inventory functions, fill instructions) is new work, scoped per tranche.
- No commitment to build order among the remaining 17 tranches (18 minus recommendations) — that
  is a planning decision for whenever tranche building is scheduled, not answered here.

## Sources

- [Doc 20 — job collections field reconciliation](../../implementation/20-job-collections-field-reconciliation.md)
- [Doc 17 — Snugg Pro field reconciliation](../../implementation/17-snuggpro-field-reconciliation.md) (basedata precedent for BASE/IMPROVED and instance identity)
- `packages/ribo-core/src/adapter.ts`, `extractor.ts`, `instance-write-step.ts`
- `packages/ribo-adapter-snuggpro/src/adapter.ts`
- `packages/ribo-extractor-openai/src/instance-fill.ts`
- [`roster-absence-design.md`](./roster-absence-design.md) (the discriminator/quote-grounding precedent this doc extends)
