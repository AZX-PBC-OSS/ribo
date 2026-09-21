import { createMemoryBackend } from "./memory-backend.js";
import { expect, test } from "vitest";

import { openStorage, type Storage } from "./storage.js";
import { chunkName } from "./chunk-names.js";
import { CAPTURE_LOCK, holdLock } from "./capture-lock.js";
import { recoverInterrupted } from "./recovery.js";
import type { Recording } from "../capture/recording.js";

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  kind: "audio",
  durationMs: 0,
  mimeType: "audio/webm",
  ctx: {},
};

/** Plant a `recording` row with N chunk attachments, simulating a crash. */
async function plantInterrupted(
  storage: Storage,
  sourceId: string,
  chunks: number,
  truncateLast = false,
): Promise<string> {
  const item = await storage.captures.beginRecording({
    recording,
    sourceId,
    sessionId: "test-session",
  });
  for (let i = 0; i < chunks; i++) {
    const isLast = i === chunks - 1;
    const bytes =
      isLast && truncateLast ? new Uint8Array([0, 0, 0, 0]) : new Uint8Array(2048).fill(42);
    await storage.captures.appendChunk(
      item.id,
      chunkName(sourceId, i, 0),
      new Blob([bytes], { type: "audio/webm" }),
    );
  }
  return item.id;
}

/** A decode that always succeeds and returns a fixed duration. */
const okDecode = async (_blob: Blob): Promise<number> => 4200;

/** A decode that always fails. */
const alwaysFails = async (_blob: Blob): Promise<number> => {
  throw new Error("unrecoverable: cannot decode");
};

/** A decode that fails on the full blob but succeeds if the last chunk is dropped. */
const failsUnlessLastDropped = {
  calls: 0,
  async decode(_blob: Blob): Promise<number> {
    this.calls += 1;
    // First call (full blob) fails; second call (blob without last chunk) succeeds.
    if (this.calls === 1) throw new Error("truncated tail");
    return 3800;
  },
};

test("recovery produces a complete new queued row and marks the original dead", async () => {
  const storage = await openStorage({
    backend: createMemoryBackend(`ribo-recovery-${crypto.randomUUID()}`),
  });
  try {
    const id = await plantInterrupted(storage, "s1", 3);
    const recovered = await recoverInterrupted({
      storage,
      decode: okDecode,
      onRecovered: () => undefined,
    });
    expect(recovered).toHaveLength(1);
    const newRow = await storage.captures.get(recovered[0]!);
    expect(newRow).toBeDefined();
    expect(newRow!.status).toBe("queued");
    expect(newRow!.audioReady).toBe(true);
    expect(newRow!.audioBytes).toBeGreaterThan(0);
    expect(newRow!.recording.id).toBe(recording.id);
    expect(newRow!.id).not.toBe(id); // a NEW row, not the original
    // The original is dead, with a reason naming its successor.
    const original = await storage.captures.get(id);
    expect(original!.status).toBe("dead");
    expect(original!.lastError).toMatch(new RegExp(recovered[0]!));
  } finally {
    await storage.close();
  }
});

test("undecodable audio leaves the original dead with chunks intact", async () => {
  const storage = await openStorage({
    backend: createMemoryBackend(`ribo-recovery-${crypto.randomUUID()}`),
  });
  try {
    const id = await plantInterrupted(storage, "s1", 2);
    await recoverInterrupted({ storage, decode: alwaysFails, onRecovered: () => undefined });
    const original = await storage.captures.get(id);
    expect(original!.status).toBe("dead");
    expect(original!.lastError).toMatch(/unrecoverable|cannot decode/i);
    // Chunks are NOT swept — never silently discard bytes.
    const audio = await storage.captures.getAudio(id);
    expect(audio).toBeUndefined(); // no canonical audio on a dead row
    // But the chunk attachments are still there (mergeChunks would find them).
    const merged = await storage.captures.mergeChunks(id);
    expect(merged.size).toBeGreaterThan(0);
  } finally {
    await storage.close();
  }
});

test("a truncated final chunk recovers by dropping it", async () => {
  const storage = await openStorage({
    backend: createMemoryBackend(`ribo-recovery-${crypto.randomUUID()}`),
  });
  try {
    const _id = await plantInterrupted(storage, "s1", 3, true);
    const decoder = failsUnlessLastDropped;
    const recovered = await recoverInterrupted({
      storage,
      decode: decoder.decode.bind(decoder),
      onRecovered: () => undefined,
    });
    expect(recovered).toHaveLength(1);
    const newRow = await storage.captures.get(recovered[0]!);
    expect(newRow!.status).toBe("queued");
    expect(newRow!.audioReady).toBe(true);
  } finally {
    await storage.close();
  }
});

test("recovery does nothing when the lock is held — a live session owns it", async () => {
  const storage = await openStorage({
    backend: createMemoryBackend(`ribo-recovery-${crypto.randomUUID()}`),
  });
  try {
    await plantInterrupted(storage, "s1", 2);
    // Hold the capture lock — simulating a live recording in another tab.
    const release = await holdLock(CAPTURE_LOCK, () => new Promise<void>(() => {}));
    expect(release).toBeDefined();
    const recovered = await recoverInterrupted({
      storage,
      decode: okDecode,
      onRecovered: () => undefined,
    });
    expect(recovered).toEqual([]); // nothing recovered — the row is left alone
    release!.ready.catch(() => undefined); // don't let it reject unhandled
  } finally {
    await storage.close();
  }
});

test("recovery with no interrupted rows returns empty", async () => {
  const storage = await openStorage({
    backend: createMemoryBackend(`ribo-recovery-${crypto.randomUUID()}`),
  });
  try {
    const recovered = await recoverInterrupted({
      storage,
      decode: okDecode,
      onRecovered: () => undefined,
    });
    expect(recovered).toEqual([]);
  } finally {
    await storage.close();
  }
});
