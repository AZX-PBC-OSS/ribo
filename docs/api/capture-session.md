# Capture session

`openCaptureSession` opens one live recording against storage: it inserts the `recording` row and
returns a session that ingests `dataavailable` chunks synchronously, persists them in order, and at
`finalize()` merges, decode-verifies and commits the capture. `recoverInterrupted` is its startup
companion: it completes the recordings a dead tab left behind. The `CaptureSession` surface,
`CaptureSessionOptions` and the `CaptureHealth` signal live here too.

## When to reach for it

Reach for this page when wiring capture by hand — a host that drives `MediaRecorder` itself instead
of through the `Recorder` hook layer, or that wants to understand what the recorder is doing under
it. Reach for the [Captures & Sources guide](/guide/captures-and-sources) for the flow a capture
takes through the queue, and [Offline & Storage](/guide/offline-and-storage) for the storage the
session writes into.

## Usage

<<< @/api/examples/capture-session.run.ts#usage

`ingest` is synchronous — it appends to an ordered buffer and returns, so the `dataavailable`
handler never awaits. Persistence drains that buffer separately. `finalize()` resolves with the
merged audio, the decoded duration, and the committed capture row (status `queued`, ready for the
relay).

## Options

`openCaptureSession(options)` takes `CaptureSessionOptions`; `recoverInterrupted(options)` takes
`RecoveryOptions`. No member of either has an exported-constant default: the two injectable members
default to `Date.now` and `decodeAudioDuration` respectively (read from
`packages/ribo-core/src/storage/capture-session.ts`), and the stall threshold is a private
constant in the same file — stated from the source below, with no exported constant to assert
against.

| Name          | In                      | Type                              | Default               | What it does                                                                                                                   |
| ------------- | ----------------------- | --------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `storage`     | `CaptureSessionOptions` | `Storage`                         | **required**          | Where the recording row and its chunks live. Opened over any `StorageBackend` — the example runs on the in-memory one.         |
| `recording`   | `CaptureSessionOptions` | `Recording`                       | **required**          | The capture metadata persisted with the row.                                                                                   |
| `sourceId`    | `CaptureSessionOptions` | `string`                          | **required**          | Names the capture's chunk files.                                                                                               |
| `mimeType`    | `CaptureSessionOptions` | `string`                          | **required**          | The container the chunks arrive in; also what byte-slicing keys on.                                                            |
| `sessionId`   | `CaptureSessionOptions` | `string`                          | **required**          | The session this recording belongs to.                                                                                         |
| `now`         | `CaptureSessionOptions` | `() => number`                    | `Date.now`            | Injectable clock, in epoch milliseconds. Stall detection reads it.                                                             |
| `decode`      | `CaptureSessionOptions` | `(blob: Blob) => Promise<number>` | `decodeAudioDuration` | Decode-verify: return the merged blob's duration in milliseconds, or throw if it cannot decode. Injected so tests can fake it. |
| `decode`      | `RecoveryOptions`       | `(blob: Blob) => Promise<number>` | **required**          | The same injectable, required here — recovery decides from it whether a merge is decodable.                                    |
| `onRecovered` | `RecoveryOptions`       | `(ids: string[]) => void`         | —                     | Called with the ids of the new rows recovery created, so the caller can sync or drain now.                                     |

The stall threshold behind `CaptureHealth` is the one number this page states without an exported
constant to assert against: a chunk write failure, or no `dataavailable` past the threshold,
latches `stalled` — read from `packages/ribo-core/src/storage/capture-session.ts`, where the
private constant is a commented placeholder (currently 30 s) rather than a chosen value. It is a
stated residual risk, re-checkable by any reader.

## Return value

`openCaptureSession` resolves to a `CaptureSession`:

- `ingest(blob)` — synchronous ingestion of one `dataavailable` chunk.
- `resumed()` — a user-initiated `Recorder.resume()`; resets the emission baseline. Deliberately
  not called on page restore — one is the user choosing to stop capturing, the other is capture
  being taken away.
- `finalize()` — closes ingestion, drains, merges, decode-verifies, commits; resolves with
  `{ audio, durationMs, item }`. The health observable completes.
- `abort()` — stop accepting data and remove the row. Fire-and-forget: if the removal fails,
  startup recovery collects the row.
- `itemId`, `sourceId` — the row the session writes.
- `health$` — an RxJS observable of `CaptureHealth`: `"flushing"` (chunks are being written; the
  unflushed tail is the expected state of a live recording) or `"stalled"` (a chunk write failed,
  or no `dataavailable` past the threshold — the recording is still in memory, but nothing new has
  reached disk). A `BehaviorSubject`, so a late subscriber sees the current state immediately.

`recoverInterrupted` resolves to the ids of the new rows it created. For each row left in
`recording` status (nothing else holds the capture lock, so none is live): if its chunks merge and
decode, a **new** row is inserted, `queued`, with that audio, and the original is marked `dead`
with a reason naming its successor; if nothing decodable survives — even after dropping the last
chunk — it is left `dead` with `lastError` set and its chunks intact. There is no half-recovered
state.

## Errors

- `finalize()`'s decode-verify throws when the merged blob cannot be decoded — the same failure
  recovery handles by marking a row `dead`.
- `recoverInterrupted` throws nothing for an unrecoverable row: the row is marked `dead` with
  `lastError`, and recovery moves on. Throwing belongs to `decode` itself.
- When another tab is recording, `recoverInterrupted` resolves `[]` without running — the live
  session owns the rows. There is no error and no partial recovery.

## Full example

The capture-session example **runs in CI**: every exported function below is executed by the Vitest
`unit` project on every `test` run, ending in assertions on exactly what this page claims.

<<< @/api/examples/capture-session.run.ts

The recovery example is **type-checked only**: `recoverInterrupted` excludes against the Web Locks
API (`navigator.locks`), which exists only in a browser, so there is no credential-free node form
of the real thing.

<<< @/api/examples/recovery.ts

## Related APIs

- [`Recorder`](/api/recorder) — the microphone capture that produces the `dataavailable` chunks a
  session ingests.
- [`Transcriber`](/api/transcriber) — what the relay hands the committed capture to.
- [`openStorage`](/reference/@azx/ribo-core/functions/openStorage.html) — where `storage` comes
  from, over any `StorageBackend`.

## Guides that use it

- [Captures & Sources](/guide/captures-and-sources) — the flow a capture takes through the queue.
- [Offline & Storage](/guide/offline-and-storage) — the durable storage this page writes into.

## Reference

- [`openCaptureSession`](/reference/@azx/ribo-core/functions/openCaptureSession.html)
- [`CaptureSession`](/reference/@azx/ribo-core/interfaces/CaptureSession.html)
- [`CaptureSessionOptions`](/reference/@azx/ribo-core/interfaces/CaptureSessionOptions.html)
- [`CaptureHealth`](/reference/@azx/ribo-core/type-aliases/CaptureHealth.html)
- [`recoverInterrupted`](/reference/@azx/ribo-core/functions/recoverInterrupted.html)
- [`RecoveryOptions`](/reference/@azx/ribo-core/interfaces/RecoveryOptions.html)
