import { createMemoryBackend, removeMemoryDatabase } from "../storage/memory-backend.js";
import { afterEach, expect, test } from "vitest";

import type { Recording } from "../recording.js";
import { openOutbox } from "./outbox.js";

// Browser-mode, not jsdom, for the same reason `outbox.browser.test.ts` is:
// the durability test closes one handle and opens another over the same named
// IndexedDB database, and only Chromium's real IndexedDB carries bytes between
// them. Memory storage would fake that property, which is why the isolation and
// sweep tests live in the node `unit` file instead.

const usedNames: string[] = [];

function uniqueName(): string {
  const name = `ribo-outbox-plugin-storage-browser-${crypto.randomUUID()}`;
  usedNames.push(name);
  return name;
}

afterEach(async () => {
  for (const name of usedNames.splice(0)) removeMemoryDatabase(name);
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
  const first = await openOutbox({ backend: createMemoryBackend(name) });
  const session = await first.openSession({ ctx: { jobId: "job-1" }, ref: "job-1" });
  const item = await first.enqueue({ recording, audio: audioBlob(), sessionId: session.id });

  const store = first.pluginStorage(item.id, "plugin-A");
  await store.set("document-id", { providerId: "doc-xyz", pages: 3 });
  await store.set("upload-handle", "handle-abc");

  await first.close();

  // Open a fresh handle over the same named database — no in-memory carry-over.
  const second = await openOutbox({ backend: createMemoryBackend(name) });
  const fresh = second.pluginStorage(item.id, "plugin-A");

  expect(await fresh.get("document-id")).toEqual({ providerId: "doc-xyz", pages: 3 });
  expect(await fresh.get("upload-handle")).toBe("handle-abc");
  expect(await fresh.keys()).toEqual(["document-id", "upload-handle"]);

  await second.close();
});

test("durability survives a sweep on a different capture — only the swept capture's entries are removed", async () => {
  const name = uniqueName();

  const outbox = await openOutbox({ backend: createMemoryBackend(name) });
  const session = await outbox.openSession({ ctx: { jobId: "job-1" }, ref: "job-1" });
  const item1 = await outbox.enqueue({ recording, audio: audioBlob(), sessionId: session.id });
  const item2 = await outbox.enqueue({ recording, audio: audioBlob(), sessionId: session.id });

  await outbox.pluginStorage(item1.id, "plugin-A").set("k", "keep");
  await outbox.pluginStorage(item2.id, "plugin-A").set("k", "drop");

  await outbox.remove(item2.id);
  await outbox.close();

  const reopened = await openOutbox({ backend: createMemoryBackend(name) });
  expect(await reopened.pluginStorage(item1.id, "plugin-A").get("k")).toBe("keep");
  expect(await reopened.pluginStorage(item2.id, "plugin-A").get("k")).toBeUndefined();
  await reopened.close();
});
