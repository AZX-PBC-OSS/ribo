---
"@azx/ribo-core": minor
---

Partition the flat (non-grouped) fallback against a supplied byte cap.

A flat extraction schema (top-level leaves rather than nested groups)
used to fall back to a single entry covering the whole input — under
every cap. With a byte cap supplied, that single piece frequently
exceeded the route's character ceiling, and the request was rejected
at the provider with a `400` indistinguishable from any other schema
rejection. The grouped packer ran only on the grouped path.

`splitExtractionSchema` now partitions a flat object schema over its
top-level keys when a byte cap is supplied, producing several entries
that share `key === ""`, each a strict object carrying a disjoint
subset of leaves. The existing `key === ""` consumers
(`perGroupExtractor`'s flat-fallback plan, `groupedExtractor`'s merge,
`prepareGroups`, the inventory/fill phases) recombine them via shallow
`Object.assign` — each piece's parsed response is a disjoint subset,
so assignment in piece order is the merge.

The flat path partitions only OVER its top-level keys, so a non-object
schema (a top-level array of envelopes, an empty object) still returns
whole under a byte cap — there are no leaves to partition over, and
the split does not invent structure the schema does not carry. The
union cap does not partition a flat schema; that path is unchanged.

`prepareGroups` and `fillPhase` were reworked end-to-end alongside the
schema change:

- `prepareGroups` gives flat pieces a `${target.name}-fill-${part}` wire
  name and a `(part i+1/N)`-suffix context, not a shared
  `${target.name}-fill` for every piece. A route-side error can now
  name the piece that failed. The grouped path already did this; the
  flat path matches it.
- `fillPhase`'s merge, which previously read
  `outcome.output.value[job.group.key]` and produced `undefined` for the
  flat case (a failing close on every scoped-instance extraction of a
  flat schema on `origin/main`), now dispatches by `key === ""` and
  reads the parsed response directly.
- `perGroupPlan` narrows partitioned flat pieces' few-shot examples to
  the piece's leaf subset, matching what the grouped partition path
  already does — a response_format pinned to a subset and an
  assistant turn wider than the subset would either be off-mode or
  invented fills, neither of which anyone wanted.

`GroupMap`'s and `GroupTargets`' `""` arms accept an array of entries /
targets alongside the historical single-entry shape, so the partitioned
flat case types as a host composing a strategy over `plan.targets[""]`
expects. The flat fallback is reachable through both presets:

- `perGroupExtractor({ ..., maxSerializedCharsPerGroup })` exposes the
  option today (was already wired through to `prepareGroups`).
- `scopedInstanceExtractor({ ..., maxSerializedCharsPerGroup })` is
  NEW: the preset now passes the byte cap through to its
  `splitExtractionSchema` call, so a scoped-instance caller does not
  have to compose `prepareGroups`+`fillPhase` by hand to opt in.
