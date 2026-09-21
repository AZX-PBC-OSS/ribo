# 0014. The schema entry point is a new constructor, not a widened `perGroupExtractor`

Status: Accepted
Date: 2026-09-20

## Context

The entry point that takes a raw zod schema, a chat client and a model overlaps heavily with
`perGroupExtractor`: both compose chat calls over a target, both handle flat schemas (the `""`
fallback is effectively single-shot for one), grouped schemas, and union-cap partitioning. The
deltas are three: a raw-schema input (the `enveloped()` derivation runs inside), single-shot when
the WHOLE schema fits rather than one call per group always, and byte-cap awareness. "Extend
`perGroupExtractor`" was a live option and nearly the cheaper one.

## Decision

Build `schemaExtractor` as a new constructor that COMPOSES the presets — `singleShotExtractor`
under the caps, `perGroupExtractor` past them — rather than widening `perGroupExtractor`.

The deciding fact is the request regression gate. `perGroupExtractor`'s requests are pinned
byte-identical (`response_format.json_schema.name`, schema, messages, order) by its own suite and
the adapter's, because a request shape changed silently is a prompt-regression nobody can see.
Single-shot-when-it-fits CHANGES the request shape — fewer calls, different names — so it cannot
be a default on that preset without breaking the gate or making the gate conditional, and a
conditional regression gate guards nothing. The selection layer therefore lives above the presets,
where it changes nothing they promise.

The name names the input: the schema is what you bring. `perGroupExtractor` keeps its name because
it keeps its contract — one call per group, always.

## Consequences

Two overlapping surfaces exist, and a reader must learn which to reach for: a raw zod schema and
no per-group tuning → `schemaExtractor`; a `ToolAdapter`/target in hand, or per-group control →
the presets. The overlap is stated in `schema-extractor.ts`'s header rather than hidden. The cost
of merging the two later is one deprecation cycle, not an architecture change — the entry point is
a selection over public pieces by construction.
