# 0041. The eval run record keys freshness on backend, model, settings, fingerprint

Status: Accepted
Date: 2026-11-13

## Context

Extraction quality has so far been measured by one tool-hardwired gate
(`packages/ribo-adapter-snuggpro/acceptance/gate.manual.ts`) and one persisted run record
(`packages/ribo-adapter-snuggpro/acceptance/run-record.ts`). That record is a good artefact for
what it measures, and two of its fields are load-bearing in a way a general record must also be.

First, its freshness key. The gate decides whether a stored baseline is still comparable with
today's code by comparing two things: the schema fingerprint (`currentSchemaFingerprint` in
`gate.manual.ts`, a `sha256:`-prefixed hash of the frozen fixture schema file plus the
instructions file plus the examples file) and the backend identity. That key is enough for a gate
that measures exactly one schema, exactly one prompt and a small set of backends. It is not enough
for a harness that runs arbitrary schemas, arbitrary prompts and arbitrary settings: two runs can
share a schema and a prompt and still not be the same measurement, because the strategy differed,
or the model differed, or the options differed — consensus with three candidates and consensus with
five candidates are different measurements under the same strategy name.

Second, the record's own identity. A generic record has to answer "is this the same measurement?"
for a reader who has nothing but the record, and the answer has to be one a program can compute
without guessing. The alternatives are all worse in one specific way. A fingerprint-only key lets a
stale baseline pass as fresh, because the fingerprint covers the schema and the prompt, not the
settings. A strategy-only key calls two different measurements the same. A record that carries only
a timestamp and a filename cannot be compared at all.

Third, continuity. Whatever key the new record uses, its bytes will not match the existing
baselines'. The gate's fingerprint is a hash over three files' raw bytes; a generic fingerprint has
to cover a schema document and a prompt input set, canonicalised. The two digests cannot agree, so
the old baselines stop matching new runs by construction, and that break needs to be a decision
rather than a surprise found by an operator comparing two numbers.

The design for the harness is `docs/roadmap/design/ribo-cli-eval-design.md`; this ADR records the
run-record format and its freshness identity, and nothing else.

## Decision

**The eval run record is a versioned JSON document whose freshness identity is four fields:
backend, model, settings and the run fingerprint. A baseline is current only when all four match.**

The record's shape:

- `contractVersion` — the record format's own version, bumped when a field's name or meaning
  changes.
- `capturedAt` — the ISO datetime the run was captured.
- `fingerprint` — the run fingerprint: a SHA-256 over the canonical serialisation of the JSON
  Schema document together with the run's prompt inputs (instructions, examples, field-descriptions
  mode) — and of nothing else. The canonicalisation is the rule inspect already uses (recursive
  key sort, no whitespace), never a second canonicaliser.
- `backend` — the backend identity the run used.
- `model` — the model id, as its own field, not folded into the backend's identity.
- `settings` — the run's full settings as one object: the ordered strategy ladder and its options
  (consensus candidate count, max retries, response cap, and the two split caps).
- `totals`, `leafPaths`, `grid` — the counters, the leaf paths, and the dense per-leaf-per-case
  grid.
- `history` — the appended history of earlier records' identities and totals.
- `hazards` — an optional, self-describing extension carrying the hazard counts.

The record is zod-parsed on read, never cast: it is a persisted artefact crossing a trust
boundary, exactly as the Snugg record is.

The fingerprint's input set is deliberately the schema and the prompt, and **prompt text is hashed
exactly and never normalised**. "Cosmetic" means JSON key order and formatting only: a reordered
key or a reformatted whitespace leaves the fingerprint unchanged, while a whitespace-only edit to
the instructions or to an example changes it and stales the baselines.

The function computing the fingerprint (`runFingerprint`) and the function computing the record's
identity (`recordIdentity`) are exported from `@azx/ribo-cli`'s public entry, so a consumer outside
the CLI judges staleness by the same code the run used.

## Consequences

**A baseline is current only when all four fields match.** A strategy change, a model change or an
options change stales it, even though the schema and the prompt are untouched — which is the point:
those are different measurements. The cost is that a re-baseline is needed after any change to the
settings, and the benefit is that no stale number is ever presented as current.

**The fingerprint's bytes differ from the existing Snugg baselines'.** The gate's
`currentSchemaFingerprint` hashes the fixture schema file, the instructions file and the examples
file as raw bytes and prefixes the digest `sha256:`; the eval fingerprint hashes a canonicalised
schema document together with a prompt input set. The old baselines therefore stop matching new
runs. **One re-baseline is accepted**, and it is performed in the held-out gate-wrapper run — not in
this series. Everything after that re-baseline compares against records the new key governs.

**The settings object is one object, not a flat set of fields**, because the settings are compared
as a unit: a difference in any option inside them is one axis of a comparison, and a comparison
that reported "the strategy changed" for an option change would misdescribe the run.

**The record carries the model as its own field**, so a reader never has to parse a composite
identity string to learn which model produced the numbers — and so the identity key has a field to
compare rather than a substring to match.

**Continuity is not preserved across the change, by decision.** A future reader comparing a gate
baseline with an eval record will find that they do not match, and the reason is this ADR rather
than a bug: the two measure different things under different keys.
