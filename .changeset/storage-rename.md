---
"@azx/ribo-core": major
"@azx/ribo-ui-react": major
"@azx/ribo-storage-rxdb": minor
---

**Breaking: the outbox is now storage.** `Outbox` fronted three collections — recordings, sessions, and plugin key-value entries — and only the first was ever anything like an outbox. It is replaced by a `Storage` container over three stores, each owning its own concept.

There are no deprecated aliases. Nothing is published yet, and a doubled export surface with a removal schedule would buy nothing.

### Opening storage

`openOutbox()` becomes `openStorage({ backend })`, and the backend is **required** — there is no default, because every default would be wrong somewhere:

```ts
// before
const outbox = await openOutbox();

// after — production
import { openRxdbBackend } from "@azx/ribo-storage-rxdb";
const storage = await openStorage({ backend: await openRxdbBackend() });

// after — tests and development
import { createMemoryBackend } from "@azx/ribo-core";
const storage = await openStorage({ backend: createMemoryBackend("my-db") });
```

`OpenOutboxOptions.storage` (an `RxStorage`) is gone from core. That seam still exists, but inside a backend: `openRxdbBackend({ storage })`.

### Methods move onto the store that owns them

| Before                                                                                                                  | After                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `outbox.enqueue(…)`, `.get`, `.list`, `.watch`, `.items$`, `.patch`, `.remove`, `.removeMany`, `.clear`, `.nextPending` | `storage.captures.*` — unchanged names                                                                                |
| `.beginRecording`, `.appendChunk`, `.mergeChunks`, `.mergeChunksExcludingLast`, `.commitRecording`                      | `storage.captures.*` — unchanged names                                                                                |
| `.getAudio`, `.dropAudio`, `.writeTranscript`, `.writePreviewTail`, `.commitPreview`                                    | `storage.captures.*` — unchanged names                                                                                |
| `outbox.openSession(…)`                                                                                                 | `storage.sessions.open(…)`                                                                                            |
| `outbox.closeSession(…)`                                                                                                | `storage.sessions.close(…)`                                                                                           |
| `outbox.getSession` / `listSessions` / `watchSessions` / `nextPendingSession` / `patchSession`                          | `storage.sessions.get` / `.list` / `.watch` / `.nextPending` / `.patch`                                               |
| `outbox.submitSessionReview(…)`                                                                                         | `storage.sessions.submitReview(…)`                                                                                    |
| `outbox.reopenSessionForReview(…)`                                                                                      | `storage.sessions.reopenForReview(…)`                                                                                 |
| `outbox.pluginStorageScope(pluginId)`                                                                                   | `storage.store(owner)`                                                                                                |
| `outbox.captureStorage(captureId)`                                                                                      | `storage.captureStore(captureId)`                                                                                     |
| `outbox.pluginStorage(captureId, pluginId)`                                                                             | `storage.scopedStore(captureId, owner)`                                                                               |
| `outbox.database`                                                                                                       | `storage.backend` — the port, not an `RxDatabase`. A host wanting the database gets it from `@azx/ribo-storage-rxdb`. |

### Types and constants

| Before                                                               | After                                                                  |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `Outbox`                                                             | `Storage`                                                              |
| `OpenOutboxOptions`                                                  | `OpenStorageOptions`                                                   |
| `OutboxItem`                                                         | `Capture`                                                              |
| `OutboxDocument` / `OutboxPatch` / `OutboxQuery` / `OutboxStatus`    | `CaptureDocument` / `CapturePatch` / `CaptureQuery` / `CaptureStatus`  |
| `OUTBOX_STATUSES`, `ACTIVE_`/`FINISHED_`/`RECORDING_OUTBOX_STATUSES` | `CAPTURE_STATUSES`, `ACTIVE_`/`FINISHED_`/`RECORDING_CAPTURE_STATUSES` |
| `DERIVED_OUTBOX_ITEM_KEYS`                                           | `DERIVED_CAPTURE_KEYS`                                                 |
| `OUTBOX_COLLECTION_NAME`                                             | `CAPTURES_COLLECTION_NAME` (the persisted value is still `"outbox"`)   |
| `outboxDocumentSchema` / `outboxItemSchema`                          | `captureDocumentSchema` / `captureSchema`                              |
| `CaptureItem` (the payload union)                                    | `CapturePayload`                                                       |
| `Capture` (the recorder's output)                                    | `RecorderCapture`                                                      |
| `TerminalQueueError`                                                 | `TerminalError`                                                        |
| `useOutboxItems`                                                     | `useCaptures`                                                          |

**`Capture` changed meaning.** It used to be what `Recorder.stop()` returns; it is now the stored row (what `OutboxItem` was). The recorder's type is `RecorderCapture`. Two types one word apart, one containing the other, was a permanent tax — but check every `Capture` you hold.

### Nothing on disk changed

The database is still named `ribo-outbox` and the collections are still `outbox`, `sessions` and `pluginStorage`. Type-level renames are free; renaming persisted identifiers is a migration on the one collection where a bad migration strands real recordings, and it would buy nothing.
