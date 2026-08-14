import type { RxStorage } from "rxdb";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { afterEach, expect, test, vi } from "vitest";

import type { Recording } from "../recording.js";
import type { Transcript } from "../transcript.js";
import { removeOutboxDatabase } from "./database.js";
import { openOutbox, type Outbox } from "./outbox.js";

// The preview field, its committed+tail shape, and its handoff. Tests 3 and 4
// each have an obvious version that passes against the bug they guard, and are
// driven through the real `Outbox` class over an in-memory RxStorage, so they
// run in the node `unit` project without IndexedDB — the same seam
// `outbox-memory.test.ts` uses.

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
// Test 1: a tail write REPLACES the previous tail, it does not append.
//
// The obvious version that passes against the bug: assert `tail` is a string
// containing the second write's text. That holds whether the implementation
// replaces or appends ("first second" contains "second"), so the assertion
// must be exact — `tail === "second"` — which an appending implementation
// (producing "first second" or ["first", "second"]) fails.
// ---------------------------------------------------------------------------

test("a tail write replaces the previous tail rather than appending to it", async () => {
  const outbox = await freshOutbox();

  const item = await outbox.beginRecording({ recording, sourceId: "s1" });

  await outbox.writePreviewTail(item.id, "first");
  const first = await outbox.get(item.id);
  expect(first?.preview).toEqual({ committed: [], tail: "first" });

  // A second tail write must overwrite, not accumulate.
  await outbox.writePreviewTail(item.id, "second");
  const second = await outbox.get(item.id);
  expect(second?.preview).toEqual({ committed: [], tail: "second" });
  expect(second?.preview?.tail).toBe("second");
});

// ---------------------------------------------------------------------------
// Test 2: a commit appends to `committed` and clears the tail in ONE
// modification — no subscriber ever sees the text in both places, or in neither.
//
// Asserting only on the final state passes against two separate writes, because
// the end state is identical either way. The difference is only visible to a
// subscriber mid-flight: append-then-clear shows the text in both `committed`
// and `tail` at once; clear-then-append shows it in neither. So this test
// subscribes before the commit, collects every emission, and asserts (1) only
// one emission arrived after the initial and (2) no emission shows the text in
// both places or in neither.
// ---------------------------------------------------------------------------

test("a commit appends to committed and clears the tail in one modification", async () => {
  const outbox = await freshOutbox();

  const item = await outbox.beginRecording({ recording, sourceId: "s1" });
  // Seed a tail so the commit has something to clear — a commit with no prior
  // tail would not exercise the "both" intermediate.
  await outbox.writePreviewTail(item.id, "alpha");

  // `alpha` is the text being committed. Track where it appears in each emission.
  const emissions: { inCommitted: boolean; inTail: boolean }[] = [];
  const subscription = outbox.watch().subscribe((items) => {
    const row = items.find((i) => i.id === item.id);
    if (row) {
      emissions.push({
        inCommitted: row.preview?.committed?.includes("alpha") ?? false,
        inTail: row.preview?.tail === "alpha",
      });
    }
  });

  try {
    // Wait for the initial emission: tail present, committed empty.
    await vi.waitFor(() => {
      expect(emissions.length).toBeGreaterThanOrEqual(1);
      expect(emissions.at(-1)).toEqual({ inCommitted: false, inTail: true });
    });

    const initialCount = emissions.length;

    // Commit — this must append to `committed` and clear `tail` in the SAME
    // modification.
    await outbox.commitPreview(item.id, "alpha");

    // Wait for the final state: text in committed, tail gone.
    await vi.waitFor(() => {
      expect(emissions.at(-1)).toEqual({ inCommitted: true, inTail: false });
    });

    // One modification means one emission after the initial. Two separate writes
    // would produce two — one carrying the text in both places (append-then-
    // clear), or one with it in neither (clear-then-append).
    expect(emissions.length - initialCount).toBe(1);

    // No emission should show the text in both places at once — the
    // append-then-clear split.
    expect(emissions.every((e) => !(e.inCommitted && e.inTail))).toBe(true);

    // No emission should show the text in neither place — the clear-then-append
    // split. (The initial state has it in `tail`, so it is not "neither"; only
    // a cleared-but-not-yet-appended intermediate is.)
    expect(emissions.every((e) => e.inCommitted || e.inTail)).toBe(true);
  } finally {
    subscription.unsubscribe();
  }

  const settled = await outbox.get(item.id);
  expect(settled?.preview).toEqual({ committed: ["alpha"] });
});

// ---------------------------------------------------------------------------
// Test 3: writes are refused once the row leaves `recording` or once
// `transcript` exists. A stale live reply must not restore `preview`.
//
// The naive assertion — "`preview` and `transcript` are never both populated" —
// passes without the guard inside the write modifier, because `writeTranscript`
// already deleted `preview` when it wrote `transcript`. The race is a stale
// live reply arriving AFTER that deletion: without the guard, the write
// succeeds and `preview` comes back. This test calls the preview writers on a
// row whose transcript has already landed and asserts the preview did not come
// back. It also covers the other clause of the guard — a reply after the row
// leaves `recording` with NO transcript — by committing the recording to
// `queued` first.
// ---------------------------------------------------------------------------

test("a stale live reply after the transcript is written does not restore preview", async () => {
  const outbox = await freshOutbox();

  const item = await outbox.beginRecording({ recording, sourceId: "s1" });
  await outbox.writePreviewTail(item.id, "hello world");

  // The batch transcript lands — preview is deleted in the same modification.
  await outbox.writeTranscript(item.id, transcript, { status: "extracting", attempts: 0 });

  const afterWrite = await outbox.get(item.id);
  expect(afterWrite?.transcript).toBeDefined();
  expect(afterWrite?.preview).toBeUndefined();

  // A stale tail reply arrives after the transcript has landed. The write
  // modifier must refuse — status is no longer "recording" and transcript
  // already exists — so preview is NOT restored.
  const tailResult = await outbox.writePreviewTail(item.id, "late tail");
  expect(tailResult).toBeUndefined();

  // A stale commit reply is refused for the same reason.
  const commitResult = await outbox.commitPreview(item.id, "late commit");
  expect(commitResult).toBeUndefined();

  const afterLateReply = await outbox.get(item.id);
  expect(afterLateReply?.preview).toBeUndefined();
  expect(afterLateReply?.transcript).toBeDefined();
});

test("a live reply after the row leaves recording (but before any transcript) is refused", async () => {
  const outbox = await freshOutbox();

  const item = await outbox.beginRecording({ recording, sourceId: "s1" });
  await outbox.writePreviewTail(item.id, "hello world");

  // Commit the durable recording: recording → queued. There is no transcript
  // yet, so this exercises the `status !== "recording"` clause of the guard on
  // its own — distinct from the transcript-landed case above, where both
  // clauses are true. `commitRecording` is not the handoff, so the preview
  // seeded above is still on the row; the point is that a reply arriving NOW
  // must not change it, not that it is gone (the batch handoff deletes it).
  const audio = new Blob([new Uint8Array([0])], { type: "audio/webm" });
  await outbox.commitRecording(item.id, audio, 100);
  const committed = await outbox.get(item.id);
  expect(committed?.status).toBe("queued");
  expect(committed?.transcript).toBeUndefined();

  // A live reply arriving after the row left `recording` must be refused, even
  // though no transcript exists yet.
  expect(await outbox.writePreviewTail(item.id, "late tail")).toBeUndefined();
  expect(await outbox.commitPreview(item.id, "late commit")).toBeUndefined();

  // The existing preview is untouched — the refusal left it as it was.
  const afterReply = await outbox.get(item.id);
  expect(afterReply?.preview).toEqual({ committed: [], tail: "hello world" });
});

// ---------------------------------------------------------------------------
// Test 4: deleting preview and writing transcript is ONE revision.
//
// Asserting on the final state passes against two separate writes, because the
// end state is identical either way. The difference is only visible to a
// subscriber mid-flight: transcript-then-delete shows final text beside stale
// provisional text; delete-then-transcript shows a row with neither, which
// looks like a failed transcription. So this test subscribes before the write,
// collects every emission, and asserts (1) no emission shows a half-applied
// state and (2) only one emission arrived after the initial — two writes would
// produce two.
// ---------------------------------------------------------------------------

test("deleting preview and writing transcript is one revision — no half-applied state", async () => {
  const outbox = await freshOutbox();

  const item = await outbox.beginRecording({ recording, sourceId: "s1" });
  await outbox.writePreviewTail(item.id, "hello world");

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
