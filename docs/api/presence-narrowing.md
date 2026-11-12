# Presence narrowing

`presenceNarrowedExtractor` is a `phasedExtractor` preset that runs a presence phase and then one
value-extraction call per group the presence map marked with at least one present leaf — the
managed path's ADR 0027 narrowing. The presence phase is a **parameter**, not an import: core's
chat-backed `presencePhase` (one call per group) and the System One `systemOnePresencePhase` (every
leaf of every group in one batched request) are interchangeable here. This page is opt-in wiring —
no guide walks through it, by design.

## When to reach for it

Reach for it when the transcript discusses a fraction of the schema's leaves and every call should
ask only about what is present. Reach for [Extraction](/guide/extraction) for where the managed
strategies sit in the pipeline. A host wanting engine knobs (`concurrency`, `maxRetries`,
`onUnit`) hand-assembles the same two-phase list through [`phasedExtractor`](/api/phased-extraction)
instead.

## Usage

Core's presence phase drives one scripted chat for both phases, dispatching on the request's
structured-output schema name:

<<< @/api/examples/presence-narrowing.run.ts#usage

The same preset takes the System One presence phase unchanged — one batched request instead of one
call per group; the fill half reads the presence note, never the engine that wrote it:

<<< @/api/examples/presence-narrowing.run.ts#parameter

## Options

`presenceNarrowedExtractor(presence, options)` takes the presence phase plus
`PresenceFillPhaseOptions`.

| Name                         | Type                           | Default        | What it does                                                                                                                                                                |
| ---------------------------- | ------------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presence`                   | `Phase<V, P>`                  | **required**   | The presence phase to run first. Must be named in the fill's `requires` (the default `["presence"]` matches the shipped phases' id).                                        |
| `target`                     | `ExtractionTarget<V, P>`       | **required**   | The field knowledge; each item's projected target is derived from it.                                                                                                       |
| `groups`                     | `readonly Group[]`             | **required**   | The walked groups — the same `extractGroups` walk the presence phase was handed, so the fill asks about exactly the groups presence mapped.                                 |
| `chat`                       | `ChatClient`                   | **required**   | The injected transport for the fill calls. A fake in tests; `openAiChat` in production.                                                                                     |
| `model`                      | `string`                       | **required**   | The model id passed through to the endpoint.                                                                                                                                |
| `maxTokens`                  | `number`                       | —              | Cap on generated tokens, passed through to each call.                                                                                                                       |
| `maxNullableUnionsPerGroup`  | `number`                       | `16`           | Max nullable unions per fill call before a group's narrowed schema is partitioned across calls — the same cap and default `perGroupPlan` packs against.                     |
| `maxSerializedCharsPerGroup` | `number`                       | — (off)        | Max serialized JSON Schema characters per fill call, passed through to the split's byte cap. Narrowing runs first, so a group with few present leaves is never partitioned. |
| `groupInstructions`          | `(groupKey: string) => string` | —              | Per-group instructions assembly, mirrored from `perGroupPlan`. When omitted, every call uses the target's full instructions.                                                |
| `id`                         | `string`                       | `"fill"`       | Overrides the fill phase's id.                                                                                                                                              |
| `requires`                   | `readonly string[]`            | `["presence"]` | REPLACES the default — the complete list, not an addition. A renamed presence phase must be named here or construction throws on the dangling id.                           |

`systemOnePresencePhase(options)` takes `SystemOnePresencePhaseOptions`: the `client` and `schema`
are required; `threshold` defaults to this page's one exported constant, `DEFAULT_PRESENCE_THRESHOLD`
— `0.2` — quoted from the example file rather than retyped, and asserted against the export by the
same file's test run, so a source change that moves it fails the `test` stage:

<<< @/api/examples/presence-narrowing.run.ts#defaults

| Name        | Type              | Default                              | What it does                                                                                                                                                       |
| ----------- | ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client`    | `SystemOneClient` | **required**                         | The System One client to ask — the host's proxied, credential-attaching one.                                                                                       |
| `schema`    | `z.ZodType`       | **required**                         | The extraction schema, walked once at construction into groups and leaves.                                                                                         |
| `id`        | `string`          | `"presence"`                         | Overrides the phase's id — the default matches core's presence phase, so a System One phase can stand in for one without renaming the `requires` that point at it. |
| `threshold` | `number`          | `DEFAULT_PRESENCE_THRESHOLD` (above) | The minimum probability of "yes" a leaf's answer must reach to count as present.                                                                                   |
| `batchSize` | `number`          | —                                    | The most leaves one request carries. Unset means every leaf of every group in one call — the client batches internally anyway.                                     |

The fill's remaining defaults (the `id` of `"fill"`, `requires` of `["presence"]`) are not exported
constants; they live in source, so no example asserts them.

## Return value

An `Extractor<Enveloped<V, P>>` — the same seam as every strategy. On each `extract`:

1. The presence phase runs first and its plan is **never empty**: presence decides what everything
   else looks at. Its merge seeds every group — failed items included — with the full null
   envelope, and stores the boolean map under the presence note key. Without the seed, an
   all-false group would go missing from the fields and the closing parse would reject the result.
2. The fill phase plans one call per PIECE of every present group's narrowed schema: the active
   leaves are projected first, then split under the same caps `perGroupPlan` packs against — a
   group whose narrowed schema exceeds a cap partitions across calls exactly as the per-group
   strategy would partition it, and a group with few present leaves still costs one call. A group
   whose leaves are all absent is never asked for values and reads as the nulled seed.
3. The engine normalizes once and parses once against the full `extractionSchema` — the
   trust boundary.

## Errors

- **A dangling `requires` id throws at construction** — `validatePhases` rejects a mis-wired list
  before the first call is paid for, naming the phase and the id.
- **A failed presence item is skipped, not fatal** — the phase declares `onItemFailure: "skip"`;
  the seed's null envelopes cover the group, and the skip report says so on the session. A failed
  fill PIECE nulls only that piece's leaves, under the same policy.

Source: `packages/ribo-core/src/extraction/strategies/presence-narrowed.ts`,
`packages/ribo-core/src/phases/presence-fill-phase.ts`, and
`packages/ribo-extractor-systemone/src/presence-phase.ts`.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including
`DEFAULT_PRESENCE_THRESHOLD`.

<<< @/api/examples/presence-narrowing.run.ts

## Related APIs

- [Phased extraction](/api/phased-extraction) — the engine this preset hands its two phases to,
  and the phase vocabulary.
- [`groupedExtractor`](/api/grouped-extractor) — the sibling combinator whose per-group map the
  fill's projection mirrors.
- [`corroborateExtractor`](/api/corroborate-extractor) — the judging combinator that can sit
  outside a presence-narrowed rung.

## Guides that use it

None — this page is opt-in wiring, and no guide walks through it.
[Extraction](/guide/extraction) is where the managed strategies sit in the pipeline.

## Reference

- [`presenceNarrowedExtractor`](/reference/@azx/ribo-core/functions/presenceNarrowedExtractor.html)
- [`presencePhase`](/reference/@azx/ribo-core/functions/presencePhase.html) ·
  [`presenceFillPhase`](/reference/@azx/ribo-core/functions/presenceFillPhase.html) ·
  [`PresenceFillPhaseOptions`](/reference/@azx/ribo-core/interfaces/PresenceFillPhaseOptions.html)
- [`systemOnePresencePhase`](/reference/@azx/ribo-extractor-systemone/functions/systemOnePresencePhase.html) ·
  [`SystemOnePresencePhaseOptions`](/reference/@azx/ribo-extractor-systemone/interfaces/SystemOnePresencePhaseOptions.html) ·
  [`DEFAULT_PRESENCE_THRESHOLD`](/reference/@azx/ribo-extractor-systemone/variables/DEFAULT_PRESENCE_THRESHOLD.html)
