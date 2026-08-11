import { expect, test } from "vitest";
import { firstValueFrom } from "rxjs";

import { openCaptureSession } from "./capture-session.js";
import type { Outbox } from "./outbox.js";
import type { OutboxItem } from "./schema.js";
import type { Recording } from "../recording.js";

const recording: Recording = {
  id: "rec-1",
  capturedAt: "2026-07-23T10:00:00.000Z",
  durationMs: 0,
  mimeType: "audio/webm",
  ctx: {},
};

/** A fake outbox that records calls and never blocks. */
function fakeOutbox(): Pick<
  Outbox,
  "beginRecording" | "appendChunk" | "mergeChunks" | "commitRecording" | "remove"
> & {
  chunkNames: string[];
} {
  const chunkNames: string[] = [];
  return {
    chunkNames,
    async beginRecording({ sourceId }: { recording: Recording; sourceId: string }) {
      return {
        id: "item-1",
        seq: 0,
        status: "recording",
        idempotencyKey: "k",
        attempts: 0,
        nextAttemptAt: "2026-07-23T10:00:00.000Z",
        enqueuedAt: "2026-07-23T10:00:00.000Z",
        recording,
        capture: { sourceId },
        audioReady: false,
        audioBytes: 0,
      } satisfies OutboxItem;
    },
    async appendChunk(_id: string, name: string, _blob: Blob) {
      chunkNames.push(name);
    },
    async mergeChunks(_id: string) {
      return new Blob(
        chunkNames.map(() => new Uint8Array([1])),
        { type: "audio/webm" },
      );
    },
    async commitRecording(_id: string, _audio: Blob, durationMs: number) {
      return {
        id: "item-1",
        seq: 0,
        status: "queued",
        idempotencyKey: "k",
        attempts: 0,
        nextAttemptAt: "2026-07-23T10:00:00.000Z",
        enqueuedAt: "2026-07-23T10:00:00.000Z",
        recording: { ...recording, durationMs },
        audioReady: true,
        audioBytes: 1,
      } satisfies OutboxItem;
    },
    async remove(_id: string) {},
  };
}

function blobOf(size: number): Blob {
  return new Blob([new Uint8Array(size)], { type: "audio/webm" });
}

test("ingestion is synchronous and persistence is a separate stage", async () => {
  // ONE queue deadlocks: a chunk op that detects a write failure must finalize,
  // but the final dataavailable may already be queued BEHIND it — so awaiting
  // finalization waits on an operation that waits on it.
  const session = await openCaptureSession({
    outbox: fakeOutbox() as unknown as Outbox,
    recording,
    sourceId: "s1",
    mimeType: "audio/webm",
    now: () => 0,
    decode: async () => 4200,
  });
  session.ingest(blobOf(10));
  session.ingest(blobOf(10));
  const done = session.finalize(); // must not hang
  await expect(done).resolves.toMatchObject({ durationMs: expect.any(Number) });
});

test("finalize drains everything ingested before it", async () => {
  const outbox = fakeOutbox();
  const session = await openCaptureSession({
    outbox: outbox as unknown as Outbox,
    recording,
    sourceId: "s1",
    mimeType: "audio/webm",
    now: () => 0,
    decode: async () => 4200,
  });
  session.ingest(blobOf(10));
  session.ingest(blobOf(10));
  await session.finalize();
  expect(outbox.chunkNames).toHaveLength(2); // the last chunk is not dropped
});

test("a stall is observed even when the late event arrives before the detector runs", async () => {
  // The detector is frozen alongside the page it watches, so a timer cannot fire
  // while backgrounded. The dataavailable handler must compute now - lastEmission
  // BEFORE updating it, or the stall is never seen at all.
  let t = 0;
  const session = await openCaptureSession({
    outbox: fakeOutbox() as unknown as Outbox,
    recording,
    sourceId: "s1",
    mimeType: "audio/webm",
    now: () => t,
  });
  session.ingest(blobOf(10));
  t = 60_000;
  session.ingest(blobOf(10)); // the late event
  expect(await firstValueFrom(session.health$)).toBe("stalled");
});

test("a user pause is not a stall", async () => {
  let t = 0;
  const session = await openCaptureSession({
    outbox: fakeOutbox() as unknown as Outbox,
    recording,
    sourceId: "s1",
    mimeType: "audio/webm",
    now: () => t,
  });
  session.ingest(blobOf(10));
  t = 60_000;
  session.resumed(); // user-initiated Recorder.resume()
  session.ingest(blobOf(10));
  expect(await firstValueFrom(session.health$)).toBe("flushing");
});
