import { expect, test } from "vitest";

import { CAPTURE_LOCK, holdLock, isLockFree } from "./capture-lock.js";

test("only one holder at a time, proven with a barrier", async () => {
  // A SEQUENTIAL test proves nothing about the race: the point is that the second
  // request arrives while the first is still inside its callback.
  let releaseFirst!: () => void;
  const first = await holdLock(
    "t",
    () => new Promise<string>((r) => (releaseFirst = () => r("a"))),
  );
  expect(first).toBeDefined();
  const second = await holdLock("t", () => Promise.resolve("b"));
  expect(second).toBeUndefined(); // refused, not queued
  releaseFirst();
  await first!.ready;
});

test("start resolves before the lock does — otherwise start() never returns", async () => {
  let releaseIt!: () => void;
  const held = await holdLock(
    "t2",
    () => new Promise<string>((r) => (releaseIt = () => r("done"))),
  );
  // The two-promise handshake: `holdLock` resolved while the lock callback is
  // still pending. Awaiting locks.request() directly would block for the whole
  // recording, which is the shape bug this test exists to pin.
  expect(held).toBeDefined();
  releaseIt();
  await expect(held!.ready).resolves.toBe("done");
});

test("a released lock is available again", async () => {
  const held = await holdLock("t3", () => Promise.resolve(1));
  await held!.ready;
  await held!.released;
  expect(await isLockFree("t3")).toBe(true);
});

test("CAPTURE_LOCK is a stable string", () => {
  expect(typeof CAPTURE_LOCK).toBe("string");
  expect(CAPTURE_LOCK.length).toBeGreaterThan(0);
});
