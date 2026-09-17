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

const opened: { storage: Storage; name: string }[] = [];

afterEach(async () => {
  for (const { storage, name } of opened.splice(0)) {
    if (!storage.closed) await storage.close();
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

async function freshOutbox(): Promise<{ storage: Storage; captureId: string }> {
  const name = `ribo-storage-plugin-storage-${crypto.randomUUID()}`;
  const storage = await openStorage({ backend: createMemoryBackend(name) });
  opened.push({ storage, name });
  const session = await storage.sessions.open({ ctx: { jobId: "job-1" }, ref: "job-1" });
  const item = await storage.captures.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: session.id,
  });
  return { storage, captureId: item.id };
}

// ---------------------------------------------------------------------------
// Isolation: two plugins cannot read or clobber each other's keys.
// ---------------------------------------------------------------------------

test("two plugins writing the same key keep separate values", async () => {
  const { storage, captureId } = await freshOutbox();

  const a = storage.scopedStore(captureId, "plugin-A");
  const b = storage.scopedStore(captureId, "plugin-B");

  await a.set("shared-key", { from: "A" });
  await b.set("shared-key", { from: "B" });

  expect(await a.get("shared-key")).toEqual({ from: "A" });
  expect(await b.get("shared-key")).toEqual({ from: "B" });
});

test("a plugin cannot read another plugin's key", async () => {
  const { storage, captureId } = await freshOutbox();

  const a = storage.scopedStore(captureId, "plugin-A");
  const b = storage.scopedStore(captureId, "plugin-B");

  await a.set("secret", "A-value");
  expect(await b.get("secret")).toBeUndefined();
});

test("keys() returns only this plugin's keys for this capture", async () => {
  const { storage, captureId } = await freshOutbox();

  const a = storage.scopedStore(captureId, "plugin-A");
  const b = storage.scopedStore(captureId, "plugin-B");

  await a.set("alpha", 1);
  await a.set("beta", 2);
  await b.set("gamma", 3);

  expect(await a.keys()).toEqual(["alpha", "beta"]);
  expect(await b.keys()).toEqual(["gamma"]);
});

test("the same plugin at two captures keeps separate entries", async () => {
  const { storage } = await freshOutbox();
  const session = await storage.sessions.open({ ctx: { jobId: "job-2" }, ref: "job-2" });
  await storage.captures.enqueue({ recording, audio: audioBlob(), sessionId: session.id });

  const items = await storage.captures.list();
  const firstItem = items[0]!;
  const secondItem = items[1]!;

  const aFirst = storage.scopedStore(firstItem.id, "plugin-A");
  const aSecond = storage.scopedStore(secondItem.id, "plugin-A");

  await aFirst.set("positional", "first");
  await aSecond.set("positional", "second");

  expect(await aFirst.get("positional")).toBe("first");
  expect(await aSecond.get("positional")).toBe("second");
});

test("delete removes only the targeted key", async () => {
  const { storage, captureId } = await freshOutbox();
  const store = storage.scopedStore(captureId, "plugin-A");

  await store.set("keep", 1);
  await store.set("drop", 2);
  await store.delete("drop");

  expect(await store.get("keep")).toBe(1);
  expect(await store.get("drop")).toBeUndefined();
  expect(await store.keys()).toEqual(["keep"]);
});

test("a complex value round-trips through JSON", async () => {
  const { storage, captureId } = await freshOutbox();
  const store = storage.scopedStore(captureId, "plugin-A");

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
  const { storage, captureId } = await freshOutbox();

  const a = storage.scopedStore(captureId, "plugin-A");
  await a.set("key-1", "value-1");
  expect(await a.get("key-1")).toBe("value-1");

  await storage.captures.remove(captureId);

  const after = storage.scopedStore(captureId, "plugin-A");
  expect(await after.get("key-1")).toBeUndefined();
  expect(await after.keys()).toEqual([]);
});

test("removeMany sweeps plugin-storage entries for every removed capture", async () => {
  const { storage } = await freshOutbox();
  const session = await storage.sessions.open({ ctx: { jobId: "job-2" }, ref: "job-2" });
  const item2 = await storage.captures.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: session.id,
  });
  const item1 = (await storage.captures.list())[0]!;

  const a1 = storage.scopedStore(item1.id, "plugin-A");
  const a2 = storage.scopedStore(item2.id, "plugin-A");
  await a1.set("k", "v1");
  await a2.set("k", "v2");

  await storage.captures.removeMany([item1.id, item2.id]);

  expect(await storage.scopedStore(item1.id, "plugin-A").keys()).toEqual([]);
  expect(await storage.scopedStore(item2.id, "plugin-A").keys()).toEqual([]);
});

test("clear sweeps plugin-storage entries for every removed capture", async () => {
  const { storage } = await freshOutbox();
  const session = await storage.sessions.open({ ctx: { jobId: "job-2" }, ref: "job-2" });
  await storage.captures.enqueue({ recording, audio: audioBlob(), sessionId: session.id });
  const items = await storage.captures.list();

  for (const item of items) {
    await storage.scopedStore(item.id, "plugin-A").set("k", "v");
  }

  await storage.captures.clear();

  for (const item of items) {
    expect(await storage.scopedStore(item.id, "plugin-A").keys()).toEqual([]);
  }
});

test("patch to discarded sweeps plugin-storage entries for that capture", async () => {
  const { storage, captureId } = await freshOutbox();

  const a = storage.scopedStore(captureId, "plugin-A");
  await a.set("key-1", "value-1");
  expect(await a.get("key-1")).toBe("value-1");

  await storage.captures.patch(captureId, { status: "discarded" });

  expect(await storage.scopedStore(captureId, "plugin-A").get("key-1")).toBeUndefined();
  expect(await storage.scopedStore(captureId, "plugin-A").keys()).toEqual([]);
});

test("patch to a non-discarded status does NOT sweep plugin storage", async () => {
  const { storage, captureId } = await freshOutbox();

  const a = storage.scopedStore(captureId, "plugin-A");
  await a.set("key-1", "value-1");

  await storage.captures.patch(captureId, { status: "queued", attempts: 1 });

  expect(await a.get("key-1")).toBe("value-1");
});

// ---------------------------------------------------------------------------
// Multi-plugin sweep: the sweep removes keys for every plugin, not just one.
// ---------------------------------------------------------------------------

test("remove sweeps entries for every plugin that wrote against the capture", async () => {
  const { storage, captureId } = await freshOutbox();

  const a = storage.scopedStore(captureId, "plugin-A");
  const b = storage.scopedStore(captureId, "plugin-B");
  const c = storage.scopedStore(captureId, "plugin-C");

  await a.set("k", "a");
  await b.set("k", "b");
  await c.set("k", "c");

  // Only plugin-A's handle is used to trigger the sweep (via remove), but
  // the sweep is by captureId, so every plugin's entries are removed.
  await storage.captures.remove(captureId);

  expect(await storage.scopedStore(captureId, "plugin-A").keys()).toEqual([]);
  expect(await storage.scopedStore(captureId, "plugin-B").keys()).toEqual([]);
  expect(await storage.scopedStore(captureId, "plugin-C").keys()).toEqual([]);
});

test("discard sweeps entries for every plugin that wrote against the capture", async () => {
  const { storage, captureId } = await freshOutbox();

  const a = storage.scopedStore(captureId, "plugin-A");
  const b = storage.scopedStore(captureId, "plugin-B");

  await a.set("k", "a");
  await b.set("k", "b");

  await storage.captures.patch(captureId, { status: "discarded" });

  expect(await storage.scopedStore(captureId, "plugin-A").keys()).toEqual([]);
  expect(await storage.scopedStore(captureId, "plugin-B").keys()).toEqual([]);
});

test("sweeping one capture does not affect another capture's entries", async () => {
  const { storage, captureId: cap1 } = await freshOutbox();
  const session = await storage.sessions.open({ ctx: { jobId: "job-2" }, ref: "job-2" });
  const item2 = await storage.captures.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: session.id,
  });
  const cap2 = item2.id;

  const a1 = storage.scopedStore(cap1, "plugin-A");
  const a2 = storage.scopedStore(cap2, "plugin-A");
  await a1.set("k", "v1");
  await a2.set("k", "v2");

  await storage.captures.remove(cap1);

  expect(await a1.get("k")).toBeUndefined();
  expect(await a2.get("k")).toBe("v2");
});

test("an over-long key is rejected at the boundary, not at the index layer", async () => {
  // RxDB derives fixed-width index keys from the schema's maxLength, so an overrun corrupts
  // index ordering rather than throwing. The zod bound turns it into an error the caller reads,
  // at the call that caused it.
  const { storage, captureId } = await freshOutbox();
  const kv = storage.scopedStore(captureId, "plugin-a");

  await expect(kv.set("k".repeat(257), "v")).rejects.toThrow();
  await kv.set("k".repeat(256), "v");
  expect(await kv.get("k".repeat(256))).toBe("v");
});

// ---------------------------------------------------------------------------
// Delivery scopes: the two partial applications of pluginStorage — one keyed by
// capture (what the relay hands a transcriber), one keyed by plugin (what a
// host hands an extractor at construction).
// ---------------------------------------------------------------------------

test("captureStorage.forPlugin is the same keyspace as pluginStorage(captureId, pluginId)", async () => {
  const { storage, captureId } = await freshOutbox();

  const viaScope = storage.captureStore(captureId).forPlugin("plugin-A");
  await viaScope.set("k", { v: 1 });

  // The substrate accessor reads what the scope wrote — one keyspace, two handles.
  expect(await storage.scopedStore(captureId, "plugin-A").get("k")).toEqual({ v: 1 });
  expect(await viaScope.keys()).toEqual(["k"]);
});

test("pluginStorageScope.capture is the same keyspace as pluginStorage(captureId, pluginId)", async () => {
  const { storage, captureId } = await freshOutbox();

  await storage.scopedStore(captureId, "plugin-A").set("k", "written-by-transcriber");

  const scope = storage.store("plugin-A");
  expect(await scope.capture(captureId).get("k")).toBe("written-by-transcriber");
});

test("pluginStorageScope.captures enumerates only this plugin's captures, sorted", async () => {
  const { storage, captureId: cap1 } = await freshOutbox();
  const session = await storage.sessions.open({ ctx: { jobId: "job-2" }, ref: "job-2" });
  const item2 = await storage.captures.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: session.id,
  });
  const cap2 = item2.id;

  await storage.scopedStore(cap1, "plugin-A").set("k", "v1");
  await storage.scopedStore(cap2, "plugin-A").set("k", "v2");
  // Another plugin's entry for cap1 must not put cap1 in plugin-B's enumeration.
  await storage.scopedStore(cap1, "plugin-B").set("k", "b");

  const scope = storage.store("plugin-A");
  expect(await scope.captures()).toEqual([cap1, cap2].sort());
  expect(await storage.store("plugin-B").captures()).toEqual([cap1]);
});
