import { removeStorageDatabase } from "./database.js";
import { openRxdbBackend } from "./open.js";
import { afterEach, expect, test } from "vitest";

import type { Recording } from "@azx/ribo-core";
import { openStorage } from "@azx/ribo-core";

// Browser-mode, not jsdom, for the same reason `storage-durability.browser.test.ts`
// is: the durability test closes one handle and opens another over the same
// named IndexedDB database, and this asserts that Chromium's real IndexedDB
// carries bytes between them. The isolation and sweep tests live in core's node
// `unit` file instead, since those are domain behaviour and need no engine.
//
// It lives in THIS package rather than in core for the same reason: what it
// pins is that the RxDB backend genuinely round-trips through IndexedDB, which
// is a claim about a backend and not about the storage. Core's memory backend is
// durable across a close-and-reopen too -- obligation 2 requires it -- so
// running this there would pass while proving something else entirely.

const usedNames: string[] = [];

function uniqueName(): string {
  const name = `ribo-storage-plugin-storage-browser-${crypto.randomUUID()}`;
  usedNames.push(name);
  return name;
}

afterEach(async () => {
  for (const name of usedNames.splice(0)) await removeStorageDatabase(name);
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

test("a value survives a fresh handle — durability, not memory", async () => {
  const name = uniqueName();

  // Write with the first handle.
  const first = await openStorage({ backend: await openRxdbBackend({ name }) });
  const session = await first.sessions.open({ ctx: { jobId: "job-1" }, ref: "job-1" });
  const item = await first.captures.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: session.id,
  });

  const store = first.scopedStore(item.id, "plugin-A");
  await store.set("document-id", { providerId: "doc-xyz", pages: 3 });
  await store.set("upload-handle", "handle-abc");

  await first.close();

  // Open a fresh handle over the same named database — no in-memory carry-over.
  const second = await openStorage({ backend: await openRxdbBackend({ name }) });
  const fresh = second.scopedStore(item.id, "plugin-A");

  expect(await fresh.get("document-id")).toEqual({ providerId: "doc-xyz", pages: 3 });
  expect(await fresh.get("upload-handle")).toBe("handle-abc");
  expect(await fresh.keys()).toEqual(["document-id", "upload-handle"]);

  await second.close();
});

test("durability survives a sweep on a different capture — only the swept capture's entries are removed", async () => {
  const name = uniqueName();

  const storage = await openStorage({ backend: await openRxdbBackend({ name }) });
  const session = await storage.sessions.open({ ctx: { jobId: "job-1" }, ref: "job-1" });
  const item1 = await storage.captures.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: session.id,
  });
  const item2 = await storage.captures.enqueue({
    recording,
    audio: audioBlob(),
    sessionId: session.id,
  });

  await storage.scopedStore(item1.id, "plugin-A").set("k", "keep");
  await storage.scopedStore(item2.id, "plugin-A").set("k", "drop");

  await storage.captures.remove(item2.id);
  await storage.close();

  const reopened = await openStorage({ backend: await openRxdbBackend({ name }) });
  expect(await reopened.scopedStore(item1.id, "plugin-A").get("k")).toBe("keep");
  expect(await reopened.scopedStore(item2.id, "plugin-A").get("k")).toBeUndefined();
  await reopened.close();
});
