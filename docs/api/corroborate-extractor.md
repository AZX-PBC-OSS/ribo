# corroborateExtractor

`corroborateExtractor` is the second judging combinator: it wraps any
[`Extractor`](/api/extractor), extends core's grounding census with a System One verdict per
committed leaf, hands the tally to a caller-supplied policy, and either returns the result
**untouched, by identity** or throws `CorroborationRejectedError` — terminal, so an arbitration
ladder falls through to the next rung and the human never sees an uncorroborated draft. This page
is opt-in wiring — no guide walks through it.

## When to reach for it

Reach for it when a rung's results should be judged on whether the transcript corroborates what
they committed to, before anyone sees them. Reach for ADR 0021 for the measurements that decided
the shape: per-leaf scores land on both sides of any threshold (identical mappings scored 0.38
and 0.65 for the same phrase), so the policy thresholds a **ratio, never a leaf**, and a judgement
rung that reached a reviewer would spend the review on drafts a measurement could refuse.

## Usage

The inner extractor is a fake and the System One client is a hand-built double — the whole example
runs with no credentials and no network:

<<< @/api/examples/corroborate-extractor.run.ts#usage

## Options

`corroborateExtractor(extractor, options)` takes `CorroborateExtractorOptions`.

| Name        | Type                     | Default      | What it does                                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`    | `ExtractionTarget<V, P>` | **required** | The field knowledge the inner extractor was built against. Only `extractionSchema` is read, ONCE at construction: `assertLeafGranularity` refuses a `"row"` or `"none"` group before any call, because this combinator walks per-leaf envelopes and would otherwise count nothing while returning a result that looks judged. |
| `client`    | `SystemOneClient`        | **required** | The System One client to ask — the host's proxied, credential-attaching one. The combinator itself has no capacity to authenticate.                                                                                                                                                                                           |
| `policy`    | `CorroborationPolicy`    | **required** | The synchronous decision the census is handed. Required, with no default: choosing a policy AND its ratio are imports, not flags — a wrong default fails silently in both directions.                                                                                                                                         |
| `batchSize` | `number`                 | one call     | The most corroboration questions one `ask` call carries. Unset means one call — the client batches internally anyway.                                                                                                                                                                                                         |

None of these defaults is an exported constant; they live in
`packages/ribo-extractor-systemone/src/corroborate-extractor.ts`, so no example asserts them.

## Return value

An `Extractor<F>` — the same seam, same `F`. On each `extract` the inner extractor runs first (the
caller's options forwarded whole); core's `groundingCensus` is taken over the result's fields and
its `statedEmptyGroups` on the transcript's text; `corroborationCensus` extends it with one
`choice` verdict per committed leaf; the policy decides. A passing result is returned untouched,
by identity — the combinator judges, it does not transform.

The shipped policy, `rejectUncorroboratedCommitments(ratio)`, rejects when the share of COMMITTED
leaves whose verdict is anything other than `"supports"` exceeds the ratio — `contradicts` and
`says_nothing` both count, and a leaf still carrying a null verdict does not. The ratio is a
required argument with no default: nothing measured justifies a number, and a wrong default fails
silently in both directions. The rejection's message names the uncorroborated count and the
ratio; the error carries the census, so a log reader can re-derive the decision.

## Errors

- **`CorroborationRejectedError`** — the policy rejected. It extends `TerminalError`
  DELIBERATELY: under the shipped default arbiter a terminal rejection makes a ladder fall
  through to the next rung, while a transient rejection would make the relay re-run the whole
  extract step — including the rung that just failed corroboration — on backoff, until `dead`.
- **An inner failure propagates unchanged** — no try/catch, so a transient inner failure stays
  transient (an arbiter gives up rather than trying the next rung on the same downed transport)
  and a cancellation stays a cancellation.
- **A `"row"` or `"none"` granularity target throws at construction** — before any call is paid
  for, naming the combinator and the offending group.
- **No observer, for now** — ADR 0021 records whether the verification calls should report
  progress units as an open question it does not settle; none are emitted.

Source: `packages/ribo-extractor-systemone/src/corroborate-extractor.ts`; the pure census it
extends is core's (see [Provenance](/api/provenance)).

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including the fall-through.

<<< @/api/examples/corroborate-extractor.run.ts

## Related APIs

- [`fallbackExtractor`](/api/fallback-extractor) — the ladders a terminal rejection falls through.
- [Provenance](/api/provenance) — `groundingCensus`, the pure half the verdicts extend.
- [Presence narrowing](/api/presence-narrowing) — the other opt-in combinator a rung can carry.

## Guides that use it

None — this page is opt-in wiring, and no guide walks through it.
[Arbitration & Fallback](/guide/arbitration) is where judging combinators sit in a ladder.

## Reference

- [`corroborateExtractor`](/reference/@azx/ribo-extractor-systemone/functions/corroborateExtractor.html) ·
  [`CorroborateExtractorOptions`](/reference/@azx/ribo-extractor-systemone/interfaces/CorroborateExtractorOptions.html)
- [`CorroborationRejectedError`](/reference/@azx/ribo-extractor-systemone/classes/CorroborationRejectedError.html) ·
  [`rejectUncorroboratedCommitments`](/reference/@azx/ribo-extractor-systemone/functions/rejectUncorroboratedCommitments.html) ·
  [`CorroborationPolicy`](/reference/@azx/ribo-extractor-systemone/type-aliases/CorroborationPolicy.html)
