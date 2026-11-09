# snuggProAdapter

The real `ToolAdapter` — the one place Snugg Pro field knowledge lives. `snuggProAdapter` is the
published adapter; `createSnuggProAdapter({ fetchImpl })` is the same adapter with a real write
over the host's credential-attaching transport. `snuggValuesSchema` is the writable patch and
`snuggExtractionSchema` its derived extraction schema.

## When to reach for it

Reach for this page when composing Snugg Pro into the pipeline — as the
[`ToolAdapter`](/api/tool-adapter) of a [relay](/api/relay), the target of an
[`Extractor`](/api/extractor), or the schema a [`useReview`](/guide/react) UI renders from. Reach
for the [Write-back guide](/guide/write-back) for why the adapter is "a worked example, not the
subject": any other tool's adapter follows the same shape.

## Usage

<<< @/api/examples/snuggpro-adapter.run.ts#usage

The published const is the factory called with no transport: everything but `write` works off it,
and its `write` rejects naming the factory as the fix rather than faking an unsigned write that
would teach the wrong lesson about what "written back" means.

## Options

`createSnuggProAdapter(options?)` takes `SnuggProAdapterOptions` — one member, because the
package **has no capacity to authenticate**:

| Name        | Type           | Default                 | What it does                                                                                                                                                                                                                      |
| ----------- | -------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetchImpl` | `typeof fetch` | the bare global `fetch` | Override `fetch` — inject the host's credential-attaching transport for production (which signs server-side and injects the stored credential), or a double for tests. Omitted, the write rejects naming this factory as the fix. |

The base URL is deliberately NOT an option: `snuggCtxSchema.apiBaseUrl` is the one source for it,
validated and persisted with the session. The adapter name is quoted from the example file rather
than retyped — the same file's test run asserts it against the exported constant:

<<< @/api/examples/snuggpro-adapter.run.ts#defaults

Defaults are read from `packages/ribo-adapter-snuggpro/src/adapter.ts`.

## Return value

Both the const and the factory resolve to a `ToolAdapter<SnuggValues, SnuggWriteContext>`:
`name` (`SNUGGPRO_ADAPTER_NAME`), the two field schemas (patch and derived extraction schema),
`snuggCtxSchema` for the write context, `requiredOnCreate` (the two leaves Snugg Pro's HVAC
create endpoint refuses to omit, and the incentive template uuid), `identifyingFields` (the four
fields two HVAC descriptions are certainly-different by), `snuggProInstructions`,
`snuggExamples`, and `write`.

The write refuses a multi-record patch: one `write` returns one receipt, and a patch spanning
twenty endpoints cannot honestly collapse its receipts into one — compose with
[`toInstanceWriteStep`](/api/tool-adapter), which sends one group per call.

## Errors

- The transport-less `write` rejects naming `createSnuggProAdapter({ fetchImpl })` as the fix.
- A patch naming a group this release refuses to write (`stage`, `incentive` — write-only
  refusals; their fields still flow through extraction and review) throws `TerminalError`.
- A patch spanning more than one record throws `TerminalError`, naming
  `toInstanceWriteStep` as the composition.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including the adapter name
quoted under Options. The example uses the transport-less adapter and a rejecting `fetchImpl`
only; **no live Snugg Pro credential is ever involved**.

<<< @/api/examples/snuggpro-adapter.run.ts

## Related APIs

- [`ToolAdapter`](/api/tool-adapter) and the write steps — the contract this implements and the
  compositions that wire it into the queue.
- [`enveloped`](/api/provenance) — what `snuggExtractionSchema` is derived with.

## Guides that use it

- [Write-back](/guide/write-back) — the adapter as a worked example of the shape.

## Reference

- [`snuggProAdapter`](/reference/@azx/ribo-adapter-snuggpro/variables/snuggProAdapter.html) ·
  [`createSnuggProAdapter`](/reference/@azx/ribo-adapter-snuggpro/functions/createSnuggProAdapter.html)
- [`snuggValuesSchema`](/reference/@azx/ribo-adapter-snuggpro/variables/snuggValuesSchema.html) ·
  [`snuggExtractionSchema`](/reference/@azx/ribo-adapter-snuggpro/variables/snuggExtractionSchema.html) ·
  [`snuggCtxSchema`](/reference/@azx/ribo-adapter-snuggpro/variables/snuggCtxSchema.html)
- [`SNUGGPRO_ADAPTER_NAME`](/reference/@azx/ribo-adapter-snuggpro/variables/SNUGGPRO_ADAPTER_NAME.html)
- [`SnuggValues`](/reference/@azx/ribo-adapter-snuggpro/type-aliases/SnuggValues.html) ·
  [`SnuggExtraction`](/reference/@azx/ribo-adapter-snuggpro/type-aliases/SnuggExtraction.html) ·
  [`SnuggWriteContext`](/reference/@azx/ribo-adapter-snuggpro/type-aliases/SnuggWriteContext.html) ·
  [`SnuggProAdapterOptions`](/reference/@azx/ribo-adapter-snuggpro/interfaces/SnuggProAdapterOptions.html)
