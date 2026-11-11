# Choosing and composing transcribers

Four combinators build many engines into one [`Transcriber`](/api/transcriber):
`firstCapable` (sequential selection on capability), `fallbackTranscriber` (sequential, with an
arbiter judging outcomes), `raceTranscriber` (every capable engine at once), and `hedgedTranscriber` (a
preferred engine raced against a fallback on a latency budget). All four return composites that
are drop-in interchangeable, and all four are privacy-preserving by default: a deployment that
will not let audio leave the device simply never composes a managed engine.

## When to reach for it

Reach for this page when wiring an engine roster — which combinator, and with which policy.
Reach for the [Captures & Sources guide](/guide/captures-and-sources) for the roster the guide
recommends and why fallback is narrower than it looks.

**Which one when** — the four are siblings, not variants:

- **`firstCapable`** — the default. Strictly sequential: pick the first engine whose
  `capability()` is `ready`, run it to completion. Selection is engine-level; it cannot express
  "this engine cannot read _this item_".
- **`fallbackTranscriber`** — when per-item routing matters: it never consults `capability()`
  for selection and lets a caller-supplied arbiter decide from the settled outcomes. A reader
  who thinks of it as "`firstCapable` with retries" will wire it wrongly.
- **`raceTranscriber`** — when latency beats cost: every capable engine is dispatched at once,
  and a race that includes a managed engine uploads the audio every time. That is the cost
  `firstCapable` exists to avoid.
- **`hedgedTranscriber`** — when the primary is usually fast but occasionally stalls: start the primary;
  fire the hedge only if the predicted budget lapses.

## Usage

Every engine below is a `FakeTranscriber`, so the whole example runs with no credentials and no
network. `firstCapable` takes the first engine that is **ready** — `needs-download` is never
selected, because a background queue drain can obtain neither the network nor the consent that
fetch needs:

<<< @/api/examples/composing-transcribers.run.ts#usage

## Options

`firstCapable(transcribers, options?)` takes `FirstCapableOptions`; `hedgedTranscriber(primary, hedge,
options)` takes `HedgedTranscriberOptions` plus a delay policy built by `hedgeDelay`. The defaults the page
states are quoted from the example file rather than retyped, and the same file's test run asserts
every one of them against the exported constants — so a source change that moves one fails the
`test` stage:

<<< @/api/examples/composing-transcribers.run.ts#defaults

| Name         | Combinator                                             | Type                                   | Default                             | What it does                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------ | -------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine`     | all four                                               | `string`                               | the combinator's own name           | `Transcriber.engine` for the composite (`"first-capable"`, `"fallback"`, `"race"`, `"hedged"`). The delegates keep their own ids — a transcript is stamped by the implementation that ran, never by the wrapper. |
| `ttlMs`      | `firstCapable`, `hedgedTranscriber`, `raceTranscriber` | `number`                               | `DEFAULT_CAPABILITY_TTL_MS` (above) | How long a capability answer is reused before re-probing. A backstop, not the mechanism — call `invalidate()` when a download finishes or the uplink returns.                                                    |
| `onFallback` | `firstCapable`                                         | `(event: TranscriberFallback) => void` | —                                   | Called whenever a preferred engine was skipped. Quiet on the happy path; loud on exactly the failure that is otherwise invisible.                                                                                |
| `delay`      | `hedgedTranscriber`                                    | `HedgeDelayPolicy`                     | **required**                        | When to fire the hedge, as a function of the recording. Build it with `hedgeDelay` or supply your own.                                                                                                           |
| `factor`     | `hedgeDelay`                                           | `number`                               | `DEFAULT_HEDGE_FACTOR` (above)      | Scale on the predicted duration — the primary gets a margin before the hedge fires.                                                                                                                              |
| `floorMs`    | `hedgeDelay`                                           | `number`                               | `DEFAULT_HEDGE_FLOOR_MS` (above)    | Minimum delay, however small the prediction.                                                                                                                                                                     |
| `budgetMs`   | `hedgeDelay`                                           | `number`                               | `DEFAULT_HEDGE_BUDGET_MS` (above)   | The ceiling — the auditor's tolerance. The prediction only pulls the hedge **earlier** on fast devices; the slower the device, the later the help would be without this clamp.                                   |
| `arbiter`    | `fallbackTranscriber`, `raceTranscriber`               | `TranscriptionArbiter`                 | `unsupportedFallsThrough` (race)    | The policy that decides accept / continue / give up from settled outcomes. Required on `fallbackTranscriber`, so the policy is chosen by name rather than inherited by omission.                                 |

Defaults are read from `packages/ribo-core/src/transcription/hedged-transcriber.ts`,
`first-capable.ts`, `fallback-transcriber.ts`, `race-transcriber.ts` and `restrict-to-kind.ts`.

## Return value

`firstCapable`, `hedgedTranscriber` and `raceTranscriber` return a `CompositeTranscriber` — a `Transcriber`
plus `capabilities()` (every delegate's current answer, in preference order — the roster a
download screen renders from) and `invalidate(engine?)` (drop cached capabilities; this is how
"the model finished downloading" is announced).

`fallbackTranscriber` returns a plain `Transcriber`: nothing is stamped onto the result, and
"which one did?" is answerable off `Transcript.engine` for free.

`restrictToKind(kind, transcriber)` lifts a narrow engine into a `Transcriber<CapturePayload>`
slot, refusing other kinds with `UnsupportedItemError` and delegating the matching kind with the
caller's options forwarded whole. It changes no engine; the compiler is what sends a host here.

## Errors

- An empty roster or a duplicate engine id throws `TypeError` at construction — the capability
  cache is keyed by engine id, so duplicates would demote each other.
- An ordinary error from the selected engine **propagates untouched** (`firstCapable` rule 5):
  an attempt failure is the queue's business, and falling through on it would let one OOMed clip
  permanently demote a device to the cloud.
- When every lane is gated out or every verdict is permanent, the failure is `TerminalError`;
  otherwise a retryable `TranscriberUnavailableError`.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including the defaults quoted
under Options.

<<< @/api/examples/composing-transcribers.run.ts

## Related APIs

- [`Transcriber`](/api/transcriber) — the seam all four compose, and the three kinds of failure
  the selection rules are built around.
- [`OnDeviceTranscriber`](/api/ondevice-transcriber) and
  [`ManagedTranscriber`](/api/managed-transcriber) — the audio engines being composed.
- [`ManagedDocsTranscriber`](/api/managed-docs-transcriber) and
  [`PdfjsTranscriber`](/api/pdfjs-transcriber) — the document ladder.

## Guides that use it

- [Captures & Sources](/guide/captures-and-sources) — the roster the guide recommends, and why
  fallback rescues the online path only.
- [Arbitration & Fallback](/guide/arbitration) — the arbiter vocabulary `fallbackTranscriber` and
  `raceTranscriber` speak.

## Reference

- [`firstCapable`](/reference/@azx/ribo-core/functions/firstCapable.html)
- [`fallbackTranscriber`](/reference/@azx/ribo-core/functions/fallbackTranscriber.html)
- [`raceTranscriber`](/reference/@azx/ribo-core/functions/raceTranscriber.html)
- [`hedgedTranscriber`](/reference/@azx/ribo-core/functions/hedgedTranscriber.html) ·
  [`hedgeDelay`](/reference/@azx/ribo-core/functions/hedgeDelay.html)
- [`restrictToKind`](/reference/@azx/ribo-core/functions/restrictToKind.html)
- [`CompositeTranscriber`](/reference/@azx/ribo-core/interfaces/CompositeTranscriber.html)
- [`unsupportedFallsThrough`](/reference/@azx/ribo-core/functions/unsupportedFallsThrough.html)
