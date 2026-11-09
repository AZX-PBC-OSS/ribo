# useRecorder

`useRecorder` is microphone capture as React state: phase, elapsed time, input level, error, and
async `start`/`stop`/`pause`/`resume`/`toggle` over the provider's
[`Recorder`](/api/recorder). Errors are captured into state rather than thrown out of an event
handler, where React cannot route them anywhere useful.

## When to reach for it

Reach for it in any React host with a record button. Reach for the
[React Hooks guide](/guide/react) for the wiring around it, and for the
[`Recorder`](/api/recorder) page for the capture engine underneath — negotiated containers, the
capture lock, the released stream — which this hook does not change.

## Usage

Type-checked only — calling the hook needs React's renderer and a real recorder, so this example
is compiled but never executed; its runtime behaviour is covered by the package's own browser
tests and the e2e suite.

<<< @/api/examples/use-recorder.tsx#usage

## Options

`useRecorder(options?)` takes `UseRecorderOptions`. Every field is optional; a field the hook
needs and does not find is a render-time throw (see Errors).

| Name                 | Type                 | Default                                                                                                                        | What it does                                                                                                                                                                                                               |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recorder`           | `AnyRecorder`        | the provider's                                                                                                                 | Override the recorder for a subtree — how a host with two recorders points one component at the second, and how tests inject one without a provider.                                                                       |
| `storage`            | `Storage`            | the provider's                                                                                                                 | Override the storage the durable path enqueues against.                                                                                                                                                                    |
| `enqueue`            | `boolean`            | `true` (stated as a residual risk: read from `use-recorder.ts:120`, no exported constant and no runnable example to assert it) | Hand the capture to storage on stop. The durable path is the **default** because a recording that stops without reaching disk is lost. With `enqueue: false` no storage is needed and `stop()` resolves `item: undefined`. |
| `captureCoordinator` | `CaptureCoordinator` | the provider's                                                                                                                 | Override or supply the coordinator that receives the active capture session for health reporting.                                                                                                                          |
| `liveTranscriber`    | `LiveTranscriber`    | the provider's                                                                                                                 | Override the live engine. When supplied and ready, recording opens a live session whose segments appear on the storage row's `preview` field.                                                                              |
| `sessionId`          | `string`             | —                                                                                                                              | The session this recording belongs to. Required on the durable path (the default): every recording is owned by a session in the session-entity model.                                                                      |

Source: `packages/ribo-ui-react/src/use-recorder.ts`.

## Return value

A `UseRecorderResult`:

- `phase`, `elapsedMs`, `level` — the recorder's observable state, delivered immediately on
  subscribe (never a blank first frame, never polled). `level` is honest RMS in `[0, 1]`;
  `scaledLevel` is the same value under a `sqrt` curve, which is what draws as a sensible meter.
- `busy` — an async `start`/`stop` is in flight.
- `error` — a `RecorderError` from a mid-capture failure the moment it happens (not held back
  until `stop()`), or from `start`/`pause`/`resume`. Cleared by the next `start()`.
- `liveTranscriber` — the configured live engine, or `undefined` when live is not configured; a
  UI reads it to decide whether to offer preview.
- `start()` — swallows its failure into `error` state and always resolves; a click handler has no
  return value to act on and just re-renders off `phase`/`error`.
- `stop()` — **rethrows** the failure it also writes into `error` state, because its resolved
  value carries what the caller needs next: `{ capture, item }`, where `item` is the queued row
  (already on disk — `capture.itemId` names it; enqueueing again would create a second row). A
  caller must `await stop()` inside a `try`.
- `pause()` / `resume()` — keep the microphone open (`MediaRecorder.resume()` needs the same
  stream); `toggle()` — start when idle, stop when recording or paused, reading the recorder's
  own phase rather than state that can be one render behind.

## Errors

- **Missing instance, missing storage** — a misconfiguration, thrown at render, not banked:
  `useRecorder` with the durable default and no storage anywhere throws with the fix in the
  message ("pass one to `<RiboProvider value={{ storage }}>` or set `enqueue: false`"). A missing
  recorder throws the same way, naming the constructor.
- **Missing `sessionId` on the durable path** — a `RecorderError("capture-failed")` from `stop()`,
  thrown where the caller can act on it.
- **Capture failures** — a `RecorderError` from the engine (permission denied, capture busy,
  unsupported container, mid-capture failure). Mid-capture, the recorder moves to `failed`
  immediately and the hook surfaces it through `error` without waiting for `stop()`. See the
  [`Recorder`](/api/recorder) page for the full code vocabulary.

Source: `packages/ribo-ui-react/src/use-recorder.ts`; `RecorderError` is core's
(`packages/ribo-core/src/recorder.ts`).

## Full example

Type-checked only — never executed; see the note under Usage.

<<< @/api/examples/use-recorder.tsx

## Related APIs

- [`Recorder`](/api/recorder) — the engine underneath: containers, locks, the sample tap.
- [`RiboProvider`](/api/ribo-provider) — where the default instances come from.
- [`createCaptureCoordinator`](/api/create-capture-coordinator) — the health reporting this hook
  publishes into.
- [`CaptureSession`](/api/capture-session) — the durable path's session lifecycle.

## Guides that use it

- [React Hooks](/guide/react) — the record button, the meter, and the wiring around them.
- [Captures & Sources](/guide/captures-and-sources) — the flow a stopped capture takes through
  the queue.

## Reference

- [`useRecorder`](/reference/@azx/ribo-ui-react/functions/useRecorder.html)
- [`UseRecorderOptions`](/reference/@azx/ribo-ui-react/interfaces/UseRecorderOptions.html) ·
  [`UseRecorderResult`](/reference/@azx/ribo-ui-react/interfaces/UseRecorderResult.html) ·
  [`StopResult`](/reference/@azx/ribo-ui-react/interfaces/StopResult.html)
- [`RecorderError`](/reference/@azx/ribo-core/classes/RecorderError.html)
