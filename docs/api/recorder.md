# Recorder

A `Recorder` turns microphone input into an `AudioCapture` plus its audio `Blob` — one dictation at a
time, reusable across captures. Two things are load-bearing beyond "record some audio": the
container is **negotiated** per browser (`MediaRecorder` emits WebM/Opus on Chromium, MP4/AAC on
Safari, and an `AudioCapture` whose `mimeType` does not describe its bytes fails later, somewhere
else), and the stream is **released on every exit path** — a microphone left open in a field tool
is a privacy problem, not a resource leak.

## When to reach for it

Reach for `Recorder` when a host UI drives capture directly — a record button, a level meter, a
pause control. Reach for the [Captures & Sources guide](/guide/captures-and-sources) when you want
the flow a capture takes through the queue, and for [`useRecorder`](/guide/react) when you are
writing a React host and want the hook that owns one.

## Usage

Type-checked only — constructing a `Recorder` and driving a capture needs `MediaRecorder`, a
microphone and an `AudioContext`, so this example is compiled but never executed; its runtime
behaviour is covered by the core package's own tests.

<<< @/api/examples/recorder.ts#usage

## Options

`new Recorder(options?)` takes `RecorderOptions<C>` — `C` is the host context copied onto every
`AudioCapture` this recorder produces.

None of the constructor defaults is an exported constant, so this page names its source instead
of quoting a checked value: all defaults below are read from
`packages/ribo-core/src/recorder.ts`, the `Recorder` constructor and the option docs there.

| Name              | Type                                                     | Default                                 | What it does                                                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ctx`             | `C`                                                      | `{}`                                    | Host association copied onto every `AudioCapture`. Defaults to an empty object — never `undefined` — so "no context" stays distinguishable from "forgot".                                                                      |
| `mimeTypes`       | `readonly string[]`                                      | the preference list in `recorder.ts:59` | Container preference, best first; codec outranks container, so every Opus entry beats every AAC one. The negotiated type is what the live `MediaRecorder` _reports_, read back at `stop()`.                                    |
| `tickMs`          | `number`                                                 | `100`                                   | How often `subscribe` listeners are notified while recording.                                                                                                                                                                  |
| `audio`           | `boolean \| MediaTrackConstraints`                       | `true`                                  | Constraints for the audio track; `true` takes the browser default device.                                                                                                                                                      |
| `createId`        | `() => string`                                           | `crypto.randomUUID()`                   | Recording id factory.                                                                                                                                                                                                          |
| `getUserMedia`    | `(constraints) => Promise<MediaStream>`                  | `navigator.mediaDevices.getUserMedia`   | Seam for the microphone, so denied-permission and no-device paths are testable without a browser that has neither.                                                                                                             |
| `createRecorder`  | `(stream, options) => MediaRecorder`                     | `new MediaRecorder(stream, options)`    | Seam for the recorder itself, for the same reason.                                                                                                                                                                             |
| `captureSession`  | `(opts) => Promise<CaptureSession>`                      | — (absent = non-durable)                | Durable-capture session factory. Supplied, `start()` opens a session and every chunk lands on disk as it is produced; `stop()` finalises and commits. Absent, the capture is in-memory and the caller owns persisting it.      |
| `timesliceMs`     | `number`                                                 | `5000`                                  | `MediaRecorder` timeslice in durable mode — how often chunks are flushed to the session.                                                                                                                                       |
| `onSamples`       | `(frame: Float32Array) => void`                          | —                                       | Live-sample tap: 512-sample frames of 16 kHz mono PCM, the frame Silero VAD consumes. Best-effort — a tap failure never stops capture.                                                                                         |
| `createSampleTap` | `(opts: SampleTapOptions) => Promise<SampleTapTeardown>` | the `./worklet` AudioWorklet factory    | Factory for the tap. Injectable for tests. **A workspace host must inject it**: the default resolves a built `.js` asset that does not exist under the `@azx/source` condition (`recorder.ts`, the default factory's comment). |

## Return value

- `start()` — resolves to the storage item id when recording durably (the row is already
  `queued`), `undefined` in non-durable mode. On any failure the stream is released, the capture
  lock is freed, and the recorder is left idle, so a retry starts from a clean state.
- `stop()` — resolves to a `RecorderCapture`: `recording` (the metadata, including the
  **negotiated** `mimeType`), `audio` (the `Blob`), and `itemId` — present only when durable
  capture ran. `itemId` present means the audio is on disk; a caller must not enqueue it again.
- `subscribe(listener)` — observes `RecorderState` (`phase`, `elapsedMs`, `level`, `error`),
  calling immediately, then on every tick and every phase change. Returns an `Unsubscribe`.
- `state` — the same `RecorderState`, read without subscribing.

`pause()` keeps the **microphone open** — `MediaRecorder.resume()` requires the same stream, so
the browser's recording indicator stays lit while paused. That is consumer-visible and documented
on the method, not hidden; call `stop()` to actually release the mic. `elapsedMs` excludes paused
spans.

## Errors

Capture failures throw `RecorderError`, carrying a machine-readable `code` (stable strings a UI
may switch on) and the original `DOMException` as `cause`:

- `unsupported-mime-type` — `negotiateMimeType` found no supported container in the preference
  list. Deliberately louder than falling back to the browser default: an `AudioCapture` whose
  `mimeType` does not describe its bytes fails later and somewhere else.
- `permission-denied`, `no-input-device` — `getUserMedia` rejections, classified by name.
- `already-recording`, `not-recording` — misuse of the one-capture-at-a-time lifecycle.
- `capture-busy` — another tab holds the capture lock; recording is exclusive across tabs.
- `capture-failed` — anything else the browser threw.

A failure **mid-capture** is surfaced, not banked: the phase moves to `failed` immediately (with
the failure on `RecorderState.error`, and `level` zeroed) so a UI stops showing a live capture
while the contractor dictates into a dead recorder. `stop()` still rejects with the same error
and still tears down.

## Full example

Type-checked only — never executed; see the note under Usage.

<<< @/api/examples/recorder.ts

## Wiring the worker

There is no worker to wire: `Recorder` runs `MediaRecorder` on the page itself, and its optional
sample tap is an `AudioWorklet` loaded from `@azx/ribo-core/worklet` by the default factory.

## Related APIs

- [`RecorderError`](/reference/@azx/ribo-core/classes/RecorderError.html) and
  [`RecorderErrorCode`](/reference/@azx/ribo-core/type-aliases/RecorderErrorCode.html) — the
  failure vocabulary.
- [`negotiateMimeType`](/reference/@azx/ribo-core/functions/negotiateMimeType.html) — the
  container probe, usable on its own.
- [`RecorderCapture`](/reference/@azx/ribo-core/interfaces/RecorderCapture.html),
  [`RecorderState`](/reference/@azx/ribo-core/interfaces/RecorderState.html),
  [`RecorderPhase`](/reference/@azx/ribo-core/type-aliases/RecorderPhase.html) — the shapes a
  host renders from.
- [`SampleTapOptions`](/reference/@azx/ribo-core/interfaces/SampleTapOptions.html) /
  [`SampleTapTeardown`](/reference/@azx/ribo-core/type-aliases/SampleTapTeardown.html) — the
  live-sample tap seam.
- [`useRecorder`](/reference/@azx/ribo-ui-react/functions/useRecorder.html) — the React hook
  over this class.

## Guides that use it

- [Captures & Sources](/guide/captures-and-sources) — the flow a capture takes through the queue.
- [React Hooks](/guide/react) — `useRecorder` wraps this class for React hosts.

## Reference

- [`Recorder`](/reference/@azx/ribo-core/classes/Recorder.html)
- [`RecorderOptions`](/reference/@azx/ribo-core/interfaces/RecorderOptions.html)
- [`RecorderError`](/reference/@azx/ribo-core/classes/RecorderError.html)
- [`negotiateMimeType`](/reference/@azx/ribo-core/functions/negotiateMimeType.html)
