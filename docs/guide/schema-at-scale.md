# Schema at Scale

A real system of record's target schema does not fit in one model call, and provenance makes that
worse rather than better. This page is what breaks, why, and what Ribo does about it. The numbers are
in [Schema at Scale: Measured](/deep-dives/schema-scale).

## The wall

Snugg Pro — the field-service system of record one of Ribo's own adapters writes into — exposes
**837 distinct writable fields**, walked directly from its write operations. That is the size
of "the whole spec" for a system built to record a home-energy audit, and it is not an
unusually large one: most systems of record this pipeline targets are built the same way, with a
schema that grew field by field over years of vendor requirements.

An older pass measured a related but different figure — **~1,326 leaves** — against a 2026-08-06
snapshot of `allJobData`, the union of every field the API can _return_ for a job, including the
read-only surface too — every computed rollup and total, a different, larger set than what an
extraction schema actually needs to produce. The spec drifted after the snapshot was taken, so treat
837 as the number to reason from and ~1,326 as "how big does this get," not as a live count of the
same thing.

Provenance does not shrink that problem. It multiplies it. Wrapping a leaf in the envelope replaces
its one key with a `{ value, confidence, sourceSpan }` object — three members on that wrapper — which
means the **schema** grows by **four** properties where the patch declared one: the leaf's own key,
plus `value`, `confidence`, and `sourceSpan`. [Typesafety](/guide/typesafety) and
[Provenance](/guide/provenance) cover why the envelope looks like this; here the only thing that
matters is that it multiplies count, so citation fidelity and schema scale are the same problem
wearing two names.

Measured against that 2026-08-06 snapshot, enveloping `allJobData` produces **~5,360 properties
against a documented 5,000-property structured-output cap**, and **~1,490 enum values against a
documented 1,000-value cap** — over both limits at once, before any question of extraction quality
arises. The API refuses the request; this is not a quality problem.

A second ceiling binds much sooner, and it was found by running calls rather than by reading a
vendor's documentation: on the managed LLM route Ribo's extractors call through, one model family
rejects any response schema carrying more than **16 nullable unions** — 16 accepted, 18 rejected, on
otherwise-identical schemas. An enveloped leaf costs two nullable unions (`value` and `sourceSpan`,
both nullable), so that ceiling works out to **8 enveloped leaves per call** on that model family.
Two of the extraction groups already committed at the time of that measurement, `hvac` and `health`,
already exceeded it. **This is our own measurement, taken against one deployment, through one route,
with one dev token — not a published vendor limit.** What is established is narrower: on the
identical route, a schema shape one family rejects, another accepts. Whether 16 is that model
family's own cap or this particular route's translation of it is unknown. See
[Schema at Scale: Measured](/deep-dives/schema-scale) for the full table and the bisection that found it.

## Why partition on nullable unions, not leaves

Capping the number of _leaves_ per call doesn't work, because a
leaf's cost in nullable unions depends on the provenance granularity its group was derived with —
covered in [Provenance](/guide/provenance) — and a leaf-based cap either overshoots or undershoots
depending on which granularity a group happens to use.

An enveloped (`"leaf"`-granularity) field costs two nullable unions: `value` and `sourceSpan` are
both `X.nullable()`. A field under `"row"` or `"none"` granularity costs one, because those leaves
are plain nullable values with no per-leaf `sourceSpan` at all. Sixteen enveloped leaves and sixteen
row-granularity leaves are not the same request: the first is already double the 16-union ceiling,
the second is right at it — and, going the other way, a 15-leaf `"row"` group plus its one shared
row-level span is only 16 unions and fits in a single call, while a leaf count capped at 8 would
split that same group in two for no reason at all. Counting the thing the vendor's route actually
rejects on removes the guesswork; counting leaves would either strand a group nowhere near the real
ceiling or split a group that never needed to be split.

## The machinery

`splitExtractionSchema` (`@azx/ribo-extractor-openai`) is the pure, model-free half of this: given a
target's `extractionSchema`, it derives one `ExtractionGroup` per top-level key the schema's own
`enveloped()` derivation produced — no adapter wiring, no hard-coded group list. Pass a
`maxNullableUnionsPerGroup` (the extractors below default it to the exported
`MAX_NULLABLE_UNIONS_PER_CALL`, 16), and any group over that count is partitioned further into
multiple entries that all share the same top-level `key`, so the response still lands under one
property the caller expects.

```ts
import { MAX_NULLABLE_UNIONS_PER_CALL, splitExtractionSchema } from "@azx/ribo-extractor-openai";

const groups = splitExtractionSchema(target.extractionSchema, MAX_NULLABLE_UNIONS_PER_CALL);
// one entry per group, or several sharing a key for a group over the cap
```

The split packs against **two** caps: the union cap above and — when the caller supplies it — a
serialized-character ceiling measured on each piece's rendered JSON Schema. The byte cap is an
option without a library default: the ceiling is named by one route's error text and differs by
route, so the caller whose chat client chose the route supplies the number.
[From a Schema](/guide/from-a-schema) shows the entry point that takes it, and a newcomer's whole
path from a plain zod schema to a parsed extraction.

### Ask before you build: `describeExtraction`

Everything above is knowable before you construct anything. `describeExtraction` is the split's
dry run — synchronous, no chat client, no model — answering the questions that otherwise cost a
probe script each: which top-level keys are groups and which are loose, which split path applies
(and, when flat, which loose keys forced it), whether the whole schema fits in one call, how many
pieces the caps produce and what each measures, and whether construction would succeed:

```ts
import { describeExtraction } from "@azx/ribo-extractor-openai";

const report = describeExtraction({
  extractionSchema: target.extractionSchema, // or `schema` plus shape `operations`
  maxSerializedCharsPerGroup: 32_768, // your route's number; omitted means off
});

if (report.refusal !== undefined) {
  report.refusal; // { stage: "derive" | "name" | "split", message } — the real error, verbatim
} else {
  report.callShape; // "single-shot" | "per-group"
  report.pieces; // one row per call: key, part/parts, nullableUnions, serializedChars, depth
  report.whole; // the same three measures for the unsplit schema
}
```

Two readings are worth calling out. `path: "flat"` with `flatReason` naming loose keys is the
silent failure this page opened with made loud: one loose top-level leaf collapses every group you
nested into a single flat call — and, under a byte cap, a group the flat packer must treat as one
atomic property becomes a construction refusal, so a partially nested schema can fail to split at
all. And `depth` is **reported, never capped**: the split packs against unions and bytes only, so
compare each piece's `depth` against your own route's nesting limit yourself — no call shape fixes
a too-deep schema.

The report cannot drift from what construction does, by construction: it derives with the real
`deriveExtractionShape`, classifies with the split's own `topLevelKeyKinds`, splits with
`splitExtractionSchema` under the presets' defaulting, and measures with the functions the packers
pack against — and a differential test suite asserts the report against what `perGroupPlan` and
`schemaExtractor` actually build, over a corpus covering every branch, plus the real Snugg Pro
schema. On the raw input shape the report also carries `shape`, the derived artifact itself, so a
describe-then-build caller pays the derivation once and wires it straight into `schemaExtractor`'s
`extractionSchema` passthrough.

`perGroupExtractor` turns that split into calls: one chat request per group (or per partition), run
concurrently against a bounded pool, each response parsed against its own group schema before the
whole is reassembled and parsed again against the full `extractionSchema` — a second trust-boundary
check that catches a merge shape no single call would have produced. Underneath, it is a preset over
core's `groupedExtractor` — the run-owner that schedules the calls, retries them, aborts siblings on
a terminal failure, and merges — with `perGroupPlan` deriving the default per-group entries from
`splitExtractionSchema`. That layering is why one group can be given a different model, strategy or
wrapper while the other nineteen keep the preset's defaults:
[Per-Group Composition](/guide/per-group) is that capability, and this page does not restate it. The
preset has two siblings for the instance-modeling ladder below: `perGroupArrayExtractor`, whose
per-group response is an array of instances, and `perGroupSingletonExtractor`, whose per-group
response is exactly one.

Splitting a call in two does not make abstention disappear on its own, so a separate pass sits on
top of whichever extractor produced the result. `gapFillExtractor` wraps a base extractor and, after
it returns, collects every leaf where the model quoted a real `sourceSpan` but still left
`value: null` — an **abstained-with-evidence** leaf: not "found nothing," but "found the right
passage and didn't commit to it." With any candidates, it makes exactly one bounded follow-up call
scoped to just those leaves, handing the model back its own quote and asking it to either commit to
the value or explicitly reaffirm `null`. With no candidates, the base result passes through
unchanged — no second call, no wrapper. Its `targets` option widens the pass: the default
`["abstained"]` is the behaviour above, and `targets: ["abstained", "ungrounded"]` also re-asks
leaves that committed to a value while citing text absent from the transcript — both kinds travel
in the one follow-up call, since they share everything that makes it expensive. On a 126-leaf Manual
J, re-asking converted about half the ungrounded spans to verbatim quotes; it is off by default
because it is a second cost centre on a paid endpoint, and because a leaf that asks the model for
its own judgement rather than a fact will report ungrounded forever. Those leaves do not belong in
an envelope; the option will not rescue them.

Repeating resources — a house's several HVAC systems, several water heaters — need a different shape
of call than a fixed set of top-level groups, because the number of instances isn't known ahead of
extraction. `extractInventory` runs one house-wide call that returns a roster of candidate instances
per collection group, scaffolding for the fills that follow rather than something reviewed directly.
`instanceLadder` composes three strategies for turning that roster into real per-instance data,
falling from the strongest to weaker ones only as each fails:

1. An inventory pass followed by scoped per-instance fills — each instance sees only its own slot,
   siblings held out of scope.
2. Failing that, a per-group call where the model emits an array of instances in one shot, with
   weaker isolation.
3. Failing that, a per-group call where the model emits a single instance — it cannot represent a
   second one at all, but it still beats no record when an auditor is offline in a basement.

The accepted tier is stamped onto the result's `usage.strategy` field, and which degraded tier is
acceptable is a host policy decision expressed through the arbiter passed in — the SDK does not
impose one.

## What's closed, and why

Whole-spec extraction — one call, one schema, covering everything a system of record can write — is
closed. Not because it would extract badly: it is closed on hard limits, before quality is ever
measured. Enveloping the full spec blows past both a structured-output API's own documented
property and enum ceilings simultaneously, and a scoped-down subset that does fit under those still
runs into a second, model-family-specific nullable-union ceiling that binds far sooner. Neither
failure is a tuning problem; both are the request being refused outright. That's why this repo
partitions instead of scaling one call up, and why partitioning is not a stopgap waiting on a bigger
context window — a bigger window does not move a property cap, an enum cap, or a per-family
nullable-union cap.

## Next

[Per-Group Composition](/guide/per-group) covers what the partition makes possible — giving one
group its own model, strategy or wrapper while the rest keep the defaults.
[Provenance](/guide/provenance) covers the granularity knob this page's union counts depend on, and
[Typesafety](/guide/typesafety) covers the `enveloped()` derivation that produces the schema being
partitioned in the first place.
[Comparison](/guide/comparison) is where this differentiator sits next to what other tools do
instead. The full measurement — the bisection that found the nullable-union ceiling, the byte-cap
numbers, and everything this page only summarizes — is in
[Schema at Scale: Measured](/deep-dives/schema-scale).
