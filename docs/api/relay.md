# createRelay

`createRelay(options)` builds the foreground queue that turns captured audio into written-back
fields: it drains recordings (transcribe) and sessions (extract, write) one at a time, lowest
sequence first, retrying transient failures with jittered backoff and marking terminal ones
`dead`. `Relay`, `RelayOptions`, `RelaySubject`, the `SessionExtractStep` / `SessionWriteStep`
seams and their input/result types live here.

## When to reach for it

Reach for this page to look up the drain's options and the two step seams. Reach for
[Offline & Storage](/guide/offline-and-storage) for the durability model — the two state machines,
crash resume, cross-tab locks — and [Write-back](/guide/write-back) for the write step's trust
boundary. Hosts do not call extractors or transcribers directly; the relay owns every attempt.

## Usage

The example runs the whole pipeline over a memory backend. One honest note before reading it: the
relay falls back to the browser's Web Locks API for cross-tab exclusion, which this node runner
does not have — so the example **injects a lock manager** (`locks`), exactly as a host injects
nothing in a browser.

<<< @/api/examples/relay.run.ts#usage

## Options

`createRelay(options)` takes `RelayOptions`. The backoff defaults the page states are quoted from
the example file rather than retyped, and the same file's test run asserts them against the
exported constants — so a source change that moves one fails the `test` stage:

<<< @/api/examples/relay.run.ts#defaults

| Name                          | Type                          | Default                                                      | What it does                                                                                                                                                            |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`                     | `Storage`                     | **required**                                                 | The [storage](/api/open-storage) the queue drains.                                                                                                                      |
| `transcriber`                 | `Transcriber<CapturePayload>` | **required**                                                 | The engine draining recordings. Widened to the union; wrap a narrow engine with `restrictToKind("audio", …)`.                                                           |
| `sessionExtract`              | `SessionExtractStep`          | **required**                                                 | Joined transcripts → structured fields. `toSessionExtractStep` collapses any [`Extractor`](/api/extractor) onto it.                                                     |
| `sessionWrite`                | `SessionWriteStep`            | **required**                                                 | Reviewed fields → host tool. [`toWriteStep`](/api/tool-adapter) collapses any `ToolAdapter` onto it.                                                                    |
| `combineTranscripts`          | `TranscriptCombiner`          | `createDefaultTranscriptCombiner()` (no markers)             | How per-capture transcripts join into one; the relay supplies the array, the combiner decides the join.                                                                 |
| `locks`                       | `LockManager`                 | `navigator.locks` (browser)                                  | Cross-tab exclusion per item — exclusion only, never write authorization. Inject a double in node. Read from `packages/ribo-core/src/storage/relay.ts` around line 444. |
| `now`                         | `() => number`                | `Date.now` (relay.ts:381)                                    | The clock for eligibility checks and backoff scheduling.                                                                                                                |
| `maxAttempts`                 | `number`                      | `8` (relay.ts:383)                                           | Attempts before an item goes `dead`. Not exported; not asserted here.                                                                                                   |
| `stepTimeoutMs`               | `number`                      | `900_000` (relay.ts:257)                                     | The deadline per step. When it fires, the step's in-flight work is aborted, not just abandoned. Not exported; not asserted here.                                        |
| `isTransient`                 | `(error) => boolean`          | `isTransientFailure`                                         | The transient/terminal classifier a failure is parked by.                                                                                                               |
| `dropAudioAfterTranscription` | `boolean`                     | —                                                            | Drop the audio attachment once its transcript is written.                                                                                                               |
| `onError`                     | `(error, RelaySubject)`       | —                                                            | Handed a tagged union — `kind: "recording"` or `"session"` — at every failure; nothing is persisted at the callback boundary.                                           |
| `baseMs`, `capMs`             | `number`                      | `DEFAULT_BACKOFF_BASE_MS` / `DEFAULT_BACKOFF_CAP_MS` (above) | The full-jitter window transient failures park on.                                                                                                                      |

Defaults are read from `packages/ribo-core/src/storage/relay.ts` and
`packages/ribo-core/src/storage/backoff.ts`.

## Return value

`createRelay` returns a `Relay`:

- `syncNow()` — one drain pass, serialised behind any running one.
- `start(connectivity?)` — begin watching a [`Connectivity`](/api/connectivity) source (drains on
  the edge into `online`, never on the raw browser event) and drain once.
- `stop()` — unbind and stop watching.
- `settled()` — resolves when every in-flight drain has finished.

There is no background drain and no timer: iOS Safari has no Background Sync, so retry
eligibility is persisted (`nextAttemptAt`) rather than scheduled, and a drain compares
timestamps.

## Errors

The relay never throws out of a drain — failures are classified per item:

- A **transient** failure parks the item in `failed` with `attempts` bumped and `nextAttemptAt`
  drawn from the jitter window; the queue picks it up again on a later drain.
- A **terminal** failure (`TerminalError`, a 4xx, attempts exhausted) marks the item `dead` — a
  resting state a human looks at, never silently repaired.
- Every failure first goes to `onError` with the item it belonged to.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including the backoff
defaults quoted under Options.

<<< @/api/examples/relay.run.ts

## Related APIs

- [`openStorage`](/api/open-storage) — the storage the relay drains, and the memory backend the
  example runs on.
- [`ToolAdapter`](/api/tool-adapter) — the write step's adapter side, and the receipt a retry
  UPDATEs.
- [`createConnectivity`](/api/connectivity) — the source `start()` watches.
- [`Extractor`](/api/extractor) — the seam `toSessionExtractStep` wires in.

## Guides that use it

- [Offline & Storage](/guide/offline-and-storage) — the durability model the relay implements.
- [Write-back](/guide/write-back) — the write step this relay calls.

## Reference

- [`createRelay`](/reference/@azx/ribo-core/functions/createRelay.html)
- [`Relay`](/reference/@azx/ribo-core/interfaces/Relay.html) ·
  [`RelayOptions`](/reference/@azx/ribo-core/interfaces/RelayOptions.html) ·
  [`RelaySubject`](/reference/@azx/ribo-core/type-aliases/RelaySubject.html)
- [`SessionExtractStep`](/reference/@azx/ribo-core/type-aliases/SessionExtractStep.html) ·
  [`SessionWriteStep`](/reference/@azx/ribo-core/type-aliases/SessionWriteStep.html) ·
  [`SessionWriteInput`](/reference/@azx/ribo-core/interfaces/SessionWriteInput.html) ·
  [`ExtractStepResult`](/reference/@azx/ribo-core/interfaces/ExtractStepResult.html)
- [`TerminalError`](/reference/@azx/ribo-core/classes/TerminalError.html) ·
  [`isTransientFailure`](/reference/@azx/ribo-core/functions/isTransientFailure.html)
