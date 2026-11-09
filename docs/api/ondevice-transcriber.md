# OnDeviceTranscriber

Whisper-family speech-to-text **on the device**, via `@huggingface/transformers` running in a Web
Worker. Implements the [`Transcriber`](/api/transcriber) seam, so it is substitutable for
`FakeTranscriber` and composes through `firstCapable` with no queue changes. There is **no**
background download: `prime()` fetches and caches the model only when the user asks — a
hundreds-of-MB fetch over cellular data is a decision the product makes deliberately.

## When to reach for it

Reach for it when a device passes the speed gate and you want transcription that works offline.
Reach for the [Captures & Sources guide](/guide/captures-and-sources) for how it composes with
the managed engine into one roster. Its sibling pages: [`ManagedTranscriber`](/api/managed-transcriber)
(the fallback for devices that fail the gate), [`PdfjsTranscriber`](/api/pdfjs-transcriber) and
[`ManagedDocsTranscriber`](/api/managed-docs-transcriber) (documents).

## Usage

The engine never loads a model in this example — `capability()` answers from the environment
(Cache API, a stored speed verdict) and is cheap enough to call on every queue drain. In node
there is no Cache Storage, so the probe reports the platform itself as unsupported; the example
also drives the probe against an injected `CacheStorage` double:

<<< @/api/examples/ondevice-transcriber.run.ts#usage

## Options

`new OnDeviceTranscriber(options)` takes `OnDeviceTranscriberOptions`. **`wasmPaths` is required
on purpose**: a published library cannot ship the ONNX Runtime `.wasm`/`.mjs` files into an
arbitrary consumer's bundler, and the transformers.js default points them at a CDN — which breaks
the offline guarantee and trips strict host CSPs. There is no hidden fallback to paper over a
missing config.

The defaults the page states are quoted from the example file rather than retyped, and the same
file's test run asserts every one of them against the exported constants — so a source change
that moves one fails the `test` stage:

<<< @/api/examples/ondevice-transcriber.run.ts#defaults

| Name              | Type                 | Default                             | What it does                                                                                                                                                                                                         |
| ----------------- | -------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wasmPaths`       | `string`             | **required**                        | Same-origin base URL the ORT runtime files are served from, e.g. `"/ort/"`.                                                                                                                                          |
| `createWorker`    | `() => Worker`       | best-effort default (see below)     | Factory that constructs the inference worker. The supported path — see Wiring the worker. Omitted, a default is used that throws an actionable error naming this option.                                             |
| `modelId`         | `string`             | `DEFAULT_MODEL_ID` (above)          | HuggingFace repo id of the ASR model. Moonshine, not Whisper, since the live-transcription work — chosen on latency; it costs domain-jargon priming, which Moonshine cannot be primed with.                          |
| `device`          | `"webgpu" \| "wasm"` | transformers.js auto-selects        | ORT execution provider.                                                                                                                                                                                              |
| `dtype`           | `OnnxDtype`          | transformers.js default             | Weight quantization passed through to the pipeline.                                                                                                                                                                  |
| `revision`        | `string`             | transformers.js's `"main"`          | Hub revision to fetch the model at. Pin a commit hash wherever an upstream push must not silently change what downloads and runs.                                                                                    |
| `hints`           | `TranscribeHints`    | — (unbiased decoding)               | Domain-jargon priming applied to every transcription this instance runs. **Whisper-only** — supplied for a model without a trained prior-context token, construction throws; a silently ignored hint would be worse. |
| `downloadBytes`   | `number`             | `estimateDownloadBytes(modelId)`    | Override the figure the consent screen shows.                                                                                                                                                                        |
| `cacheStorage`    | `CacheStorage`       | `globalThis.caches`                 | The "is it cached?" probe reads this. Injectable so the logic is unit-testable in node.                                                                                                                              |
| `rtfThreshold`    | `number`             | `DEFAULT_RTF_THRESHOLD` (above)     | Measured real-time factor above which `capability()` reports `too-slow` — a permanent demotion, so set it to tolerate slower devices or route to the managed engine sooner.                                          |
| `workerTimeoutMs` | `number`             | `DEFAULT_WORKER_TIMEOUT_MS` (above) | Budget for a worker reply. A worker killed out of memory never fires `error`; without this the relay's serial drain is stranded forever. Generous by default — it covers a cold load plus a multi-minute recording.  |
| `now`             | `() => number`       | `performance.now`                   | Wall-clock source for the RTF calibration timer.                                                                                                                                                                     |

Options are read from `packages/ribo-transcriber-ondevice/src/config.ts` (the options interface
and the model registry) and `src/index.ts` (the class).

## Return value

- `capability()` — the [`Transcriber`](/api/transcriber) probe: `ready` when the ASR weights are
  cached, `needs-download` carrying the byte estimate (**weights plus the ORT runtime plus the
  voice-activity model** — the runtime is the addend routinely forgotten), `unavailable` with
  `unsupported-platform` (no Cache Storage, no WebGPU adapter when requested) or `too-slow` (a
  stored speed verdict above the threshold, which outranks the cache check).
- `prime(onProgress?)` — download and cache the model with per-file progress; runs one
  calibration inference afterwards and persists the measured real-time factor. Safe to call
  again: a warm cache re-reads, and `onProgress` then sees no byte events.
- `transcribe(recording, audio, options?)` — `Blob` in, `Transcript` out, stamped with the
  **derived** engine id (`ondevice:<model>:<device>:<dtype>` — one operating point, named; two
  rosters of two configurations must not collide). The caller's `signal` is honoured at three
  points, and a cancellation rejects with `TerminalError` without touching any live session.
- `measuredRtf()` — the stored real-time factor for this instance's operating point, `undefined`
  before calibration.
- `dispose()` — terminate the worker. The next `prime()` constructs a fresh one.

## Errors

- A missing cache, an absent GPU adapter or a too-slow verdict is **not** an error — it is a
  `capability()` answer, re-probed by the composition layer.
- A `TranscriberUnavailableError` from `transcribe` means the cached capability was wrong; the
  queue demotes the engine and the next attempt routes elsewhere.
- A cancelled transcription rejects with `TerminalError` — the caller withdrew the work, and the
  queue must not spend its retry budget re-running it.
- Supplying `hints` for a model that cannot be primed throws at **construction**, before any
  network — a prefix applied to a model without the control token replaces the transcript with
  the echoed jargon instead of biasing it.

## Wiring the worker

Type-checked only — the module exists to run inside a Web Worker (it imports the ORT runtime and
the pipeline), so the wiring is compiled but never executed here.

The host owns worker construction, in its **own bundler context**: the app's worker entry imports
`handleMessage` from the `@azx/ribo-transcriber-ondevice/worker` subpath, and the host hands a
factory for its own entry to the transcriber. Library code never constructs a `Worker` (a
bundler-specific import 404s in a consumer's production build).

<<< @/api/examples/ondevice-worker.ts

The protocol types the two ends share — `TranscribeWorkerRequest` among them — are re-exported
from the barrel, so a change to the wire shape is a compile error on both sides.

## Model download

Type-checked only — `isModelCached` reads the Cache API, a browser-only global.

<<< @/api/examples/ondevice-model-cache.ts

`estimateDownloadBytes(modelId, includeVad?)` is pure and runs in node: it is the byte estimate
`capability()` reports, counting the ONNX Runtime binary and the voice-activity model alongside
the weights. The runnable example on this page asserts its figures.

## Full example

Runs in CI. Every exported function below is executed by the Vitest `unit` project on every
`test` run, ending in assertions on exactly what this page claims — including the defaults quoted
under Options.

<<< @/api/examples/ondevice-transcriber.run.ts

## Related APIs

- [`Transcriber`](/api/transcriber) — the seam this class implements.
- [`firstCapable`](/api/composing-transcribers) — how on-device and managed engines compose into
  one roster.
- [`OnDeviceLiveTranscriber`](/api/live-transcription) — the utterance-level seam over the same
  worker.
- [`estimateDownloadBytes`](/reference/@azx/ribo-transcriber-ondevice/functions/estimateDownloadBytes.html)
  and [`isModelCached`](/reference/@azx/ribo-transcriber-ondevice/functions/isModelCached.html) —
  the consent-screen arithmetic and the cache probe.

## Guides that use it

- [Captures & Sources](/guide/captures-and-sources) — where the on-device engine sits in the
  engine roster and what primes it.

## Reference

- [`OnDeviceTranscriber`](/reference/@azx/ribo-transcriber-ondevice/classes/OnDeviceTranscriber.html)
- [`OnDeviceTranscriberOptions`](/reference/@azx/ribo-transcriber-ondevice/interfaces/OnDeviceTranscriberOptions.html)
- [`TranscribeHints`](/reference/@azx/ribo-transcriber-ondevice/interfaces/TranscribeHints.html)
- [`estimateDownloadBytes`](/reference/@azx/ribo-transcriber-ondevice/functions/estimateDownloadBytes.html)
- [`isModelCached`](/reference/@azx/ribo-transcriber-ondevice/functions/isModelCached.html)
- [`handleMessage`](/reference/@azx/ribo-transcriber-ondevice/worker/functions/handleMessage.html) —
  the `./worker` subpath entry
- [`TranscribeWorkerRequest`](/reference/@azx/ribo-transcriber-ondevice/interfaces/TranscribeWorkerRequest.html)
