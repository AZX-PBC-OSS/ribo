# Extractor

An `Extractor` turns one annotated transcript into structured host-tool fields: `extract()`
resolves to an `ExtractionResult` — parsed fields, what the run cost, and the per-item reports the
review screen reads. It is the seam every extraction strategy plugs into — the sibling of the
[`Transcriber`](/api/transcriber) contract. `ExtractOptions`, `ExtractionResult`,
`ExtractionUsage`, `ExtractionTarget`, `SkippedItem` and the `toSessionExtractStep` bridge live
here too.

## When to reach for it

Reach for the contract when **implementing or composing** a strategy: ladders, races and
per-group maps all speak `Extractor`, and the relay consumes any of them through one bridge.
Reach for the [Extraction guide](/guide/extraction) when you want the flow — schema, provenance,
review — rather than the shape of one seam. Network-bound by nature, which is why the relay runs
it as a queued step.

## Usage

<<< @/api/examples/extractor.run.ts#usage

`F` is the fields this extractor yields. For an adapter-backed strategy that is the enveloped
shape, `Enveloped<V>`, whose source of truth is the adapter's `extractionSchema` — the model's
output is parsed through it before the result becomes field data. It is only after review that
the plain-values `V` exists. A plain builder, not a capability contract: strategy choice here is
configuration, not device probing.

## Options

`extract(transcript, options?)` takes `ExtractOptions` — an optional trailing object. Neither
member has a default; both are supplied by the caller or not at all.

| Name       | Type          | Default | What it does                                                                                                                                                                                                                                                                                      |
| ---------- | ------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`   | `AbortSignal` | —       | Cancels the extraction attempt. Advisory: honouring it is the callee's job, the same contract the transcriber's `signal` has. A delegating combinator forwards the bag whole — never destructure-and-rebuild, which drops members.                                                                |
| `deadline` | `number`      | —       | Absolute epoch milliseconds after which the caller considers the run failed — **not** a duration. Compare with `Date.now()`, never a captured start time. A combinator that holds its own budget narrows, never widens: its effective deadline is the `Math.min` of its own and any it inherited. |

The defaults this page states belong to `FakeExtractor`, the extractor the example runs on, and
are quoted from the example file below rather than retyped: with no options its reported usage is
exactly `{ calls: 0 }` — a fake makes no model calls. The same file's test run asserts that value,
so a source change that moves it fails the `test` stage:

<<< @/api/examples/extractor.run.ts#defaults

The contract — `Extractor`, `ExtractOptions`, `ExtractionResult`, `ExtractionUsage`,
`ExtractionTarget`, `SkippedItem` — is read from
`packages/ribo-core/src/extraction/extractor.ts`.

## Return value

`extract()` resolves to an `ExtractionResult<F>`:

- `fields` — the structured fields, already parsed to `F` at the trust boundary.
- `raw` — the raw model output, optional, kept for provenance and debugging.
- `usage` — what the run cost: `calls` (required, retries included) plus optional `engine`,
  `strategy` and token totals. The cache counts keep a load-bearing distinction: absent means the
  transport did not report it, `0` means calls reported it and none hit.
- `statedEmptyGroups` — per-group verbatim spans where a roster recorded an explicit "none of
  these". Absent for any extractor without a roster.
- `skippedItems` — the phase items a run gave up on under `onItemFailure: "skip"`. Absent means
  the extractor does not report skips; `[]` means it reports and nothing was skipped.

The input is an `AnnotatedTranscript` — one canonical text (the exact string extracted spans are
checked against) plus an open annotations bag. `ExtractionTarget<V, P>` is the slice of a
`ToolAdapter` an extractor needs — `name`, `extractionSchema`, `instructions`, `examples` — with
`write` left out: writing back is a separate concern.

## Errors

An ordinary `extract()` failure — a transport blip, a parse miss — is thrown, not returned: the
queue owns retry and backoff, and arbitration combinators judge outcomes by what a candidate
threw. Two thrown shapes have names a ladder can act on:

- `SchemaParseError` — the response parsed as JSON but violated the schema. Stays retryable, and
  is recognisable, so a strategy ladder can fall through to a different shape.
- `TerminalError` — a deterministic failure (truncation, content filtering, refusal, unsupported).
  Never retried, never delayed.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every `test`
run, ending in assertions on exactly what this page claims — including the defaults quoted under
Options.

<<< @/api/examples/extractor.run.ts

## Related APIs

- [`singleShotExtractor`](/api/single-shot-extractor) — the built strategy over this seam.
- [`groupedExtractor`](/api/grouped-extractor) — the run-owner combinator over per-key groups.
- [Test doubles](/api/test-doubles) — `FakeExtractor`, the fake the example runs on.
- [Choosing and composing transcribers](/api/composing-transcribers) — the sibling seam's
  combinators, for comparison.

## Guides that use it

- [Extraction](/guide/extraction) — the flow this seam sits in the middle of.
- [Quick Start](/guide/quick-start) — swaps the fake for a real strategy on the same contract.

## Reference

- [`Extractor`](/reference/@azx/ribo-core/interfaces/Extractor.html)
- [`ExtractOptions`](/reference/@azx/ribo-core/interfaces/ExtractOptions.html)
- [`ExtractionResult`](/reference/@azx/ribo-core/interfaces/ExtractionResult.html)
- [`ExtractionUsage`](/reference/@azx/ribo-core/interfaces/ExtractionUsage.html)
- [`ExtractionTarget`](/reference/@azx/ribo-core/type-aliases/ExtractionTarget.html)
- [`SkippedItem`](/reference/@azx/ribo-core/type-aliases/SkippedItem.html)
- [`toSessionExtractStep`](/reference/@azx/ribo-core/functions/toSessionExtractStep.html)
- [`FakeExtractor`](/reference/@azx/ribo-core/classes/FakeExtractor.html)
