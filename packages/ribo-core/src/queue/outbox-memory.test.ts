import type { RxStorage } from "rxdb";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { afterEach, expect, test } from "vitest";

import type { Recording } from "../recording.js";
import { removeOutboxDatabase } from "./database.js";
import { openOutbox, type Outbox } from "./outbox.js";

// The storage-injection seam, proven with a non-Dexie engine.
//
// This opens the outbox over RxDB's in-memory RxStorage and drives the ordinary
// public API through it — enqueue, then read the item and its audio back. That a
// storage engine which is not Dexie satisfies the same `Outbox` unchanged is the
// whole point of the `storage` option on `OpenOutboxOptions`.
//
// It is a node `unit` test on purpose: memory storage needs no IndexedDB, which
// is exactly the value of the seam — tests get a fast, browser-free engine while
// production keeps Dexie. And it deliberately does NOT stand in for the
// durability test in `outbox.browser.test.ts`: memory storage would fake the
// very "survives being physically written to disk" property that test exists to
// prove, so that one stays on real IndexedDB via Dexie.

const opened: { outbox: Outbox; name: string; storage: RxStorage<unknown, unknown> }[] = [];

afterEach(async () => {
  for (const { outbox, name, storage } of opened.splice(0)) {
    if (!outbox.closed) await outbox.close();
    // Removal must go through the same storage the database was opened with.
    await removeOutboxDatabase(name, storage);
  }
});

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  durationMs: 4200,
  mimeType: "audio/webm;codecs=opus",
  ctx: { jobId: "job-7" },
};

const audioBytes = new Uint8Array(2048).map((_, i) => (i * 31 + 7) % 256);

function audioBlob(): Blob {
  return new Blob([audioBytes], { type: "audio/webm;codecs=opus" });
}

test("an injected non-Dexie (memory) RxStorage drives the same Outbox API", async () => {
  const storage = getRxStorageMemory();
  const name = `ribo-outbox-memory-${crypto.randomUUID()}`;

  const outbox = await openOutbox({ name, storage });
  opened.push({ outbox, name, storage });

  const enqueued = await outbox.enqueue({ recording, audio: audioBlob() });

  // Same projection contract the Dexie-backed tests assert.
  expect(enqueued.status).toBe("queued");
  expect(enqueued.hasAudio).toBe(true);
  expect(enqueued.audioBytes).toBe(audioBytes.byteLength);

  // Read the item back through the public API — off the injected engine, in a
  // node process with no IndexedDB at all.
  const read = await outbox.get(enqueued.id);
  expect(read).toEqual(enqueued);
  expect((await outbox.list()).map((item) => item.id)).toEqual([enqueued.id]);

  // The bytes round-trip through the injected engine unchanged.
  const audio = await outbox.getAudio(enqueued.id);
  expect(audio).toBeInstanceOf(Blob);
  expect(new Uint8Array(await audio!.arrayBuffer())).toEqual(audioBytes);
});
