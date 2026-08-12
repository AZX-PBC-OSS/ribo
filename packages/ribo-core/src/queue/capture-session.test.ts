import { expect, test, vi } from "vitest";
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
      // A REAL macrotask, not a resolved promise. With a synchronous fake the whole
      // pipeline settles inside one microtask drain, so a single-queue implementation
      // never has an in-flight write for `finalize()` to wait behind — the deadlock this
      // split exists to prevent cannot manifest, and the test passes either way.
      // Verified: with an instant fake, collapsing ingestion and persistence into one
      // queue left this suite green.
      await new Promise((resolve) => setTimeout(resolve, 5));
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
  // `finalize()` is called with writes still in flight — the exact moment a single queue
  // deadlocks, because finalization would be queued behind operations that are waiting on
  // finalization. Resolving at all is the assertion; vitest's own timeout is what fails.
  const done = session.finalize();
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

test("an ONGOING stall is reported without waiting for the next event", async () => {
  // The gap check in `ingest` only runs when a blob arrives, so a stall in progress was
  // invisible: a visible tab whose recorder had quietly died reported `flushing`
  // indefinitely, and `workSafety` said `protected` while nothing was reaching disk.
  // Emission stopping is precisely what prevents the code that notices emission stopping
  // from running, so the check cannot live only on that path.
  vi.useFakeTimers();
  try {
    let clock = 0;
    const session = await openCaptureSession({
      outbox: fakeOutbox() as unknown as Outbox,
      recording,
      sourceId: "s1",
      mimeType: "audio/webm",
      now: () => clock,
      decode: async () => 4200,
    });
    session.ingest(blobOf(10));
    expect(await firstValueFrom(session.health$)).toBe("flushing");

    // Time passes and NOTHING arrives — the pocketed-phone case.
    clock = 60_000;
    await vi.advanceTimersByTimeAsync(31_000);

    // Reported now, not retroactively once some later blob shows up.
    expect(await firstValueFrom(session.health$)).toBe("stalled");
    session.abort();
  } finally {
    vi.useRealTimers();
  }
});

test("an oversized blob is ONE chunk in several slices, not several chunks", async () => {
  // `sliceIndex` was hardcoded to 0 while the chunk index advanced per slice, so a sliced
  // event looked like several separate events and the `-NN` slice field stayed `00`
  // forever. Ordering survived either way, which is why nothing caught it — but the
  // naming no longer described what it names.
  const outbox = fakeOutbox();
  const session = await openCaptureSession({
    outbox: outbox as unknown as Outbox,
    recording,
    sourceId: "s1",
    mimeType: "audio/webm",
    now: () => 0,
    decode: async () => 4200,
  });
  // Comfortably past MAX_CHUNK_BYTES so it must be cut into more than one slice.
  session.ingest(blobOf(12 * 1024 * 1024));
  await session.finalize();

  expect(outbox.chunkNames.length).toBeGreaterThan(1);
  // One chunk index across every slice, and the slice index actually counting.
  const parsed = outbox.chunkNames.map((n) => n.split("-").slice(-2));
  expect(new Set(parsed.map(([chunk]) => chunk)).size).toBe(1);
  expect(parsed.map(([, slice]) => slice)).toEqual(
    parsed.map((_, i) => String(i).padStart(2, "0")),
  );
});
