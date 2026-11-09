# fallbackExtractor and the arbitration wrappers

`fallbackExtractor(candidates, arbiter)` tries extraction strategies in order and lets a
caller-supplied arbiter decide — after each settles — whether to accept the outcome, try the next
strategy, or give up. `raceExtractor` starts every strategy at once. `terminalFallsThrough` and
`acceptAnySuccess` are the shipped arbiters, and `ExtractionArbiter` is the vocabulary. The
remaining wrappers — retry, timeout, hedge, consensus, cache, budget — sit beside them as one
family over the same [`Extractor`](/api/extractor) seam.

## When to reach for it

Reach for this page to look up the ladder's shape, the arbiter's verdicts, and which wrapper does
what. Reach for the [Arbitration & Fallback guide](/guide/arbitration) for the reasoning — what an
arbiter may and may not see, and why concurrency is opt-in by name.

**Duplicate spellings, stated once:** `fallbackExtractor` / `raceExtractor` are the public
combinators; `createSequentialExtractor` / `createConcurrentExtractor` (`arbitration.ts`) are the
shared engine constructors behind them — `compositeExtractor` builds on the sequential engine
directly, and the guides use the public names. Both spellings exist in the API; pick the public
one.

## Usage

The example's strategies are inline extractors and fakes — no model, no credentials:

<<< @/api/examples/fallback-extractor.run.ts#usage

## Options

`fallbackExtractor(candidates, arbiter)` and `raceExtractor(candidates, arbiter)` take a candidate
list (`{ strategy, extractor }`) and an `ExtractionArbiter` — no scheduling options, no
capability vocabulary. There are no numeric defaults to quote for the ladder itself; the wrapper
defaults the page states are quoted from the example file rather than retyped, and the same
file's test run observes them — so a source change that moves one fails the `test` stage:

<<< @/api/examples/fallback-extractor.run.ts#defaults

| Name            | Wrapper                              | Type                    | Default                              | What it does                                                                                                                                                                                                |
| --------------- | ------------------------------------ | ----------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arbiter`       | `fallbackExtractor`, `raceExtractor` | `ExtractionArbiter<F>`  | **required**                         | The policy: accept / continue / give up, called with every settled outcome so far and an `exhausted` flag. Policy lives in the caller; the engine owns iteration and stamping.                              |
| `maxRetries`    | `retryExtractor`                     | `number`                | `2` (above, observed)                | Retries after a transient failure — total attempts is `maxRetries + 1`. Terminal failures and cancellations are never retried.                                                                              |
| `delay`         | `retryExtractor`                     | `(ms) => Promise<void>` | `setTimeout`-backed sleep            | Injectable sleep between attempts, taking the already-computed `fullJitterDelay` result.                                                                                                                    |
| `timeoutMs`     | `timeoutExtractor`                   | `number`                | **required**                         | Bounds one extractor to a deadline, aborting the inner extractor's signal — a hung inner cannot hang the run.                                                                                               |
| `delay`         | `hedgedExtractor`                    | `HedgeDelay`            | **required** — core ships no default | When to fire the hedge. Core has no model of how long an extraction takes; a required option with no default is the honest encoding of that.                                                                |
| `onHedge`       | `hedgedExtractor`                    | `(event) => void`       | —                                    | Fired at settlement with the winner — this count, not `usage`, is the measure of what hedging costs.                                                                                                        |
| `candidates`    | `consensusExtractor`                 | `Extractor[]`           | **required**                         | Every candidate runs to settlement; the survivors are compared leaf by leaf and disagreements are nulled, citations kept. Costs N times a single extraction — choosing candidates IS choosing a multiplier. |
| `store`         | `cachedExtractor`                    | `ExtractionCache`       | in-memory `Map`                      | Memoisation over the transcript plus the WHOLE target (instructions and examples are prompt). Failures are never cached; a hit reports `calls: 0`. Injected — `PluginStorage` is the wrong lifetime.        |
| `maxCalls` etc. | `budgetExtractor`                    | `number`                | —                                    | The spend-ceiling detector. It detects, it cannot prevent — and it is honest around one strategy, misleading around a ladder: put it INSIDE a ladder, around each rung.                                     |

Defaults are read from `packages/ribo-core/src/async/retry-async.ts`,
`packages/ribo-core/src/extraction/hedged-extractor.ts`, `cached-extractor.ts` and
`budget-extractor.ts`.

## Return value

Every combinator returns a plain `Extractor<F>` — drop-in composable. The accepted result is
returned whole, with `usage.strategy` stamped to the winning strategy id (`fallbackExtractor` and
`raceExtractor` only; `hedgedExtractor` has no ids to stamp, and the loser's usage is not added).

The arbiter's verdicts:

- `{ accept: result }` — must be a result some candidate produced; the engine validates this and
  throws `TypeError` naming the arbiter otherwise, rather than crashing on a missing `.usage`.
- `{ continue: true }` — try the next candidate; illegal once every candidate has settled (also a
  `TypeError`, naming the arbiter).
- `{ giveUp: error }` — the error is thrown unchanged, so the relay classifies it as it always
  did.

The shipped arbiters:

- **`terminalFallsThrough`** — the conservative default: accept the first success; continue on a
  terminal error (structural — a different strategy might fix it) or a schema-parse miss; give up
  on a transient one (the next strategy shares the down transport).
- **`acceptAnySuccess`** — the degraded-experience policy: accept the first success, continue past
  any failure until exhaustion.

## Errors

- Empty candidate lists and duplicate strategy ids throw `TypeError` at construction.
- **`SchemaParseError`** — retryable but recognisable. It is _sampled_, not deterministic (the
  same request can pass zod on re-send), so `isTransientFailure` classifies it as retryable and
  the queue keeps trying; the ladder falls through to the next strategy instead of burning the
  same request shape again. Carrying the failed `output` lets a self-correction loop show it back
  to the model as its own previous answer.
- A ladder whose candidates all fail zod gives up at exhaustion with the first parse error — the
  exhaustion check is ordered before the schema-parse fall-through deliberately, so the failure
  names the parse and not a `TypeError` about continuing at exhaustion.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including the wrapper
defaults quoted under Options.

<<< @/api/examples/fallback-extractor.run.ts

## Related APIs

- [`Extractor`](/api/extractor) — the seam every strategy and wrapper implements.
- [`groupedExtractor`](/api/grouped-extractor) — the run-owner combinator over per-key groups,
  with retry of its own derived budget.
- [Test doubles](/api/test-doubles) — the fakes a ladder is driven with.

## Guides that use it

- [Arbitration & Fallback](/guide/arbitration) — the ladder, the arbiter, and the race.
- [Extraction](/guide/extraction) — the single-strategy seam these compose.

## Reference

- [`fallbackExtractor`](/reference/@azx/ribo-core/functions/fallbackExtractor.html) ·
  [`raceExtractor`](/reference/@azx/ribo-core/functions/raceExtractor.html)
- [`terminalFallsThrough`](/reference/@azx/ribo-core/functions/terminalFallsThrough.html) ·
  [`acceptAnySuccess`](/reference/@azx/ribo-core/functions/acceptAnySuccess.html)
- [`ExtractionArbiter`](/reference/@azx/ribo-core/type-aliases/ExtractionArbiter.html) ·
  [`ArbiterVerdict`](/reference/@azx/ribo-core/type-aliases/ArbiterVerdict.html) ·
  [`ExtractionOutcome`](/reference/@azx/ribo-core/type-aliases/ExtractionOutcome.html)
- [`retryExtractor`](/reference/@azx/ribo-core/functions/retryExtractor.html) ·
  [`timeoutExtractor`](/reference/@azx/ribo-core/functions/timeoutExtractor.html) ·
  [`hedgedExtractor`](/reference/@azx/ribo-core/functions/hedgedExtractor.html)
- [`consensusExtractor`](/reference/@azx/ribo-core/functions/consensusExtractor.html) ·
  [`cachedExtractor`](/reference/@azx/ribo-core/functions/cachedExtractor.html) ·
  [`budgetExtractor`](/reference/@azx/ribo-core/functions/budgetExtractor.html) ·
  [`compositeExtractor`](/reference/@azx/ribo-core/functions/compositeExtractor.html)
- [`createSequentialExtractor`](/reference/@azx/ribo-core/functions/createSequentialExtractor.html) ·
  [`createConcurrentExtractor`](/reference/@azx/ribo-core/functions/createConcurrentExtractor.html)
- [`SchemaParseError`](/reference/@azx/ribo-core/classes/SchemaParseError.html)
