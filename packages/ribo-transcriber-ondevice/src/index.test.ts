import { expect, test, vi } from "vitest";

import type { Transcriber } from "@azx/ribo-core";

import { buildHintPrompt, ONDEVICE_WHISPER_ENGINE, OnDeviceTranscriber } from "./index.js";
import { TRANSFORMERS_CACHE_NAME } from "./model-cache.js";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./protocol.js";

// Task 2 gated coverage. All of it is deterministic and offline: the worker and the Cache API are
// doubled, so this proves the progress-relay plumbing and the needs-download/ready logic without
// downloading a single byte. The real-model download that exercises the same path end to end is an
// opt-in run (`vitest.manual.config.ts`), NOT part of this gate — that would be a 165 MB network
// dependency masquerading as a check.

const WASM_PATHS = "/ort/";

/** Minimal CacheStorage double keyed the way transformers.js keys `transformers-cache`. */
function fakeCacheStorage(urls: string[] = []): CacheStorage {
  const has = urls.length > 0;
  return {
    has: (name: string) => Promise.resolve(has && name === TRANSFORMERS_CACHE_NAME),
    open: () =>
      Promise.resolve({
        keys: () => Promise.resolve(urls.map((url) => ({ url }) as Request)),
      } as unknown as Cache),
  } as unknown as CacheStorage;
}

const weightUrl = (model: string) =>
  `https://huggingface.co/${model}/resolve/main/onnx/encoder_model_quantized.onnx`;

/** Scriptable Web Worker double: replies to a `prime` postMessage with a canned message sequence. */
class FakeWorker {
  readonly posted: MainToWorkerMessage[] = [];
  terminated = false;
  readonly #listeners: Record<string, Set<(event: unknown) => void>> = {
    message: new Set(),
    error: new Set(),
  };

  constructor(
    /** Given the prime command, produce the worker→main messages to emit (in order). */
    private readonly reply: (command: MainToWorkerMessage) => WorkerToMainMessage[],
  ) {}

  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.#listeners[type]?.add(fn);
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.#listeners[type]?.delete(fn);
  }
  postMessage(command: MainToWorkerMessage): void {
    this.posted.push(command);
    queueMicrotask(() => {
      for (const message of this.reply(command)) {
        this.#emit("message", { data: message });
      }
    });
  }
  terminate(): void {
    this.terminated = true;
  }
  #emit(type: string, event: unknown): void {
    for (const fn of this.#listeners[type] ?? []) fn(event);
  }
}

test("is a ribo-core Transcriber substitutable for FakeTranscriber", () => {
  const transcriber: Transcriber = new OnDeviceTranscriber({ wasmPaths: WASM_PATHS });
  expect(transcriber.engine).toBe(ONDEVICE_WHISPER_ENGINE);
  expect(ONDEVICE_WHISPER_ENGINE).toBe("ondevice-whisper");
});

test("capability is unavailable/unsupported-platform when there is no Cache API", async () => {
  const transcriber = new OnDeviceTranscriber({ wasmPaths: WASM_PATHS, cacheStorage: undefined });
  // node has no `caches` global; without an injected one the probe reports the honest permanent
  // verdict — no cache means no offline model, which is the whole premise.
  const capability = await transcriber.capability();
  expect(capability.status).toBe("unavailable");
  if (capability.status === "unavailable") {
    expect(capability.reason).toBe("unsupported-platform");
    expect(capability.detail).not.toBe("");
  }
});

test("capability is needs-download when the model is not cached, carrying byte estimate", async () => {
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    cacheStorage: fakeCacheStorage([]),
  });
  const capability = await transcriber.capability();
  expect(capability.status).toBe("needs-download");
  if (capability.status === "needs-download") {
    expect(capability.downloadBytes).toBeGreaterThan(0);
    expect(capability.detail).toBe("Xenova/whisper-base.en");
  }
});

test("capability is ready once the model's weights are cached", async () => {
  const model = "Xenova/whisper-base.en";
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    cacheStorage: fakeCacheStorage([weightUrl(model)]),
  });
  await expect(transcriber.capability()).resolves.toEqual({ status: "ready" });
});

test("downloadBytes and modelId are configurable without a code change", async () => {
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: "Xenova/whisper-tiny.en",
    downloadBytes: 123,
    cacheStorage: fakeCacheStorage([]),
  });
  const capability = await transcriber.capability();
  expect(capability).toMatchObject({
    status: "needs-download",
    downloadBytes: 123,
    detail: "Xenova/whisper-tiny.en",
  });
});

test("prime posts a prime command and relays per-file progress to the callback", async () => {
  let worker: FakeWorker | undefined;
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: "Xenova/whisper-tiny.en",
    device: "webgpu",
    createWorker: () => {
      worker = new FakeWorker((command) => {
        const { requestId } = command;
        return [
          { type: "progress", requestId, progress: { stage: "initiate", file: "model.onnx" } },
          {
            type: "progress",
            requestId,
            progress: {
              stage: "progress",
              file: "model.onnx",
              loaded: 50,
              total: 100,
              progress: 50,
            },
          },
          { type: "progress", requestId, progress: { stage: "done", file: "model.onnx" } },
          { type: "primed", requestId },
        ];
      });
      return worker as unknown as Worker;
    },
  });

  const onProgress = vi.fn();
  await transcriber.prime(onProgress);

  // The command carried the consumer's config, including the required same-origin wasmPaths.
  expect(worker?.posted[0]).toMatchObject({
    type: "prime",
    config: { modelId: "Xenova/whisper-tiny.en", wasmPaths: WASM_PATHS, device: "webgpu" },
  });
  expect(onProgress).toHaveBeenCalledTimes(3);
  expect(onProgress).toHaveBeenNthCalledWith(2, {
    stage: "progress",
    file: "model.onnx",
    loaded: 50,
    total: 100,
    progress: 50,
  });
});

test("prime rejects when the worker reports an error", async () => {
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    createWorker: () =>
      new FakeWorker((command) => [
        { type: "error", requestId: command.requestId, message: "ORT failed to init" },
      ]) as unknown as Worker,
  });
  await expect(transcriber.prime()).rejects.toThrow(/ORT failed to init/);
});

test("prime ignores messages whose requestId does not match (no worker crosstalk)", async () => {
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    createWorker: () =>
      new FakeWorker((command) => [
        // A stray message from an unrelated request must not resolve this prime.
        { type: "primed", requestId: "some-other-request" },
        { type: "primed", requestId: command.requestId },
      ]) as unknown as Worker,
  });
  await expect(transcriber.prime()).resolves.toBeUndefined();
});

test("the worker is created once and reused across primes, until disposed", async () => {
  const created: FakeWorker[] = [];
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    createWorker: () => {
      const w = new FakeWorker((command) => [{ type: "primed", requestId: command.requestId }]);
      created.push(w);
      return w as unknown as Worker;
    },
  });

  await transcriber.prime();
  await transcriber.prime();
  expect(created).toHaveLength(1);

  transcriber.dispose();
  expect(created[0]?.terminated).toBe(true);
  await transcriber.prime();
  expect(created).toHaveLength(2);
});

// The full transcribe path (main-thread decode → worker → Whisper → text) needs AudioContext and so
// lives in `transcribe.browser.test.ts`; here we cover the pure hint → prompt assembly that feeds it.

test("buildHintPrompt joins vocabulary and prompt, or returns undefined when empty", () => {
  expect(buildHintPrompt(undefined)).toBeUndefined();
  expect(buildHintPrompt({})).toBeUndefined();
  expect(buildHintPrompt({ vocabulary: [] })).toBeUndefined();
  expect(buildHintPrompt({ vocabulary: ["  ", ""] })).toBeUndefined();

  expect(buildHintPrompt({ vocabulary: ["R-value", "CFM50", "AFUE", "backdrafting"] })).toBe(
    "R-value, CFM50, AFUE, backdrafting",
  );
  expect(buildHintPrompt({ prompt: "  energy audit walkthrough " })).toBe(
    "energy audit walkthrough",
  );
  expect(
    buildHintPrompt({ vocabulary: ["blower door", "ACH50"], prompt: "home energy assessment" }),
  ).toBe("blower door, ACH50. home energy assessment");
});
