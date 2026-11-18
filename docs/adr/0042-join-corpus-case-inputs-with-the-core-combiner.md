# Join corpus case inputs with the core combiner

## Status

Accepted

## Date

2026-02-15

## Context

A corpus case in `ribo eval` could declare exactly one input: a case-level `kind` (`transcript`,
`text` or `document`) named one implied file (`input.txt` or `input.pdf`). A real job is several
documents read together — an HVAC quote, a floorplan and a Manual J for one house — with one
schema extracted from all of them. `@azx/ribo-core` already exports
`createDefaultTranscriptCombiner({ markCaptures })`, the joining policy the storage relay uses to
join annotated capture parts into one transcript; the eval CLI had no reason to grow a second one.

## Decision

- **One schema and one extraction per case.** A case's inputs are joined into one text and
  extracted once against the corpus's schema. No per-document-type schemas, no per-input answers,
  no per-input results.
- **The joining options live in the manifest, never on the CLI.** `manifest.json` accepts an
  optional strict `combine` block whose only member is the optional boolean `markCaptures`. The
  options change what the model reads, so they are part of the corpus's identity; a
  `--mark-captures`-style flag would let two invocations over the same corpus read different
  texts while claiming the same record identity.
- **`markCaptures` defaults to `true`** — an absent block, an absent member and an explicit `true`
  are the same effective policy, for one input and for many.
- **The join order is the case's `inputs` list order.** Part sequence numbers, prompt text and
  fingerprint contribution all follow the declared order; reordering is semantic.
- **The corpus fingerprint covers ordered input bytes plus effective options.** Every declared
  entry contributes its `file`, `kind` and the SHA-256 digest of its exact bytes, in list order;
  the corpus-wide effective `markCaptures` joins the hash once. Capture metadata stays excluded.
- **The one-input format is retired, not kept alongside.** Every case uses `inputs`; a case still
  in the old shape (a case-level `kind` with an implied single input file) is refused with a
  one-line message naming `inputs`. All in-repo corpora are migrated in the same change, with
  expected values and input bytes unchanged.

## Consequences

- Default-on markers change every migrated corpus's model-facing text — including a one-input
  case, which now carries one marker — and therefore every migrated corpus's fingerprint. Any
  committed eval run record over a migrated corpus becomes stale under ADR 0041's freshness rule;
  it renders with the stale notice and is rebaselined only by a separately requested real
  evaluation, never by editing its numbers.
- The join is core's combiner, unmodified: the marker format, the unmarked single-space join and
  the empty output annotation bag are the session relay's own behavior, so a corpus case and a
  multi-capture session read the same way downstream.
- `ribo corpus text --json` moves to contract version 2 with `{ caseId, text }` entries: a case
  whose inputs mix kinds has no truthful singular `kind` to report.
- Adopting the format is a one-time authoring migration; the loader offers no conversion and no
  dual-format reading, so a corpus is always in exactly one shape.
