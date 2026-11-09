# Phased extraction

`phasedExtractor` is the engine that runs a **list of phases** in order: each phase plans its work
items, the engine fans them out through a bounded pool, folds each batch back with the phase's
`merge`, and owns everything that is not "what to ask" — scheduling, per-item retry, cancellation,
the running deadline, the `PhaseUnit` progress stream and the closing trust-boundary parse. A phase
is built with `phaseBuilder` (`plan`/`run`/`merge` over a shared draft), and two caller-owned kinds
ship beside the engine: `askPhase` (one model call against the caller's own schema) and
`computePhase` (a deterministic, model-free fold between passes).

## When to reach for it

Reach for it to write a multi-pass strategy as a list of narrowing steps rather than a bespoke
loop — and to compose caller-owned passes into the same engine the presets run under. Reach for
the [Extraction guide](/guide/extraction) for where the managed strategies sit, and for the
built-in phases: `gapFillPhase` (the second phase of [`gapFillExtractor`](/api/schema-at-scale))
and `batchedFillPhase` (the scoped-instance fill's alternative) are exported exactly so a host can
assemble and extend their phase lists by hand.

## Usage

An ask writes its parsed answer under a caller's note key; a compute folds it into the draft —
the type flows from the schema through the key and the fold with no cast:

<<< @/api/examples/phased-extraction.run.ts#usage

## Options

`phasedExtractor(options)` takes `PhasedExtractorOptions`. The one exported default this page
states is quoted from the example file rather than retyped, and the same file's test run asserts
it against the documented value — `PER_CALL_CEILING_MS`, the default of `perCallCeilingMs`, is
`120_000` — so a source change that moves it fails the `test` stage: The remaining defaults
(`concurrency` 4, `maxRetries` 2, `stepTimeoutMs` 900_000) are not exported constants; they live
in source, so no example asserts them — `packages/ribo-core/src/phases/phased-extractor.ts` is
where they are read from.

<<< @/api/examples/phased-extraction.run.ts#defaults

The remaining defaults (`concurrency` 4, `maxRetries` 2, `stepTimeoutMs` 900_000) are not exported
constants; they live in source, so no example asserts them —
`packages/ribo-core/src/phases/phased-extractor.ts` is where they are read from.

| Name               | Type                     | Default                       | What it does                                                                                                                                   |
| ------------------ | ------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`           | `ExtractionTarget<V, P>` | **required**                  | The field knowledge the whole run is pinned to: the merged draft's fields are normalized and parsed against `extractionSchema`.                |
| `phases`           | `readonly Phase<V, P>[]` | **required**                  | The phases to run, in order. Validated at construction — see `validatePhases`.                                                                 |
| `normalize`        | `(fields) => fields`     | identity                      | The model-free pass, run ONCE after the last merge and before the closing parse — per-phase would run it on partial shapes for no benefit.     |
| `concurrency`      | `number`                 | `4`                           | Max concurrent items per phase — the run-level default a phase inherits when it declares none.                                                 |
| `maxRetries`       | `number`                 | `2`                           | Max retries per item after a transient failure; total attempts is `maxRetries + 1`, capped by the derived budget. A phase may declare its own. |
| `stepTimeoutMs`    | `number`                 | `900_000`                     | The relay's step timeout, used to derive the per-phase retry budget. A caller's own `deadline` can narrow it, never widen it.                  |
| `perCallCeilingMs` | `number`                 | `PER_CALL_CEILING_MS` (above) | Conservative upper bound on ONE item's `run` wall-clock, used to derive the retry budget.                                                      |
| `delay`            | `(ms) => Promise<void>`  | `setTimeout`                  | Injectable sleep between retry attempts, so tests do not wait real seconds.                                                                    |
| `now`              | `() => number`           | `Date.now`                    | Injectable clock in epoch milliseconds.                                                                                                        |
| `baseMs`, `capMs`  | `number`                 | backoff defaults              | The backoff curve the retry sleeps on.                                                                                                         |
| `onUnit`           | observer                 | —                             | `PhaseUnit` events around every item attempt — `phaseId`, `pass`, `attempt`, and the coordinates `describeItem` reported.                      |

For the phases themselves: `phaseBuilder<V, P>()` is curried — `V`/`P` fixed once per strategy,
`I`/`C` inferred per phase — and `PhaseMeta` carries `id` (unique within a list), `requires` (ids
that must appear EARLIER in the same list, checked at construction), `concurrency`,
`onItemFailure` (`"abort"` fails the run; `"skip"` hands the failed outcome to `merge`) and
`maxRetries`. `askPhase` additionally takes the schema, chat, model and a `messages` builder, and
exactly one sink — a `noteKey` (a later phase reads the answer back at `T`) or a `fold`
(both-or-neither is a compile error, and the factory repeats the check at construction). Its
defaults: `id` `"ask"`, no `requires` of its own — the list you pass is the whole list.
`computePhase` takes just the `fold` (plus `id` `"compute"` and `requires`).

## Return value

An `Extractor<Enveloped<V, P>>`. On each `extract`:

1. Run the phases in order; each phase's `plan` reads the draft as the previous `merge` returned
   it; items fan out through the bounded pool at the phase's own concurrency or the run default.
2. Each item's `run` receives the caller's signal combined with the pool's sibling-abort controller
   via `AbortSignal.any` — never one or the other. Retry per item is derived from the phase's share
   of the remaining time.
3. Fold each batch back with that phase's `merge` — it owns every write to the draft.
4. Normalize once on the merged fields, then the trust-boundary parse against the full
   `extractionSchema`; usage is summed from every `PhaseOutput`, and `skippedItems` is always
   present (`[]` means "none skipped").

## Errors

- **A mis-wired list throws at construction** — `validatePhases` rejects an empty list, a
  duplicate id, a `requires` naming a phase that does not appear earlier, a bad concurrency or
  retry count — before the first call is paid for, naming the offending phase.
- **Cancellation is the exception to every failure policy** — a caller cancellation rejects the
  whole run, whatever the phase's `onItemFailure` declares.
- **A schema miss at the closing parse is a `SchemaParseError`** — transient and retryable, never
  terminal: the same request can pass on a re-send.
- **A retry budget that fits no run throws `TerminalError`** when `requireRetryBudget` is set and
  the budget derives to zero even against the full step timeout.

Source: `packages/ribo-core/src/phases/phased-extractor.ts`, `phase.ts`, `ask-phase.ts` and
`compute-phase.ts`.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including
`PER_CALL_CEILING_MS`.

<<< @/api/examples/phased-extraction.run.ts

## Related APIs

- [`gapFillExtractor`](/api/schema-at-scale) and `presenceNarrowedExtractor`
  ([Presence narrowing](/api/presence-narrowing)) — the presets over this engine.
- [`Extractor`](/api/extractor) — the seam, and the options bag `extract` takes.
- [`scriptedChat`](/api/chat-transports) — the double the examples drive the ask phase through.

## Guides that use it

- [Extraction](/guide/extraction) — where the phased strategies sit among the managed ones.

## Reference

- [`phasedExtractor`](/reference/@azx/ribo-core/functions/phasedExtractor.html) ·
  [`PhasedExtractorOptions`](/reference/@azx/ribo-core/interfaces/PhasedExtractorOptions.html)
- [`phaseBuilder`](/reference/@azx/ribo-core/functions/phaseBuilder.html) ·
  [`Phase`](/reference/@azx/ribo-core/type-aliases/Phase.html) ·
  [`PhaseMeta`](/reference/@azx/ribo-core/interfaces/PhaseMeta.html) ·
  [`validatePhases`](/reference/@azx/ribo-core/functions/validatePhases.html)
- [`askPhase`](/reference/@azx/ribo-core/functions/askPhase.html) ·
  [`computePhase`](/reference/@azx/ribo-core/functions/computePhase.html) ·
  [`extractorPhase`](/reference/@azx/ribo-core/functions/extractorPhase.html)
- [`gapFillPhase`](/reference/@azx/ribo-core/functions/gapFillPhase.html) ·
  [`batchedFillPhase`](/reference/@azx/ribo-core/functions/batchedFillPhase.html)
