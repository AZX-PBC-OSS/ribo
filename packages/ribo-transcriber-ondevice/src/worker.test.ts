import { describe, expect, test, vi } from "vitest";

import { WHISPER_SAMPLE_RATE } from "./decode.js";
import {
  WORKER_ENTRY_NAME,
  clearLiveSessions,
  handleMessage,
  normalizeProgress,
  planChunks,
  serialize,
} from "./worker.js";

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

/**
 * The chunking DECISION TREE — which of the four routes a recording takes. The segmentation maths
 * itself is proved in `segmentation.test.ts`; what is proved here is the routing around it.
 *
 * Every case below is one where no model loads, which is what makes it testable in node at all: a
 * path that reached the VAD would dynamic-import transformers.js and pull `onnxruntime-node`, whose
 * native addon is not built. That constraint is also what makes the first test meaningful — see it.
 */
describe("planChunks — routing", () => {
  const base = { modelId: "m", wasmPaths: "/ort/" } as const;
  const thirtySeconds = 30 * WHISPER_SAMPLE_RATE;

  test("empty audio plans nothing", async () => {
    await expect(planChunks({ ...base, vadModelId: "v" }, new Float32Array(0))).resolves.toEqual(
      [],
    );
  });

  test("audio at or under 30 s bypasses VAD ENTIRELY — one chunk, no model loaded", async () => {
    // The bypass is proved by the absence of a crash. A VAD model id IS configured here, so if the
    // 30 s check ran after the VAD call rather than before it, this would dynamic-import
    // transformers.js and blow up on the unbuilt onnxruntime-node addon. Resolving cleanly is the
    // assertion: the overwhelmingly common short-clip case never touches VAD, and none of VAD's
    // deletion risk applies to it.
    const config = { ...base, vadModelId: "onnx-community/pyannote-segmentation-3.0" };
    await expect(planChunks(config, new Float32Array(11 * WHISPER_SAMPLE_RATE))).resolves.toEqual([
      { start: 0, end: 11 * WHISPER_SAMPLE_RATE },
    ]);
    await expect(planChunks(config, new Float32Array(thirtySeconds))).resolves.toEqual([
      { start: 0, end: thirtySeconds },
    ]);
  });

  test("over 30 s with no VAD configured falls back to the fixed-window march", async () => {
    // A consumer who never configured VAD — and, at runtime, the user whose ASR weights were cached
    // before VAD shipped. They must still get their whole recording, not the first 30 seconds.
    const chunks = await planChunks(base, new Float32Array(120 * WHISPER_SAMPLE_RATE));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks[chunks.length - 1]!.end).toBe(120 * WHISPER_SAMPLE_RATE);
    for (const chunk of chunks) expect(chunk.end - chunk.start).toBeLessThanOrEqual(thirtySeconds);
  });

  test("a VAD that will not load costs the user nothing — the march covers it", async () => {
    // `vadModelId` set but unloadable (the dynamic import fails in node). The catch must swallow it
    // and fall through, because a broken optional model must never turn into lost audio.
    const chunks = await planChunks(
      { ...base, vadModelId: "definitely/not-a-real-model" },
      new Float32Array(120 * WHISPER_SAMPLE_RATE),
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[chunks.length - 1]!.end).toBe(120 * WHISPER_SAMPLE_RATE);
  });
});

describe("serialize — one inference at a time", () => {
  test("concurrent work does not interleave", async () => {
    // `handleMessage` does not await one request before starting the next, and the main thread
    // explicitly supports several outstanding correlated requests — so without this queue two
    // transcribes would interleave `generate()` against the one shared ORT session. Long audio makes
    // that window much wider, since one request now issues many passes instead of one.
    const events: string[] = [];
    const task = (name: string) => async (): Promise<void> => {
      events.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`${name}:end`);
    };

    await Promise.all([serialize(task("a")), serialize(task("b")), serialize(task("c"))]);

    expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  test("a failed call does not poison the queue behind it", async () => {
    // The chain must absorb rejections, or one bad request would reject the shared promise and every
    // request queued after it would fail for a reason that has nothing to do with it.
    const failed = serialize(() => Promise.reject(new Error("boom")));
    await expect(failed).rejects.toThrow("boom");
    await expect(serialize(() => Promise.resolve("fine"))).resolves.toBe("fine");
  });
});

// `liveClose` and `liveFeed`-for-missing-session are safe to test in node: neither
// loads a model. `liveOpen` dynamic-imports `@huggingface/transformers` via
// `createSileroDetector` and is NOT tested here — that path is exercised by the
// manual browser test and the `live.test.ts` FakeWorker tests.

test("handleMessage for liveClose is a no-op that does not touch transformers", async () => {
  clearLiveSessions();
  const post = vi.fn();
  await handleMessage({ type: "liveClose", sessionId: "no-such-session" }, post);
  expect(post).not.toHaveBeenCalled();
});

test("handleMessage for liveFeed on a missing session is a silent no-op", async () => {
  clearLiveSessions();
  const post = vi.fn();
  await handleMessage(
    { type: "liveFeed", sessionId: "no-such-session", frame: new Float32Array(512) },
    post,
  );
  // The feed queues through `serialize`, so let the microtask settle before checking.
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(post).not.toHaveBeenCalled();
});
