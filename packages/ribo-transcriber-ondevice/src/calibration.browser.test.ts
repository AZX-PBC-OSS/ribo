import { expect, test } from "vitest";

import { OnDeviceTranscriber } from "./index.js";
import { CALIBRATION_CLIP_DURATION_MS } from "./calibration-clip.js";
import { TRANSFORMERS_CACHE_NAME } from "./model-cache.js";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./protocol.js";

// Task 2 browser tests: the RTF calibration step that runs inside `prime()`.
// These need a real Chromium (the `browser` Vitest project) because the
// calibration clip is a WebM/Opus blob that `decodeTo16kMono` decodes through
// `AudioContext` — which exists only in a Window scope. The worker is faked, so
// no model is downloaded and no real inference runs; the timing is controlled
// through an injected `now` function, so no test sleeps.

const WASM_PATHS = "/ort/";
const MODEL = "Xenova/whisper-tiny.en";

const encoderUrl = (model: string) =>
  `https://huggingface.co/${model}/resolve/main/onnx/encoder_model_quantized.onnx`;
const decoderUrl = (model: string) =>
  `https://huggingface.co/${model}/resolve/main/onnx/decoder_model_merged_quantized.onnx`;

/**
 * A CacheStorage double that supports `has`, `open`, `keys`, `match`, and `put`
 * across multiple buckets. Tests need both read (model-cache `keys()` for
 * `isModelCached`) and write/read (RTF-verdict `put`/`match`) through the same
 * storage.
 */
function fakeCacheStorage(initial: Record<string, Record<string, string>> = {}): CacheStorage {
  const buckets = new Map<string, Map<string, string>>();
  for (const [name, entries] of Object.entries(initial)) {
    buckets.set(name, new Map(Object.entries(entries)));
  }
  return {
    has: (name: string) => Promise.resolve(buckets.has(name)),
    open: (name: string) => {
      let bucket = buckets.get(name);
      if (!bucket) {
        bucket = new Map();
        buckets.set(name, bucket);
      }
      return Promise.resolve({
        keys: () => Promise.resolve([...bucket!.keys()].map((url) => ({ url }) as Request)),
        match: (request: Request | string) => {
          const url = typeof request === "string" ? request : request.url;
          const body = bucket!.get(url);
          return Promise.resolve(body !== undefined ? (new Response(body) as Response) : undefined);
        },
        put: (request: Request, response: Response) =>
          response.text().then((body) => {
            bucket!.set(request.url, body);
            return Promise.resolve();
          }),
      } as unknown as Cache);
    },
  } as unknown as CacheStorage;
}

/** A cache pre-populated so `isModelCached` reports true for `model`. */
function cachesWithModel(model: string): CacheStorage {
  return fakeCacheStorage({
    [TRANSFORMERS_CACHE_NAME]: {
      [encoderUrl(model)]: "",
      [decoderUrl(model)]: "",
    },
  });
}

/** Scriptable Worker double that captures each posted message and replies with
 * a canned sequence produced by `reply`. */
class FakeWorker {
  readonly posted: { message: MainToWorkerMessage; transfer: Transferable[] }[] = [];
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor(
    private readonly reply: (
      message: Extract<MainToWorkerMessage, { requestId: string }>,
    ) => WorkerToMainMessage[],
  ) {}
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const set = this.#listeners.get(type) ?? new Set();
    set.add(fn);
    this.#listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(fn);
  }
  postMessage(message: MainToWorkerMessage, transfer: Transferable[] = []): void {
    this.posted.push({ message, transfer });
    if (!("requestId" in message)) return;
    const replies = this.reply(message);
    queueMicrotask(() => {
      for (const reply of replies)
        for (const fn of this.#listeners.get("message") ?? []) fn({ data: reply });
    });
  }
  terminate(): void {}
}

/** Reply script: canned transcript text for a transcribe, `primed` for a prime. */
function transcribeReply(text: string) {
  return (message: Extract<MainToWorkerMessage, { requestId: string }>): WorkerToMainMessage[] =>
    message.type === "transcribe"
      ? [{ type: "transcribed", requestId: message.requestId, text }]
      : [{ type: "primed", requestId: message.requestId }];
}

/** A clock that returns the given values in order, then repeats the last. */
function fixedClock(...times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)]!;
}

// Must-fail test 1: After prime() resolves, the accessor returns a number, and
// capability() reflects it. Before Task 2, prime() left no verdict — measuredRtf()
// returned undefined and capability() could only see cache state, not a measured
// RTF.
test("prime writes an RTF verdict and capability reflects it", async () => {
  const caches = cachesWithModel(MODEL);
  const now = fixedClock(0, 100);
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: caches,
    now,
    createWorker: () => new FakeWorker(transcribeReply("calibration")) as unknown as Worker,
  });

  await transcriber.prime();

  const rtf = await transcriber.measuredRtf();
  expect(typeof rtf).toBe("number");
  expect(rtf).toBe(100 / CALIBRATION_CLIP_DURATION_MS);
  // With rtf well below threshold and the model cached, capability is ready.
  await expect(transcriber.capability()).resolves.toEqual({ status: "ready" });
});

// Must-fail test 2: A deliberately slow worker double produces an RTF above
// threshold, and capability() then reports too-slow — the end-to-end path Task 1
// could only test halfway. Task 1 wrote the verdict directly; this proves the
// verdict actually flows from a primed pipeline through capability().
test("a slow calibration produces an RTF above threshold and capability reports too-slow", async () => {
  const caches = cachesWithModel(MODEL);
  // elapsed = 20 000 ms over a 5 000 ms clip → RTF = 4, above the default
  // threshold of 3.
  const now = fixedClock(0, 20_000);
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: caches,
    now,
    createWorker: () => new FakeWorker(transcribeReply("calibration")) as unknown as Worker,
  });

  await transcriber.prime();

  const rtf = await transcriber.measuredRtf();
  expect(rtf).toBe(20_000 / CALIBRATION_CLIP_DURATION_MS);
  expect(rtf).toBeGreaterThan(3);

  const capability = await transcriber.capability();
  expect(capability.status).toBe("unavailable");
  if (capability.status === "unavailable") {
    expect(capability.reason).toBe("too-slow");
  }
});

// Must-fail test 3: A worker that throws during calibration still leaves prime()
// resolved, with no verdict stored. A calibration failure must not fail prime() —
// the device degrades to today's behaviour (no verdict → "unknown, therefore
// ready") instead of a broken prime.
test("a worker that throws during calibration leaves prime resolved with no verdict", async () => {
  const caches = cachesWithModel(MODEL);
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: caches,
    now: fixedClock(0, 100),
    createWorker: () =>
      new FakeWorker((message) => {
        if (message.type === "transcribe") {
          return [
            {
              type: "error",
              requestId: message.requestId,
              message: "calibration inference failed",
            },
          ];
        }
        return [{ type: "primed", requestId: message.requestId }];
      }) as unknown as Worker,
  });

  // prime() must still resolve — the calibration error is swallowed.
  await expect(transcriber.prime()).resolves.toBeUndefined();

  // No verdict stored.
  await expect(transcriber.measuredRtf()).resolves.toBeUndefined();
  // And capability falls back to today's behaviour: model cached → ready.
  await expect(transcriber.capability()).resolves.toEqual({ status: "ready" });
});

// Must-fail test 4: The measurement divides by the clip's real duration. A clip
// of known length timed against a controlled clock yields the arithmetically
// correct RTF. A test that only asserts "some number appeared" would pass with
// the units inverted (clip / elapsed instead of elapsed / clip).
test("the RTF is elapsed divided by clip duration, not the inverse", async () => {
  const caches = cachesWithModel(MODEL);
  // start = 1 000, end = 16 000 → elapsed = 15 000 ms
  // RTF = 15 000 / 5 000 = 3 (not 5 000 / 15 000 ≈ 0.333)
  const now = fixedClock(1_000, 16_000);
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: caches,
    now,
    createWorker: () => new FakeWorker(transcribeReply("calibration")) as unknown as Worker,
  });

  await transcriber.prime();

  const rtf = await transcriber.measuredRtf();
  // Assert the exact arithmetic — 3, not 1/3. This is the test that catches an
  // inverted division: a wrong implementation that divided clip duration by
  // elapsed would produce ≈ 0.333, not 3.
  expect(rtf).toBe(3);
  expect(rtf).not.toBeCloseTo(1 / 3, 2);
});
