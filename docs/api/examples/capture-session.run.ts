/**
 * The runnable example behind docs/api/capture-session.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: storage is `createMemoryBackend`
 * and the audio decode is injected.
 */

import assert from "node:assert/strict";
import {
  createMemoryBackend,
  type CaptureHealth,
  type CaptureSession,
  openCaptureSession,
  openStorage,
  type Recording,
  type Storage,
} from "@azx/ribo-core";

function recording(): Recording {
  return {
    id: "cap-rec",
    capturedAt: new Date().toISOString(),
    kind: "audio",
    durationMs: 0,
    mimeType: "audio/webm",
    ctx: {},
  };
}

async function storageFor(name: string): Promise<Storage> {
  const storage = await openStorage({ backend: createMemoryBackend(name) });
  return storage;
}

export async function aSessionIngestsChunksAndFinalizesIntoAQueuedCapture(): Promise<void> {
  // #region usage
  const storage = await storageFor("capture-session-finalize");
  const session: CaptureSession = await openCaptureSession({
    storage,
    recording: recording(),
    sourceId: "src-dictaphone",
    mimeType: "audio/webm",
    sessionId: "sess-1",
    // Injectable decode: the host's real path is `decodeAudioDuration` on the
    // main thread; this example asserts the duration it was handed.
    decode: async (blob) => blob.size * 10,
  });
  session.ingest(new Blob(["chunk-0"], { type: "audio/webm" }));
  session.ingest(new Blob(["chunk-1"], { type: "audio/webm" }));
  const { audio, durationMs, item } = await session.finalize();
  // #endregion usage

  // The merged audio is the chunks, in ingestion order; the decoded duration is
  // whatever the decode function returned; the capture is `queued` for the relay.
  assert.equal(await audio.text(), "chunk-0chunk-1");
  assert.equal(durationMs, 140);
  assert.equal(item.status, "queued");
  assert.equal(item.id, session.itemId);
}

export async function healthStartsFlushingAndIsVisibleToALateSubscriber(): Promise<void> {
  const storage = await storageFor("capture-session-health");
  const session = await openCaptureSession({
    storage,
    recording: recording(),
    sourceId: "src-dictaphone",
    mimeType: "audio/webm",
    sessionId: "sess-1",
    decode: async () => 0,
  });

  // A BehaviorSubject: a late subscriber (the work-safety hook mounting after
  // capture began) sees the current state immediately instead of hanging. The
  // BehaviorSubject emits synchronously, on subscribe — so unsubscribing is
  // deferred one microtask, until the handle exists.
  const health: CaptureHealth = await new Promise<CaptureHealth>((resolve) => {
    const subscription = session.health$.subscribe((value) => {
      queueMicrotask(() => {
        subscription.unsubscribe();
        resolve(value);
      });
    });
  });
  assert.equal(health, "flushing");

  await session.finalize();
}

export async function abortStopsIngestionAndRemovesTheRow(): Promise<void> {
  const storage = await storageFor("capture-session-abort");
  const session = await openCaptureSession({
    storage,
    recording: recording(),
    sourceId: "src-dictaphone",
    mimeType: "audio/webm",
    sessionId: "sess-1",
    decode: async () => 0,
  });
  session.ingest(new Blob(["chunk-0"], { type: "audio/webm" }));

  // Fire-and-forget by design: the row is removed without a promise to await.
  session.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const item = await storage.captures.get(session.itemId);
  assert.equal(item, undefined);
}

// #region defaults
export async function theDefaultsThePageStatesAreObservableOrNamed(): Promise<void> {
  const storage = await storageFor("capture-session-defaults");
  // `now` defaults to `Date.now` and `decode` to `decodeAudioDuration` — both
  // read from packages/ribo-core/src/storage/capture-session.ts; neither is an
  // exported constant, so the page cites the file rather than quoting a value.
  // The stall threshold is a private constant in the same file (`STALL_AFTER_MS`),
  // cited by file and line, not by name.
  const session = await openCaptureSession({
    storage,
    recording: recording(),
    sourceId: "src-dictaphone",
    mimeType: "audio/webm",
    sessionId: "sess-1",
  });
  assert.equal(session.sourceId, "src-dictaphone");
  // Fire-and-forget by design — there is no promise to await.
  session.abort();
}
// #endregion defaults
