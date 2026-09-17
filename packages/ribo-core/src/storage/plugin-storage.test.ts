import { createMemoryBackend, removeMemoryDatabase } from "./memory-backend.js";
import { afterEach, expect, test } from "vitest";

import type { Recording } from "../recording.js";
import { openStorage, type Storage } from "./storage.js";

// Plugin-scoped storage: isolation and sweep, proven with memory storage.
//
// This is a node `unit` test on purpose: memory storage needs no IndexedDB,
// which is the value of the storage-injection seam. The durability property
// (a value survives a fresh handle) is proved separately in
// `plugin-storage.browser.test.ts` against real IndexedDB — memory storage
// would fake that property, so it stays there.

const opened: { outbox: Storage; name: string }[] = [];

afterEach(async () => {
  for (const { outbox, name } of opened.splice(0)) {
    if (!outbox.closed) await outbox.close();
    // A memory database outlives its handle, as an IndexedDB one does.
    removeMemoryDatabase(name);
  }
});

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-09-11T10:00:00.000Z",
  kind: "audio",
  durationMs: 4200,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-1" },
};

function audioBlob(): Blob {
  const bytes = new Uint8Array(128).map((_, i) => (i * 31 + 7) % 256);
  return new Blob([bytes], { type: "audio/webm;codecs=opus" });
}

async function freshOutbox(): Promise<{ outbox: Storage; captureId: string }> {
  const name = `ribo-outbox-plugin-storage-${crypto.randomUUID()}`;
  const outbox = await openStorage({ backend: createMemoryBackend(name) });
  opened.push({ outbox, name });
  const session = await outbox.sessions.open({ ctx: { jobId: "job-1" }, ref: "job-1" });
  const item = await outbox.captures.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: session.id,
  });
  return { outbox, captureId: item.id };
}

// ---------------------------------------------------------------------------
// Isolation: two plugins cannot read or clobber each other's keys.
// ---------------------------------------------------------------------------

test("two plugins writing the same key keep separate values", async () => {
  const { outbox, captureId } = await freshOutbox();

  const a = outbox.scopedStore(captureId, "plugin-A");
  const b = outbox.scopedStore(captureId, "plugin-B");

  await a.set("shared-key", { from: "A" });
  await b.set("shared-key", { from: "B" });

  expect(await a.get("shared-key")).toEqual({ from: "A" });
  expect(await b.get("shared-key")).toEqual({ from: "B" });
});

test("a plugin cannot read another plugin's key", async () => {
  const { outbox, captureId } = await freshOutbox();

  const a = outbox.scopedStore(captureId, "plugin-A");
  const b = outbox.scopedStore(captureId, "plugin-B");

  await a.set("secret", "A-value");
  expect(await b.get("secret")).toBeUndefined();
});

test("keys() returns only this plugin's keys for this capture", async () => {
  const { outbox, captureId } = await freshOutbox();

  const a = outbox.scopedStore(captureId, "plugin-A");
  const b = outbox.scopedStore(captureId, "plugin-B");

  await a.set("alpha", 1);
  await a.set("beta", 2);
  await b.set("gamma", 3);

  expect(await a.keys()).toEqual(["alpha", "beta"]);
  expect(await b.keys()).toEqual(["gamma"]);
});

test("the same plugin at two captures keeps separate entries", async () => {
  const { outbox } = await freshOutbox();
  const session = await outbox.sessions.open({ ctx: { jobId: "job-2" }, ref: "job-2" });
  await outbox.captures.enqueue({ recording, audio: audioBlob(), sessionId: session.id });

  const items = await outbox.captures.list();
  const firstItem = items[0]!;
  const secondItem = items[1]!;

  const aFirst = outbox.scopedStore(firstItem.id, "plugin-A");
  const aSecond = outbox.scopedStore(secondItem.id, "plugin-A");

  await aFirst.set("positional", "first");
  await aSecond.set("positional", "second");

  expect(await aFirst.get("positional")).toBe("first");
  expect(await aSecond.get("positional")).toBe("second");
});

test("delete removes only the targeted key", async () => {
  const { outbox, captureId } = await freshOutbox();
  const store = outbox.scopedStore(captureId, "plugin-A");

  await store.set("keep", 1);
  await store.set("drop", 2);
  await store.delete("drop");

  expect(await store.get("keep")).toBe(1);
  expect(await store.get("drop")).toBeUndefined();
  expect(await store.keys()).toEqual(["keep"]);
});

test("a complex value round-trips through JSON", async () => {
  const { outbox, captureId } = await freshOutbox();
  const store = outbox.scopedStore(captureId, "plugin-A");

  const value = {
    documentId: "doc-123",
    pages: [1, 2, 3],
    annotations: [{ page: 1, text: "note" }],
  };
  await store.set("complex", value);
  expect(await store.get("complex")).toEqual(value);
});

// ---------------------------------------------------------------------------
// Sweep: core removes plugin keys when a capture is dropped or discarded.
// ---------------------------------------------------------------------------

test("remove sweeps plugin-storage entries for that capture", async () => {
  const { outbox, captureId } = await freshOutbox();

  const a = outbox.scopedStore(captureId, "plugin-A");
  await a.set("key-1", "value-1");
  expect(await a.get("key-1")).toBe("value-1");

  await outbox.captures.remove(captureId);

  const after = outbox.scopedStore(captureId, "plugin-A");
  expect(await after.get("key-1")).toBeUndefined();
  expect(await after.keys()).toEqual([]);
});

test("removeMany sweeps plugin-storage entries for every removed capture", async () => {
  const { outbox } = await freshOutbox();
  const session = await outbox.sessions.open({ ctx: { jobId: "job-2" }, ref: "job-2" });
  const item2 = await outbox.captures.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: session.id,
  });
  const item1 = (await outbox.captures.list())[0]!;

  const a1 = outbox.scopedStore(item1.id, "plugin-A");
  const a2 = outbox.scopedStore(item2.id, "plugin-A");
  await a1.set("k", "v1");
  await a2.set("k", "v2");

  await outbox.captures.removeMany([item1.id, item2.id]);

  expect(await outbox.scopedStore(item1.id, "plugin-A").keys()).toEqual([]);
  expect(await outbox.scopedStore(item2.id, "plugin-A").keys()).toEqual([]);
});

test("clear sweeps plugin-storage entries for every removed capture", async () => {
  const { outbox } = await freshOutbox();
  const session = await outbox.sessions.open({ ctx: { jobId: "job-2" }, ref: "job-2" });
  await outbox.captures.enqueue({ recording, audio: audioBlob(), sessionId: session.id });
  const items = await outbox.captures.list();

  for (const item of items) {
    await outbox.scopedStore(item.id, "plugin-A").set("k", "v");
  }

  await outbox.captures.clear();

  for (const item of items) {
    expect(await outbox.scopedStore(item.id, "plugin-A").keys()).toEqual([]);
  }
});

test("patch to discarded sweeps plugin-storage entries for that capture", async () => {
  const { outbox, captureId } = await freshOutbox();

  const a = outbox.scopedStore(captureId, "plugin-A");
  await a.set("key-1", "value-1");
  expect(await a.get("key-1")).toBe("value-1");

  await outbox.captures.patch(captureId, { status: "discarded" });

  expect(await outbox.scopedStore(captureId, "plugin-A").get("key-1")).toBeUndefined();
  expect(await outbox.scopedStore(captureId, "plugin-A").keys()).toEqual([]);
});

test("patch to a non-discarded status does NOT sweep plugin storage", async () => {
  const { outbox, captureId } = await freshOutbox();

  const a = outbox.scopedStore(captureId, "plugin-A");
  await a.set("key-1", "value-1");

  await outbox.captures.patch(captureId, { status: "queued", attempts: 1 });

  expect(await a.get("key-1")).toBe("value-1");
});

// ---------------------------------------------------------------------------
// Multi-plugin sweep: the sweep removes keys for every plugin, not just one.
// ---------------------------------------------------------------------------

test("remove sweeps entries for every plugin that wrote against the capture", async () => {
  const { outbox, captureId } = await freshOutbox();

  const a = outbox.scopedStore(captureId, "plugin-A");
  const b = outbox.scopedStore(captureId, "plugin-B");
  const c = outbox.scopedStore(captureId, "plugin-C");

  await a.set("k", "a");
  await b.set("k", "b");
  await c.set("k", "c");

  // Only plugin-A's handle is used to trigger the sweep (via remove), but
  // the sweep is by captureId, so every plugin's entries are removed.
  await outbox.captures.remove(captureId);

  expect(await outbox.scopedStore(captureId, "plugin-A").keys()).toEqual([]);
  expect(await outbox.scopedStore(captureId, "plugin-B").keys()).toEqual([]);
  expect(await outbox.scopedStore(captureId, "plugin-C").keys()).toEqual([]);
});

test("discard sweeps entries for every plugin that wrote against the capture", async () => {
  const { outbox, captureId } = await freshOutbox();

  const a = outbox.scopedStore(captureId, "plugin-A");
  const b = outbox.scopedStore(captureId, "plugin-B");

  await a.set("k", "a");
  await b.set("k", "b");

  await outbox.captures.patch(captureId, { status: "discarded" });

  expect(await outbox.scopedStore(captureId, "plugin-A").keys()).toEqual([]);
  expect(await outbox.scopedStore(captureId, "plugin-B").keys()).toEqual([]);
});

test("sweeping one capture does not affect another capture's entries", async () => {
  const { outbox, captureId: cap1 } = await freshOutbox();
  const session = await outbox.sessions.open({ ctx: { jobId: "job-2" }, ref: "job-2" });
  const item2 = await outbox.captures.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: session.id,
  });
  const cap2 = item2.id;

  const a1 = outbox.scopedStore(cap1, "plugin-A");
  const a2 = outbox.scopedStore(cap2, "plugin-A");
  await a1.set("k", "v1");
  await a2.set("k", "v2");

  await outbox.captures.remove(cap1);

  expect(await a1.get("k")).toBeUndefined();
  expect(await a2.get("k")).toBe("v2");
});

test("an over-long key is rejected at the boundary, not at the index layer", async () => {
  // RxDB derives fixed-width index keys from the schema's maxLength, so an overrun corrupts
  // index ordering rather than throwing. The zod bound turns it into an error the caller reads,
  // at the call that caused it.
  const { outbox, captureId } = await freshOutbox();
  const storage = outbox.scopedStore(captureId, "plugin-a");

  await expect(storage.set("k".repeat(257), "v")).rejects.toThrow();
  await storage.set("k".repeat(256), "v");
  expect(await storage.get("k".repeat(256))).toBe("v");
});

// ---------------------------------------------------------------------------
// Delivery scopes: the two partial applications of pluginStorage — one keyed by
// capture (what the relay hands a transcriber), one keyed by plugin (what a
// host hands an extractor at construction).
// ---------------------------------------------------------------------------

test("captureStorage.forPlugin is the same keyspace as pluginStorage(captureId, pluginId)", async () => {
  const { outbox, captureId } = await freshOutbox();

  const viaScope = outbox.captureStore(captureId).forPlugin("plugin-A");
  await viaScope.set("k", { v: 1 });

  // The substrate accessor reads what the scope wrote — one keyspace, two handles.
  expect(await outbox.scopedStore(captureId, "plugin-A").get("k")).toEqual({ v: 1 });
  expect(await viaScope.keys()).toEqual(["k"]);
});

test("pluginStorageScope.capture is the same keyspace as pluginStorage(captureId, pluginId)", async () => {
  const { outbox, captureId } = await freshOutbox();

  await outbox.scopedStore(captureId, "plugin-A").set("k", "written-by-transcriber");

  const scope = outbox.store("plugin-A");
  expect(await scope.capture(captureId).get("k")).toBe("written-by-transcriber");
});

test("pluginStorageScope.captures enumerates only this plugin's captures, sorted", async () => {
  const { outbox, captureId: cap1 } = await freshOutbox();
  const session = await outbox.sessions.open({ ctx: { jobId: "job-2" }, ref: "job-2" });
  const item2 = await outbox.captures.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: session.id,
  });
  const cap2 = item2.id;

  await outbox.scopedStore(cap1, "plugin-A").set("k", "v1");
  await outbox.scopedStore(cap2, "plugin-A").set("k", "v2");
  // Another plugin's entry for cap1 must not put cap1 in plugin-B's enumeration.
  await outbox.scopedStore(cap1, "plugin-B").set("k", "b");

  const scope = outbox.store("plugin-A");
  expect(await scope.captures()).toEqual([cap1, cap2].sort());
  expect(await outbox.store("plugin-B").captures()).toEqual([cap1]);
});
