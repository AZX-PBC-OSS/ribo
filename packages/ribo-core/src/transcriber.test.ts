import { expect, test } from "vitest";

import { isTransientFailure, TerminalQueueError } from "./queue/backoff.js";
import {
  isPermanentlyUnavailable,
  PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS,
  TRANSCRIBER_UNAVAILABLE_REASONS,
  TranscriberUnavailableError,
  type TranscriberCapability,
} from "./transcriber.js";

// The capability model, and the one thing it must never do: pretend that "this
// device cannot run this engine" and "this clip failed" are the same event.

test("the three capability states are expressible, and only those three", () => {
  const states: TranscriberCapability[] = [
    { status: "ready" },
    { status: "needs-download", downloadBytes: 165_000_000 },
    { status: "unavailable", reason: "unsupported-platform", detail: "no WebGPU on this device" },
  ];

  expect(states.map((state) => state.status)).toEqual(["ready", "needs-download", "unavailable"]);
});

test("an unavailable capability always carries a machine reason and a human detail", () => {
  const capability: TranscriberCapability = {
    status: "unavailable",
    reason: "offline",
    detail: "no network, and the managed endpoint needs one",
  };

  expect(TRANSCRIBER_UNAVAILABLE_REASONS).toContain(
    capability.status === "unavailable" && capability.reason,
  );
  expect(capability.status === "unavailable" && capability.detail.length).toBeGreaterThan(0);
});

test("permanence is a property of the reason, and only the device-shaped reasons are permanent", () => {
  expect([...PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS].sort()).toEqual([
    "too-slow",
    "unsupported-platform",
  ]);

  expect(
    isPermanentlyUnavailable({
      status: "unavailable",
      reason: "unsupported-platform",
      detail: "no WebGPU",
    }),
  ).toBe(true);
  // The uplink comes back; the model download succeeds next time; the endpoint
  // gets configured. None of these are facts about the hardware.
  expect(
    isPermanentlyUnavailable({ status: "unavailable", reason: "offline", detail: "no network" }),
  ).toBe(false);
  expect(isPermanentlyUnavailable({ status: "ready" })).toBe(false);
  expect(isPermanentlyUnavailable({ status: "needs-download", downloadBytes: 1 })).toBe(false);
});

test("a TranscriberUnavailableError names the engine, the reason and the detail", () => {
  const error = new TranscriberUnavailableError({
    engine: "ondevice-whisper",
    reason: "model-unavailable",
    detail: "weights fetch returned 404",
  });

  expect(error.engine).toBe("ondevice-whisper");
  expect(error.reason).toBe("model-unavailable");
  expect(error.detail).toBe("weights fetch returned 404");
  expect(error.name).toBe("TranscriberUnavailableError");
  expect(error.message).toContain("ondevice-whisper");
  expect(error.message).toContain("model-unavailable");
  expect(error.message).toContain("weights fetch returned 404");
});

test("the error carries the capability it implies, ready to be cached", () => {
  const error = new TranscriberUnavailableError({
    engine: "ondevice-whisper",
    reason: "unsupported-platform",
    detail: "WebGPU adapter request returned null",
  });

  expect(error.capability).toEqual({
    status: "unavailable",
    reason: "unsupported-platform",
    detail: "WebGPU adapter request returned null",
  });
});

// The alignment that matters: the queue's existing classifier already reads this
// correctly, and needed no change. A capability failure is retryable because the
// NEXT drain may route to a different engine.
test("a capability failure is transient to the queue — it is not a TerminalQueueError", () => {
  const error = new TranscriberUnavailableError({
    engine: "managed-azure",
    reason: "offline",
    detail: "fetch failed",
  });

  expect(error).not.toBeInstanceOf(TerminalQueueError);
  expect(isTransientFailure(error)).toBe(true);
});

test("an attempt failure stays whatever the queue already thought it was", () => {
  // One clip OOMs. Nothing about the device changed, so nothing here changes.
  expect(isTransientFailure(new Error("out of memory decoding clip"))).toBe(true);
  expect(isTransientFailure(new TerminalQueueError("audio attachment is missing"))).toBe(false);
  expect(isTransientFailure(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false);
});
