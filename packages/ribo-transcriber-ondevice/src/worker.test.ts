import { expect, test, vi } from "vitest";

import { WORKER_ENTRY_NAME, handleMessage, normalizeProgress } from "./worker.js";

// Node-side coverage of the worker's pure routing/normalization. It deliberately never drives the
// `prime` path here: that dynamic-imports `@huggingface/transformers`, whose node entry pulls the
// onnxruntime-node native addon (build script unrun) — priming for real is the opt-in browser run,
// not this gate.

test("exports its subpath name", () => {
  expect(WORKER_ENTRY_NAME).toBe("@azx/ribo-transcriber-ondevice/worker");
});

test("normalizeProgress maps transformers.js statuses to the wire type", () => {
  expect(normalizeProgress({ status: "initiate", file: "config.json" })).toEqual({
    stage: "initiate",
    file: "config.json",
  });
  expect(
    normalizeProgress({
      status: "progress",
      file: "model.onnx",
      loaded: 10,
      total: 40,
      progress: 25,
    }),
  ).toEqual({ stage: "progress", file: "model.onnx", loaded: 10, total: 40, progress: 25 });
  expect(normalizeProgress({ status: "done", file: "model.onnx" })).toEqual({
    stage: "done",
    file: "model.onnx",
  });
});

test("normalizeProgress drops pipeline-level statuses that carry no file", () => {
  // `ready` fires once the whole pipeline is built; it is not a per-file datum, so it is not relayed.
  expect(normalizeProgress({ status: "ready" })).toBeNull();
});

test("normalizeProgress defaults missing byte counts to zero", () => {
  expect(normalizeProgress({ status: "progress", file: "x" })).toEqual({
    stage: "progress",
    file: "x",
    loaded: 0,
    total: 0,
    progress: 0,
  });
});

test("handleMessage ignores non-prime messages without touching transformers", async () => {
  const post = vi.fn();
  // A message the worker does not understand is a no-op — no reply, no dynamic import.
  await handleMessage({ type: "unknown" } as never, post);
  expect(post).not.toHaveBeenCalled();
});
