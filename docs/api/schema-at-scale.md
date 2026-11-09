# Schema at scale

One page for the whole split-and-per-group family: `splitExtractionSchema` cuts a target's
extraction schema into one entry per top-level group (partitioning a group further when a cap
binds), `describeExtraction` reports what a schema will become before anything is constructed, the
`perGroup*` family runs one call per group, `overrideGroups` replaces one group's entry, and the
scoped-instance, gap-fill and shape-derivation families sit on top. The models' structured-output
ceilings — property caps, enum caps, nullable-union caps — are why this family exists at all; a
bigger context window does not move them.

## When to reach for it

Reach for this page when wiring extraction over a real schema — the split, the dry run, the
per-group plan, the derived shape. Reach for the [Schema at Scale guide](/guide/schema-at-scale)
for the measurements that found the caps, [From a Schema](/guide/from-a-schema) for the
one-call entry point that composes the derivation for you, and
[Per-Group Composition](/guide/per-group) for giving one group its own model or wrapper.

## Usage

The split and the description are model-free — pure functions over a zod schema:

<<< @/api/examples/schema-at-scale.run.ts#usage

## Options

`splitExtractionSchema(schema, options?)` takes `SplitOptions` (a number is shorthand for
`maxNullableUnionsPerGroup`); `describeExtraction(options)` takes `DescribeExtractionOptions`.

| Name                          | Function                | Type                           | Default                                  | What it does                                                                                                                                                                                                                    |
| ----------------------------- | ----------------------- | ------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxNullableUnionsPerGroup`   | `splitExtractionSchema` | `number`                       | `MAX_NULLABLE_UNIONS_PER_CALL` (presets) | Max nullable unions per piece before a group is partitioned across pieces sharing its key. The split itself has **no default** — omitted, it keeps one entry per group; the presets default the option to the shipped constant. |
| `maxSerializedCharsPerGroup`  | `splitExtractionSchema` | `number`                       | off                                      | Max serialized JSON Schema characters per piece; a group over it is partitioned further. The library carries no provider's byte cap (ADR 0015).                                                                                 |
| `partitions`                  | `splitExtractionSchema` | `ShapePartitions`              | —                                        | Name the parts a group's calls are cut along; the calls for one part never mix another's fields.                                                                                                                                |
| `schema` / `extractionSchema` | `describeExtraction`    | `z.ZodObject` / `z.ZodType`    | **exactly one**                          | Either the plain patch schema (the derivation runs, the report describes the derived schema) or an already-derived extraction schema used as-is. Both or neither throws.                                                        |
| `name`                        | `describeExtraction`    | `string`                       | —                                        | When supplied, the same wire-name guard the constructors run is run here, reported as `stage: "name"` instead of thrown.                                                                                                        |
| `maxTokens`                   | `perGroupPlan`          | `number`                       | —                                        | Cap on generated tokens, passed through to each call.                                                                                                                                                                           |
| `groupInstructions`           | `perGroupPlan`          | `(groupKey: string) => string` | —                                        | Per-group instructions assembly; each few-shot example is projected to the group's key. When omitted, every call uses the target's full instructions.                                                                           |
| `singleton`                   | `perGroupPlan`          | `boolean`                      | `false`                                  | Constrain collection groups to a single element per call — the degraded tier the instance-modeling ladder falls back to.                                                                                                        |

`perGroupExtractor` / `perGroupArrayExtractor` / `perGroupSingletonExtractor` take
`PerGroupOptions` — the same timing knobs (`concurrency` 4, `maxRetries` 2, `stepTimeoutMs`
900_000, `perCallCeilingMs` `PER_CALL_CEILING_MS`) the [`groupedExtractor`](/api/grouped-extractor)
page documents, with the same values, so they are not re-asserted here.

`MAX_NULLABLE_UNIONS_PER_CALL` is the one exported constant in this family — its value is `16` —
quoted from the example file rather than retyped, and asserted against the export by the same
file's test run, so a source change that moves it fails the `test` stage:

<<< @/api/examples/schema-at-scale.run.ts#defaults

Every other default
on this page lives in source, not in an exported constant, so no example asserts it — the values
are stated from `packages/ribo-core/src/extraction/schema/split-schema.ts`,
`describe-extraction.ts`, `packages/ribo-core/src/extraction/strategies/per-group.ts`,
`packages/ribo-core/src/extraction/scoped-instance/instance-fill.ts`,
`packages/ribo-core/src/extraction/gap-fill/gap-fill.ts` and
`packages/ribo-core/src/extraction/shape/shape-operations.ts`.

## Return value

- `splitExtractionSchema` returns `readonly ExtractionGroup[]` — one per top-level group (or a
  fallback entry covering the whole schema), each carrying its key, a strict sub-schema, and, when
  partitioned, `part` / `parts` coordinates. A partitioned group's pieces recombine at the merge.
- `describeExtraction` returns an `ExtractionDescription`: the top-level `keys` and their
  group/loose kinds, the split `path` (`"grouped"` / `"flat"`, with `flatReason`), the `callShape`
  `schemaExtractor` would select, whole and per-piece measures, and — present exactly when the
  real constructors would throw — the `refusal`, carried verbatim rather than thrown.
- `perGroupPlan` returns a `PerGroupPlan` — the derived entries and projected targets.
  `overrideGroups(plan, overrides)` returns `GroupedEntries` that spread straight into
  [`groupedExtractor`](/api/grouped-extractor): an override is invoked once per piece with that
  piece's default extractor and projected target, so a partitioned group's override applies to
  every piece.
- `deriveExtractionShape(schema, { operations })` returns the artifact pair — an extraction schema
  and the mapping back as data — or throws the first refusal;
  `deriveExtractionShapePartially` collects every refusal it can find in one pass plus the artifact
  derived from the operations that survived.
- `reshapedExtractor(inner, shape)` wraps an extractor over the extraction shape with the mapping
  back: its results become results in the derived patch's space, validated against the patch's own
  envelope at construction.
- `gapFillExtractor({ base, target, chat, model, ... })` re-asks leaves that abstained despite
  quoting evidence (value null, span non-null), in one bounded follow-up call;
  `targets: ["ungrounded"]` additionally re-asks committed leaves citing text absent from the
  transcript — off by default, a second cost centre on a paid endpoint.
- `extractInventory(options)` makes one house-wide roster call, parsed through a supplied roster
  schema; `scopedInstanceExtractor` composes the inventory with one fill call per current instance
  (`prepareGroups` is the one construction site for the per-piece groups both phases take).

## Errors

- **The split packs, never lies**: a single property whose own serialized size is over the cap
  throws at construction, naming the group, the property, the measured size and the cap.
- **`describeExtraction` throws** only for misuse of its own options (both or neither schema key,
  derivation options beside a passthrough); a fact about the schema is reported as `refusal`,
  never thrown.
- **`deriveExtractionShape` throws the canonically-first refusal**; the partial surface returns
  every refusal, classified (local / consequential / set, with the consequential culprit named).
- **`scopedInstanceExtractor` throws** when a group's current instances exceed the hard ceiling
  (10, from source) — a truncated collection silently drops a real system.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including
`MAX_NULLABLE_UNIONS_PER_CALL`.

<<< @/api/examples/schema-at-scale.run.ts

## Related APIs

- [`groupedExtractor`](/api/grouped-extractor) — the run-owner combinator the plan's entries
  spread into.
- [`Extractor`](/api/extractor) — the seam every member of the family implements.
- [Provenance](/api/provenance) — the granularity knob several of these options mirror.

## Guides that use it

- [Schema at Scale](/guide/schema-at-scale) — the measurements behind the caps, and why
  partitioning is not a stopgap.
- [From a Schema](/guide/from-a-schema) — the one-call entry point that composes the shape
  derivation for you.
- [Per-Group Composition](/guide/per-group) — giving one group its own model, strategy or wrapper.

## Reference

- [`splitExtractionSchema`](/reference/@azx/ribo-core/functions/splitExtractionSchema.html) ·
  [`SplitOptions`](/reference/@azx/ribo-core/interfaces/SplitOptions.html) ·
  [`ExtractionGroup`](/reference/@azx/ribo-core/interfaces/ExtractionGroup.html)
- [`describeExtraction`](/reference/@azx/ribo-core/functions/describeExtraction.html) ·
  [`ExtractionDescription`](/reference/@azx/ribo-core/interfaces/ExtractionDescription.html)
- [`perGroupExtractor`](/reference/@azx/ribo-core/functions/perGroupExtractor.html) ·
  [`perGroupArrayExtractor`](/reference/@azx/ribo-core/functions/perGroupArrayExtractor.html) ·
  [`perGroupSingletonExtractor`](/reference/@azx/ribo-core/functions/perGroupSingletonExtractor.html) ·
  [`perGroupPlan`](/reference/@azx/ribo-core/functions/perGroupPlan.html) ·
  [`overrideGroups`](/reference/@azx/ribo-core/functions/overrideGroups.html)
- [`scopedInstanceExtractor`](/reference/@azx/ribo-core/functions/scopedInstanceExtractor.html) ·
  [`extractInventory`](/reference/@azx/ribo-core/functions/extractInventory.html)
- [`gapFillExtractor`](/reference/@azx/ribo-core/functions/gapFillExtractor.html)
- [`deriveExtractionShape`](/reference/@azx/ribo-core/functions/deriveExtractionShape.html) ·
  [`deriveExtractionShapePartially`](/reference/@azx/ribo-core/functions/deriveExtractionShapePartially.html) ·
  [`reshapedExtractor`](/reference/@azx/ribo-core/functions/reshapedExtractor.html)
