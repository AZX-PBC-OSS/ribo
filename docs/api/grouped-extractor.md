# groupedExtractor

`groupedExtractor` is the run-owner combinator: it takes a per-key map of
[`Extractor`](/api/extractor)s — typically a [`singleShotExtractor`](/api/single-shot-extractor)
over a projected target per group — runs them concurrently, and assembles one result. It owns the
cross-group work: coverage checked at construction, scheduling, per-entry retry, sibling abort,
the merge, the closing parse. `GroupMap`, `UnwrappedEntry`, `GroupedEntries`,
`GroupedExtractorOptions` and the `UNWRAPPED_KEY` marker live here too.

## When to reach for it

Reach for it when a schema is partitioned across groups and one group needs different treatment
from the rest — different model, different retry posture, its own wrapper. Reach for
[Schema at Scale](/guide/schema-at-scale) for why a real schema has to be partitioned, and
[Per-Group Composition](/guide/per-group) for how the split produces this map.

## Usage

Every group runs on `scriptedChat` — no credentials, no network.

<<< @/api/examples/grouped-extractor.run.ts#usage

Each entry is an opaque `Extractor` — typically a `singleShotExtractor` over a projected target,
possibly wrapped — so per-group heterogeneity is composition, not options.

## Options

`groupedExtractor(options)` takes `GroupedExtractorOptions` — the timing knobs plus the coverage
declaration. The defaults the page states are quoted from the example file rather than retyped, and
the same file's test run asserts the exported constants against the documented values and observes
the retry behaviour against the default `maxRetries` — so a source change that moves one fails the
`test` stage:

<<< @/api/examples/grouped-extractor.run.ts#defaults

| Name               | Type                                           | Default                                                      | What it does                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`           | `ExtractionTarget<V, P>`                       | **required**                                                 | The field knowledge the whole run is pinned to: the merged result is parsed against `extractionSchema`, and its top-level keys are what `groups` (plus `unwrapped`) must cover.                                                             |
| `groups`           | `GroupMap<V, P>`                               | —                                                            | The named arm: one `Extractor` per top-level key, exhaustive over the schema's keys — a missing group is a compile error. A key mapped to a list is a partitioned group; its pieces run as separate entries and recombine at the merge.     |
| `unwrapped`        | `UnwrappedEntry<V, P>`                         | —                                                            | The unwrapped portion — pieces whose schema is not nested under a group key, merged by shallow assign. Alone it is the whole schema (the non-grouped fallback); beside named groups it is the loose remainder. Never a `groups` key.        |
| `concurrency`      | `number`                                       | `4`                                                          | Max concurrent group entries — the same bound the per-group extractor applies, so the worst case fits inside the relay's step timeout. Read from `packages/ribo-core/src/extraction/grouped-extractor.ts`; not exported, not asserted here. |
| `maxRetries`       | `number`                                       | `2` (above, observed)                                        | Max retries per entry after a transient failure — total attempts is `maxRetries + 1`, capped by the derived budget. Terminal failures are never retried.                                                                                    |
| `stepTimeoutMs`    | `number`                                       | `900_000`                                                    | The relay's step timeout, used to derive the retry budget. Read from `packages/ribo-core/src/extraction/grouped-extractor.ts`; not exported, not asserted here.                                                                             |
| `perCallCeilingMs` | `number`                                       | `PER_CALL_CEILING_MS` (above)                                | Conservative upper bound on ONE group entry's wall-clock duration, used to derive the retry budget. An entry that makes several calls should raise this so the budget is sized honestly.                                                    |
| `delay`            | `(ms: number) => Promise<void>`                | `setTimeout`                                                 | Injectable sleep between retry attempts, so tests do not wait real seconds. The value passed is the `fullJitterDelay` result in milliseconds.                                                                                               |
| `normalize`        | `(fields: Enveloped<V, P>) => Enveloped<V, P>` | identity                                                     | The model-free pass run once on the MERGED result, not per group — running it per group would run it on partial shapes for no benefit.                                                                                                      |
| `baseMs`, `capMs`  | `number`                                       | `DEFAULT_BACKOFF_BASE_MS` / `DEFAULT_BACKOFF_CAP_MS` (above) | The backoff curve the retry sleeps on.                                                                                                                                                                                                      |
| `onUnit`           | observer                                       | —                                                            | `GroupUnit` events around each entry's `extract()` — `key`, `part`, `parts`, `attempt`. An entry's own inner units flow through whatever `onUnit` its own builder gave it.                                                                  |

Defaults are read from `packages/ribo-core/src/extraction/grouped-extractor.ts`,
`packages/ribo-core/src/async/retry-budget.ts` and `packages/ribo-core/src/storage/backoff.ts`.

## Return value

`groupedExtractor` returns an `Extractor<Enveloped<V, P>>`. On each `extract`:

1. Run the flattened entries concurrently under a bounded pool; each entry receives the run's
   combined signal — the caller's signal `AbortSignal.any`-ed with the run's own sibling-abort
   controller, never substituted for it.
2. Retry each entry on transient failure with `fullJitterDelay` backoff, up to the derived budget;
   emit a `GroupUnit` around each attempt.
3. Merge by key; a partitioned group's pieces recombine.
4. **Second trust-boundary parse** — validate the merged whole against the full `extractionSchema`.
   Not redundant: it catches a merge that produced a shape no single entry would have.
5. Normalize once; sum usage across entries; union `statedEmptyGroups`.

The read-side events for the unwrapped portion carry the internal marker key `UNWRAPPED_KEY`
(`""`) — it can never collide with a schema property, because the review leaf-path grammar refuses
an empty key. Callers never spell it: the portion is declared with the `unwrapped` option.

## Errors

- **Coverage, checked at construction.** A missing top-level key, an extra key the schema does not
  have, or a redundant `unwrapped` entry beside named groups that already cover every key all
  throw at construction, naming the key — silent partial coverage would otherwise surface as a
  second-parse failure after every call had been paid for. For a TypeScript caller the exhaustive
  map makes a missing group a compile error.
- **Merge ownership.** An `unwrapped` entry whose result carries a key a named entry covers throws
  at the merge, naming the key: assigned last, its value would silently overwrite the named
  entry's, and the closing parse validates shape only.
- **Retries.** A transient failure is retried with backoff up to the derived budget;
  `TerminalError` is never retried; a `SchemaParseError` stays transient and retryable.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every `test`
run, ending in assertions on exactly what this page claims — including the defaults quoted under
Options.

<<< @/api/examples/grouped-extractor.run.ts

## Related APIs

- [`Extractor`](/api/extractor) — the seam the entries implement, and the options bag `extract`
  takes.
- [`singleShotExtractor`](/api/single-shot-extractor) — the entry builder the example composes.
- [Test doubles](/api/test-doubles) and [`scriptedChat`](/api/chat-transports) — what the example
  runs on.

## Guides that use it

- [Per-Group Composition](/guide/per-group) — how the split produces this map, and when one group
  needs its own entry.
- [Schema at Scale](/guide/schema-at-scale) — why a real schema is partitioned across calls.

## Reference

- [`groupedExtractor`](/reference/@azx/ribo-core/functions/groupedExtractor.html)
- [`GroupedExtractorOptions`](/reference/@azx/ribo-core/type-aliases/GroupedExtractorOptions.html)
- [`GroupMap`](/reference/@azx/ribo-core/type-aliases/GroupMap.html)
- [`UnwrappedEntry`](/reference/@azx/ribo-core/type-aliases/UnwrappedEntry.html)
- [`GroupedEntries`](/reference/@azx/ribo-core/type-aliases/GroupedEntries.html)
- [`UNWRAPPED_KEY`](/reference/@azx/ribo-core/variables/UNWRAPPED_KEY.html)
