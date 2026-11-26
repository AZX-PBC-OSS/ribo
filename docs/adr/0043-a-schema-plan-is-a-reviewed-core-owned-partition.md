# 0043. A schema plan is a reviewed core-owned partition

Status: Accepted
Date: 2026-11-26

## Context

A runtime schema needs a way to divide extraction into semantic calls without asking a production
model to choose a strategy. ADR 0011 deferred a model-authored phase planner because the phase
vocabulary could not make such plans meaningful; spike 0003 then measured transcript-dependent
target selection and recommended against adopting it. Neither answers the narrower need here: a
complete, human-reviewed assignment of every schema leaf to a static extraction piece.

The nested projection and packing established for that artifact exposed a separate execution
constraint. `groupedExtractor` recombined pieces with shallow `mergeGroupPieces`, which is correct
for existing direct-leaf partitions but loses nested siblings. Making that helper generically
recursive would conflate ordinary objects with provenance envelopes and change legacy overlap
behavior. A second planned scheduler would instead duplicate retries, cancellation, events, usage,
normalization and the closing trust-boundary parse.

## Decision

**Core owns a reviewed static partition and its execution; production never interprets a plan.**
`plannedPerGroupPlan` compiles an already parsed `SchemaPlan` without calling chat, and
`plannedExtractor` executes that compilation through one ordinary `groupedExtractor`. The host
supplies the artifact, target, chat transport and model. Core imports neither the CLI nor Node APIs.

**Projection precedes packing.** Every semantic piece becomes a one-key target retaining its nested
objects, arrays, nullability, real leaf schemas and projected examples. Each projected piece then
uses the existing `perGroupPlan` and `splitExtractionSchema` union/byte packing. Its semantic name,
description and complete same-key `elsewhere` inventory survive every cap-created call. A projected
property that cannot fit is refused at construction with the existing field-and-cap diagnostic; the
remedy is a reviewed semantic split, not arithmetic embedded in a prompt.

**Citation ownership is direct-first and decided before packing.** For each singleton or collection
row, the earliest semantic piece holding a real leaf directly on that row owns its citation. Only a
row with no direct real leaves uses the fallback: the earliest piece holding a nested descendant
leaf owns the parent citation. Only the owning semantic piece's first packed call carries the row
citation in its schema and examples. Under leaf provenance, the piece assigned the real field owns
its whole envelope. A non-owner cannot replace an owner's citation, including an explicit null.

**Only planned extraction receives schema-aware merging.** `groupedExtractor` accepts a key-aware
same-key merger and defaults to the unchanged shallow `mergeGroupPieces`. The planned merger is
bound to the full enveloped schema: it recurses through ordinary objects and index-aligned arrays,
while envelopes, row citations, scalars and null remain atomic. Own-property presence, not
truthiness, decides ownership. Duplicate atomic values throw with their dotted/indexed path rather
than deep-merging or selecting a winner. Unequal arrays retain the longer input and partial
elements; the existing closing full-schema parse remains authoritative.

## Consequences

Existing grouped and per-group callers keep shallow later-piece-wins behavior, including wholesale
replacement of overlapping envelopes, with unchanged requests, events, retries and merges. Planned
execution gains nested recombination without a second engine. Deterministic tests cover projection,
packing, direct-first ownership, duplicate refusal, execution equivalence, cancellation and the
closing parse using stub chat only.

The September 20 evidence in ADR 0013 and ADR 0015 supports construction-time cap refusal and the
existing packing policy; it is not evidence for this partition's extraction accuracy. This change
includes no new real-model run and claims no accuracy improvement. A reviewed plan also carries a
maintenance cost: schema or semantic membership changes require review, and an unfittable projected
property requires another reviewed split rather than an automatic workaround.
