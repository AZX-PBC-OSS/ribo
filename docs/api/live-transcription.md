# Live transcription

Utterance-level preview **while recording**: feed audio frames in from an audio callback and get
transcribed text back as each pause closes. The seam is `LiveTranscriber` in `ribo-core` —
`liveCapability()`, separate from the batch probe because live additionally needs a streaming
voice-activity model — implemented on the device by `OnDeviceLiveTranscriber` over the same
worker that runs batch inference. The governing failure rule is "live must never degrade
recording": no preview is a nicety lost, never a capture risked.

## When to reach for it

Reach for the seam when a host wants a dictation preview on the record screen. There is no guide
for live transcription — this page is the only prose on it, and it closes the Captures & Sources
cluster. The batch seam it sits beside is [`Transcriber`](/api/transcriber); the engines that
implement it are [`OnDeviceTranscriber`](/api/ondevice-transcriber) and its siblings.

## Usage

Type-checked only — a live session runs inference in a Web Worker and is fed from an audio
callback, so this example is compiled but never executed; its runtime behaviour is covered by
the package's own tests.

<<< @/api/examples/live-transcription.ts#usage

## Options

`new OnDeviceLiveTranscriber(options)` takes `OnDeviceLiveTranscriberOptions`. The same
`wasmPaths` (required, same-origin ORT runtime) and `createWorker` constraints apply as on the
batch engine — see [`OnDeviceTranscriber`](/api/ondevice-transcriber)'s options, all of which
mean the same thing here except where noted.

The defaults the page states are quoted from the example file rather than retyped, and the same
file's test run asserts the open timeout against its exported constant:

<<< @/api/examples/live-defaults.run.ts#defaults

| Name                            | Type           | Default                                | What it does                                                                                                                                                                                                                                       |
| ------------------------------- | -------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wasmPaths`                     | `string`       | **required**                           | Same-origin base URL the ORT runtime files are served from.                                                                                                                                                                                        |
| `createWorker`                  | `() => Worker` | best-effort default                    | Factory for the inference worker — the host builds it in its own bundler context. See [`OnDeviceTranscriber`](/api/ondevice-transcriber)'s worker wiring.                                                                                          |
| `openTimeoutMs`                 | `number`       | `DEFAULT_LIVE_OPEN_TIMEOUT_MS` (above) | How long `openSession` waits for the worker to report the session open. Much shorter than the batch timeout on purpose: it bounds loading a small VAD model, so a stalled open fails while the auditor is on their first sentence, not their last. |
| `modelId`                       | `string`       | `DEFAULT_MODEL_ID`                     | The ASR model — the same default and the same trade (no priming) as the batch engine.                                                                                                                                                              |
| `device` / `dtype` / `revision` | —              | transformers.js defaults               | Execution provider, quantization, Hub revision — forwarded to the same pipeline the batch path uses.                                                                                                                                               |
| `cacheStorage`                  | `CacheStorage` | `globalThis.caches`                    | Injectable `CacheStorage` for `liveCapability()`.                                                                                                                                                                                                  |

Options are read from `packages/ribo-transcriber-ondevice/src/live.ts`; the seam from
`packages/ribo-core/src/transcription/live.ts`.

## Return value

- `liveCapability()` — `ready` only when **both** the ASR model and the streaming VAD (Silero)
  are cached; `needs-download` carries the ASR estimate plus the VAD's, because a user primed
  before the VAD shipped still needs both.
- `openSession(recording)` — loads the VAD if it is not warm, then returns a `LiveSession`:
  `feed(frame)` (**synchronous** — it posts to the worker and returns before the inference it
  triggers, because a stalled audio callback degrades capture), `close()`, and `segments$` — one
  observable of `LiveSegment`, each tagged `tail` (provisional text for the growing region;
  replace wholesale) or `commit` (permanent text for a settled region; append).
- `errors$` — a separate observable, one emission per mid-session failure. Erroring the segment
  stream would terminate it permanently for one bad region; a per-utterance failure says nothing
  about the next.

`close()` stops feeding but does not drop segments: the worker transcribes the last buffered
region **after** close and posts it back, and the segment stream completes only when that drain
is done — so a host can tear down its subscription knowing the auditor's last sentence arrived.

## Errors

`openSession` rejects when the VAD model cannot be loaded — the caller treats that as "no
preview for this recording", not as a recording failure. Mid-session failures surface on
`errors$` without ending the preview. Nothing on the live path ever fails a capture.

## Full example

Type-checked only — never executed; see the note under Usage. The page's runnable defaults
example (under Options) is the part that runs in CI.

<<< @/api/examples/live-transcription.ts

## Related APIs

- [`OnDeviceTranscriber`](/api/ondevice-transcriber) — the batch engine sharing the worker and
  the model; its options page carries the worker wiring.
- [`Transcriber`](/api/transcriber) — the batch seam; live is never composed through
  `firstCapable`.

## Guides that use it

None — no guide walks the live path yet. This page is the lookup for the seam, the session and
the tail/commit distinction.

## Reference

- [`LiveTranscriber`](/reference/@azx/ribo-core/interfaces/LiveTranscriber.html)
- [`LiveSession`](/reference/@azx/ribo-core/interfaces/LiveSession.html)
- [`LiveSegment`](/reference/@azx/ribo-core/type-aliases/LiveSegment.html) ·
  [`LiveSegmentKind`](/reference/@azx/ribo-core/type-aliases/LiveSegmentKind.html)
- [`OnDeviceLiveTranscriber`](/reference/@azx/ribo-transcriber-ondevice/classes/OnDeviceLiveTranscriber.html)
- [`OnDeviceLiveTranscriberOptions`](/reference/@azx/ribo-transcriber-ondevice/interfaces/OnDeviceLiveTranscriberOptions.html)
- [`DEFAULT_LIVE_OPEN_TIMEOUT_MS`](/reference/@azx/ribo-transcriber-ondevice/variables/DEFAULT_LIVE_OPEN_TIMEOUT_MS.html)
