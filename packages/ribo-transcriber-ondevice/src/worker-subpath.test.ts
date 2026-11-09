import { expect, test, vi } from "vitest";

import { handleMessage } from "@azx/ribo-transcriber-ondevice/worker";
import type { TranscribeWorkerRequest } from "@azx/ribo-transcriber-ondevice/worker";

// Characterisation of the published `./worker` subpath, imported by package name rather than by
// relative path, so a change to what the subpath barrel re-exports (or a broken export condition)
// fails here instead of only at a consumer. The routing behaviour below is covered in depth by
// `worker.test.ts` against the implementation module; this file pins that the SAME behaviour is
// reachable through the public entry point that host apps construct their worker from.

test("the worker subpath exports the message handler", () => {
  expect(typeof handleMessage).toBe("function");
});

test("a cancelTranscribe for an id that never existed posts nothing and throws nothing", async () => {
  // An unknown id is a request that already settled (or never existed): marking it would leak a
  // registry entry, so the handler must ignore it silently. Pinned through the public subpath.
  const post = vi.fn<(message: unknown) => void>();
  await expect(
    handleMessage({ type: "cancelTranscribe", requestId: "no-such-request" }, post),
  ).resolves.toBeUndefined();
  expect(post).not.toHaveBeenCalled();
});

test("a TranscribeWorkerRequest still shapes as samples plus an optional prompt", () => {
  // Type-level pin: the request type the subpath re-exports stays constructible from the two
  // fields the main-thread half sends. Assigned to force every field through the checker.
  const request: TranscribeWorkerRequest = { samples: new Float32Array(0) };
  expect(request.prompt).toBeUndefined();
});
