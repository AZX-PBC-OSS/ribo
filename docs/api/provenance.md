# Provenance

Every extracted field carries its own citation. `enveloped()` derives the **extraction schema**
(the enveloped shape the model is asked to produce) from a **patch schema** (the plain shape a
host writes back), `extractedSchema` is the per-leaf envelope it wraps, and `isSpanGrounded` /
`spanGroundedness` check a citation against the transcript without trusting the model.
`groundingCensus` tallies how well a whole result is cited.

## When to reach for it

Reach for this page to look up the envelope's shape, the granularity option, or the span check.
Reach for the [Provenance guide](/guide/provenance) for why every key is nullable and required,
and [Typesafety](/guide/typesafety) for the derivation's type-level guarantees. Adapters never
build an extraction schema by hand: [`ToolAdapter`](/api/tool-adapter) requires
`enveloped(schema)`.

## Usage

<<< @/api/examples/provenance.run.ts#usage

The derivation strips the patch's `.optional()`/`.nullable()` wrappers, wraps every leaf in
`extractedSchema`, and rebuilds every object — top-level and nested — as closed and fully
required. Every key is required and nullable so the model emits an explicit `null` for "not
stated" rather than silently omitting the field; that anti-hallucination rule is why the
extraction schema cannot be the patch.

## Options

`enveloped(values, options?)` takes `EnvelopedOptions` — one member. The defaults the page
states are quoted from the example file rather than retyped, and the same file's test run asserts
the row-span key against the exported constant and observes the default granularity — so a
source change that moves one fails the `test` stage:

<<< @/api/examples/provenance.run.ts#defaults

| Name         | Type                          | Default                    | What it does                                                                                                                                                                                                      |
| ------------ | ----------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provenance` | `ProvenanceMap<T>`            | `undefined` (above)        | Per-group granularity declaration: top-level group key → `"leaf"`, `"row"` or `"none"`. A group absent from the map keeps `"leaf"` — which is what makes the option additive for every existing caller.           |
| —            | `ProvenanceGranularity`       | `"leaf"` (above, observed) | `"leaf"` wraps every leaf in `extractedSchema`; `"row"` leaves the leaves plain and adds ONE `sourceSpan` per row (no `confidence` — the model is not asked for one); `"none"` is plain leaves, no span anywhere. |
| —            | `ROW_SOURCE_SPAN_KEY` (above) | `"sourceSpan"`             | The key a row's citation is written under. Fixed, not configurable: the split, review and every consumer must agree on one name.                                                                                  |

Declaring `"row"` on a group that is not shaped like a row — a bare leaf, or a group that already
declares its own `sourceSpan` field — throws at schema build time, naming the group. So does an
unknown group key: a typo would otherwise silently leave the group at `"leaf"`, with hundreds of
citations nobody wanted.

Defaults are read from `packages/ribo-core/src/provenance/enveloped.ts`,
`provenance/provenance.ts` and `provenance/grounding-census.ts` — the same files the Errors
section is read from.

## Return value

`enveloped()` returns a zod object schema (closed at every level) whose inferred type is
`Enveloped<V, P>` — the patch's shape with every leaf an `Extracted<X>`:
`{ value: X | null; confidence: number; sourceSpan: string | null }`. Under `"row"` a row unit
gains `{ sourceSpan: string | null }` instead of per-leaf envelopes.

The span check answers a question `confidence` cannot — it carries no discriminating signal, and
must never drive a flagging threshold:

- `isSpanGrounded(span, transcript)` — is the quote verbatim? `null` and empty are never grounded.
- `spanGroundedness(span, transcript)` — three tiers: `"grounded"`, `"near-miss"` (differing only
  in case, whitespace runs or quote characters — the tier that stops a document's column padding
  reading as a fabrication), `"ungrounded"`.
- `groundingCensus(fields, statedEmptyGroups, transcript)` — the tally over a whole result: per
  leaf `committed` / `cited` / `groundedness` (null for an abstention, so an honest "not stated"
  stays distinguishable from a fabrication), plus stated-empty group spans, plus derived counts.

## Errors

- A shape `enveloped()` cannot express — a record, a union (including a union of objects) — throws
  naming the field path: these shapes are rejected by OpenAI strict structured-output mode, and
  the failure is far more useful here than as an opaque API error later.
- An unknown granularity value, an unknown group key, or `"row"` on a leaf-shaped group throws at
  schema build time (the same check `buildReviewRequest` reuses), naming the group.
- `groundingCensus` throws nothing: it is a pure tally over whatever fields it is handed.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including the defaults quoted
under Options.

<<< @/api/examples/provenance.run.ts

## Related APIs

- [`ToolAdapter`](/api/tool-adapter) — the boundary `enveloped()` exists for: `extractionSchema`
  is derived, never hand-written.
- [`Extractor`](/api/extractor) — the seam that returns enveloped fields, and the usage bag.
- [Test doubles](/api/test-doubles) — the fakes that produce enveloped fields with no model.

## Guides that use it

- [Provenance](/guide/provenance) — the envelope, the span check, and the granularity knob.
- [Write-back](/guide/write-back) — why an adapter carries two field schemas and how one is
  derived from the other.

## Reference

- [`enveloped`](/reference/@azx/ribo-core/functions/enveloped.html)
- [`extractedSchema`](/reference/@azx/ribo-core/functions/extractedSchema.html)
- [`isSpanGrounded`](/reference/@azx/ribo-core/functions/isSpanGrounded.html) ·
  [`spanGroundedness`](/reference/@azx/ribo-core/functions/spanGroundedness.html)
- [`groundingCensus`](/reference/@azx/ribo-core/functions/groundingCensus.html)
- [`Enveloped`](/reference/@azx/ribo-core/type-aliases/Enveloped.html) ·
  [`EnvelopedOptions`](/reference/@azx/ribo-core/interfaces/EnvelopedOptions.html) ·
  [`NoProvenance`](/reference/@azx/ribo-core/type-aliases/NoProvenance.html) ·
  [`ProvenanceMap`](/reference/@azx/ribo-core/type-aliases/ProvenanceMap.html) ·
  [`ProvenanceGranularity`](/reference/@azx/ribo-core/type-aliases/ProvenanceGranularity.html) ·
  [`ROW_SOURCE_SPAN_KEY`](/reference/@azx/ribo-core/variables/ROW_SOURCE_SPAN_KEY.html)
