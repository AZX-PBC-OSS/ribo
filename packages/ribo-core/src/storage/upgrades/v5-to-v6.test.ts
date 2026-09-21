import { expect, test } from "vitest";

import { captureV5ToV6Upgrade } from "./v5-to-v6.js";

test("captureV5ToV6Upgrade moves all six session-owned fields into legacy and clears them from top level", () => {
  const doc: Record<string, unknown> = {
    extracted: { foo: "bar" },
    extractedBy: "engine-v1",
    reviewOutcome: "accepted",
    writeResult: { instanceId: "inst-1" },
    writtenInstances: { "inst-1": [true, false] },
    idempotencyKey: "idem-123",
    status: "transcribed",
    recording: { ctx: { assessmentId: "a1" } },
  };

  const result = captureV5ToV6Upgrade(doc);

  expect(result.extracted).toBeUndefined();
  expect(result.extractedBy).toBeUndefined();
  expect(result.reviewOutcome).toBeUndefined();
  expect(result.writeResult).toBeUndefined();
  expect(result.writtenInstances).toBeUndefined();
  expect(result.idempotencyKey).toBeUndefined();

  const legacy = result.legacy as Record<string, unknown>;
  expect(legacy.extracted).toEqual({ foo: "bar" });
  expect(legacy.extractedBy).toBe("engine-v1");
  expect(legacy.reviewOutcome).toBe("accepted");
  expect(legacy.writeResult).toEqual({ instanceId: "inst-1" });
  expect(legacy.writtenInstances).toEqual({ "inst-1": [true, false] });
  expect(legacy.idempotencyKey).toBe("idem-123");
});

test("captureV5ToV6Upgrade remaps awaiting-review status to transcribed", () => {
  const doc: Record<string, unknown> = {
    status: "awaiting-review",
    recording: { ctx: { assessmentId: "a1" } },
  };

  const result = captureV5ToV6Upgrade(doc);

  expect(result.status).toBe("transcribed");
});

test("captureV5ToV6Upgrade derives sessionId from recording.ctx.assessmentId", () => {
  const doc: Record<string, unknown> = {
    status: "transcribed",
    recording: { ctx: { assessmentId: "a1" } },
  };

  const result = captureV5ToV6Upgrade(doc);

  expect(result.sessionId).toBe("migrated-session-a1");
});

// The regression test for the bug the function's own comment describes. The test
// above proves the id is read from `ctx`; this one proves it is NOT read from the
// recording, which is the half that actually failed. Reading the recording made
// `"assessmentId" in ctx` false for every row on a device, so all of them fell
// through to the singleton and one session swallowed every job the auditor had
// captured. Nothing threw — the only visible symptom was wrong grouping.
test("captureV5ToV6Upgrade falls through to the singleton when assessmentId is on the recording rather than its ctx", () => {
  const doc: Record<string, unknown> = {
    status: "transcribed",
    // `assessmentId` at the top level of the recording, where the buggy version
    // would have found nothing either — the point is that this shape must NOT
    // produce `migrated-session-a1`.
    recording: { assessmentId: "a1", ctx: { jobRef: "j1" } },
  };

  const result = captureV5ToV6Upgrade(doc);

  expect(result.sessionId).toBe("migrated-session-singleton");
});
