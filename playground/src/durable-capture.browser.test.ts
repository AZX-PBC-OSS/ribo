import { expect, test } from "vitest";

import { getOutbox } from "./outbox-handle.js";
import { getRecorder } from "./recorder-handle.js";

/**
 * @file Does this app actually record durably?
 *
 * Every durable-capture test in `ribo-core` builds its own recorder and hands it
 * a `captureSession` factory, which means all of them pass whether or not any
 * host ever supplies one. For a while none did: `openCaptureSession` and
 * `recoverInterrupted` were exported, covered, and called from nothing but their
 * own tests, while the playground constructed a bare `new Recorder()` and took
 * the in-memory path. The feature was fully tested and entirely off.
 *
 * So this file deliberately imports the app's own module singletons rather than
 * constructing anything. `getRecorder()` is the unit under test — not the
 * `Recorder` class, which is already covered, but *this app's configuration of
 * it*. Delete the `captureSession` factory from `recorder-handle.ts` and the
 * assertions below fail; nothing else in the repo would notice.
 *
 * It uses the real default outbox (`ribo-outbox`) for the same reason: naming a
 * test-only database here would test a wiring the app does not have.
 */

/** Long enough for `MediaRecorder` to produce a frame or two of fake-device audio. */
const RECORD_MS = 400;

/** Polls `read` until it returns a value, or fails the test on timeout. */
async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("the playground records durably: one row, live from start(), committed by stop()", async () => {
  const outbox = await getOutbox();
  await outbox.clear();
  const recorder = getRecorder();

  await recorder.start(crypto.randomUUID());

  // A `recording` row exists BEFORE stop(). This is the whole claim: audio is
  // reaching disk during capture, not handed over in one blob at the end. A
  // non-durable recorder writes nothing until stop(), so this wait is what fails
  // when the factory is missing — not some assertion about the final row, which
  // an in-memory capture also satisfies.
  const live = await until(async () => {
    const [item] = await outbox.list({ status: ["recording"] });
    return item;
  }, "a recording row");
  expect(live.capture?.sourceId).toBeTypeOf("string");

  await new Promise((resolve) => setTimeout(resolve, RECORD_MS));
  const capture = await recorder.stop();

  // The SAME row, committed — not a second one. `stop()` returning the id it was
  // already committed to is what stops `useRecorder` enqueuing a duplicate, and
  // an id mismatch here is the bug where callers got metadata describing a
  // different recording than the bytes on disk.
  expect(capture.itemId).toBe(live.id);

  const committed = await until(async () => {
    const item = await outbox.get(live.id);
    return item?.status === "queued" ? item : undefined;
  }, "the row to reach queued");
  expect(committed.audioReady).toBe(true);
  expect(committed.audioBytes).toBeGreaterThan(0);

  // One dictation, one row. Two would mean the hook enqueued a capture that had
  // already committed itself.
  expect(await outbox.list({})).toHaveLength(1);

  await outbox.clear();
});
