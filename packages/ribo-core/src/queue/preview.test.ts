import type { RxStorage } from "rxdb";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { afterEach, expect, test, vi } from "vitest";

import type { Recording } from "../recording.js";
import type { Transcript } from "../transcript.js";
import { removeOutboxDatabase } from "./database.js";
import { openOutbox, type Outbox } from "./outbox.js";

// The preview field and its handoff: two tests that each have an obvious version
// that passes against the bug they guard. Both are driven through the real
// `Outbox` class over an in-memory RxStorage, so they run in the node `unit`
// project without IndexedDB — the same seam `outbox-memory.test.ts` uses.

const opened: { outbox: Outbox; name: string; storage: RxStorage<unknown, unknown> }[] = [];

afterEach(async () => {
  for (const { outbox, name, storage } of opened.splice(0)) {
    if (!outbox.closed) await outbox.close();
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

const transcript: Transcript = {
  recordingId: recording.id,
  text: "the full transcript that replaces the preview",
  engine: "fake",
};

function freshOutbox(): Promise<Outbox> {
  const storage = getRxStorageMemory();
  const name = `ribo-outbox-preview-${crypto.randomUUID()}`;
  return openOutbox({ name, storage }).then((outbox) => {
    opened.push({ outbox, name, storage });
    return outbox;
  });
}

// ---------------------------------------------------------------------------
// Test A: a stale live reply after the transcript is written does not restore
// preview.
//
// The naive assertion — "`preview` and `transcript` are never both populated" —
// passes without the guard inside the append modifier, because `writeTranscript`
// already deleted `preview` when it wrote `transcript`. The race is a stale
// live reply arriving AFTER that deletion: without the guard, the append
// succeeds and `preview` comes back. This test calls `appendPreviewSegment` on
// a row whose transcript has already landed and asserts the preview did not
// come back.
// ---------------------------------------------------------------------------

test("a stale live reply after the transcript is written does not restore preview", async () => {
  const outbox = await freshOutbox();

  const item = await outbox.beginRecording({ recording, sourceId: "s1" });
  await outbox.appendPreviewSegment(item.id, "hello world");

  // The batch transcript lands — preview is deleted in the same modification.
  await outbox.writeTranscript(item.id, transcript, { status: "extracting", attempts: 0 });

  const afterWrite = await outbox.get(item.id);
  expect(afterWrite?.transcript).toBeDefined();
  expect(afterWrite?.preview).toBeUndefined();

  // A stale live reply arrives after the transcript has landed. The append
  // modifier must refuse — status is no longer "recording" and transcript
  // already exists — so preview is NOT restored.
  const result = await outbox.appendPreviewSegment(item.id, "late reply");
  expect(result).toBeUndefined();

  const afterLateReply = await outbox.get(item.id);
  expect(afterLateReply?.preview).toBeUndefined();
  expect(afterLateReply?.transcript).toBeDefined();
});

// ---------------------------------------------------------------------------
// Test B: deleting preview and writing transcript is ONE revision.
//
// Asserting on the final state passes against two separate writes, because the
// end state is identical either way. The difference is only visible to a
// subscriber mid-flight: transcript-then-delete shows final text beside stale
// provisional text; delete-then-transcript shows a row with neither. So this
// test subscribes before the write, collects every emission, and asserts (1)
// no emission shows a half-applied state and (2) only one emission arrived
// after the initial — two writes would produce two.
// ---------------------------------------------------------------------------

test("deleting preview and writing transcript is one revision — no half-applied state", async () => {
  const outbox = await freshOutbox();

  const item = await outbox.beginRecording({ recording, sourceId: "s1" });
  await outbox.appendPreviewSegment(item.id, "hello world");

  // Collect every emission a subscriber sees for this item.
  const emissions: { hasPreview: boolean; hasTranscript: boolean }[] = [];
  const subscription = outbox.watch().subscribe((items) => {
    const row = items.find((i) => i.id === item.id);
    if (row) {
      emissions.push({
        hasPreview: row.preview !== undefined,
        hasTranscript: row.transcript !== undefined,
      });
    }
  });

  try {
    // Wait for the initial emission: preview present, no transcript.
    await vi.waitFor(() => {
      expect(emissions.length).toBeGreaterThanOrEqual(1);
      expect(emissions.at(-1)).toEqual({ hasPreview: true, hasTranscript: false });
    });

    const initialCount = emissions.length;

    // Write the transcript — this must delete preview in the SAME modification.
    await outbox.writeTranscript(item.id, transcript, { status: "extracting", attempts: 0 });

    // Wait for the final state: no preview, transcript present.
    await vi.waitFor(() => {
      expect(emissions.at(-1)).toEqual({ hasPreview: false, hasTranscript: true });
    });

    // One revision means one emission after the initial. Two separate writes
    // would produce two — one carrying the transcript beside stale preview,
    // one with the preview gone.
    expect(emissions.length - initialCount).toBe(1);

    // No emission should show a half-applied state: both preview and transcript
    // populated at once. That is what a subscriber sees if the transcript write
    // and the preview deletion land in separate revisions.
    expect(emissions.every((e) => !(e.hasPreview && e.hasTranscript))).toBe(true);
  } finally {
    subscription.unsubscribe();
  }
});
