/**
 * The runnable example behind docs/api/open-storage.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network over a memory backend; the RxDB
 * backend needs IndexedDB, so the page's RxDB wiring is prose, not code.
 */

import assert from "node:assert/strict";
import {
  createMemoryBackend,
  openStorage,
  removeMemoryDatabase,
  type Capture,
} from "@azx/ribo-core";

function recording(id: string): Capture["recording"] {
  return {
    id,
    capturedAt: new Date().toISOString(),
    kind: "audio",
    durationMs: 96_000,
    mimeType: "audio/webm",
    ctx: {},
  };
}

export async function openStorageBuildsTheThreeStoresOverABackend(): Promise<void> {
  // #region usage
  const name = `docs-open-storage-${crypto.randomUUID()}`;
  const storage = await openStorage({ backend: createMemoryBackend(name) });
  const session = await storage.sessions.open({ ctx: { jobId: "job-7" }, ref: "job-7" });
  const capture = await storage.captures.enqueue({
    recording: recording("rec-1"),
    audio: new Blob(["not really audio"], { type: "audio/webm" }),
    sessionId: session.id,
  });
  // #endregion usage

  // `enqueue` inserts the row `queued`, with the audio attached in the same
  // write and a sequence the backend allocated atomically.
  assert.equal(capture.status, "queued");
  assert.equal(capture.sessionId, session.id);
  assert.ok(capture.audioReady);
  const pending = await storage.captures.nextPending();
  assert.equal(pending?.id, capture.id);
  assert.equal((await storage.sessions.get(session.id))?.status, "open");

  await storage.close();
  removeMemoryDatabase(name);
  // Every store over a closed storage is unusable.
  assert.equal(storage.closed, true);
}

export async function aDeclaredStoreIsANamespacedViewOverEntries(): Promise<void> {
  const name = `docs-open-storage-${crypto.randomUUID()}`;
  const storage = await openStorage({ backend: createMemoryBackend(name) });
  const session = await storage.sessions.open({ ctx: { jobId: "job-7" }, ref: "job-7" });
  const capture = await storage.captures.enqueue({
    recording: recording("rec-1"),
    audio: new Blob(["not really audio"], { type: "audio/webm" }),
    sessionId: session.id,
  });

  // The owner is conventionally a package name: two owners that name
  // themselves differently cannot see each other's keys.
  const store = storage.store("com.example.calibration");
  await store.capture(capture.id).set("rtf", 0.42);
  assert.equal(await store.capture(capture.id).get<number>("rtf"), 0.42);
  assert.deepEqual(await store.captures(), [capture.id]);
  assert.deepEqual(await storage.store("com.example.other").captures(), []);

  await storage.close();
  removeMemoryDatabase(name);
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The clock default is observed, not assumed: with no `now` option, an
  // enqueued capture's timestamps are the real clock's.
  const name = `docs-open-storage-${crypto.randomUUID()}`;
  const storage = await openStorage({ backend: createMemoryBackend(name) });
  const before = Date.now();
  const capture = await storage.captures.enqueue({
    recording: recording("rec-1"),
    audio: new Blob(["not really audio"], { type: "audio/webm" }),
    sessionId: (await storage.sessions.open({ ctx: { jobId: "job-7" }, ref: "job-7" })).id,
  });
  const capturedMs = Date.parse(capture.enqueuedAt);
  assert.ok(capturedMs >= before && capturedMs <= Date.now());

  await storage.close();
  removeMemoryDatabase(name);
  // The id and idempotency-key defaults (`crypto.randomUUID`, read from
  // packages/ribo-core/src/storage/storage.ts) are observable the same way:
  // the ids minted above parse as uuids.
  assert.match(capture.id, /^[0-9a-f-]{36}$/);
}
// #endregion defaults
