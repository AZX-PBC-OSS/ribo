import { expect, test } from "vitest";

import { isPermanentlyUnavailable } from "@azx/ribo-core";

import { OnDeviceTranscriber } from "./index.js";
import { TRANSFORMERS_CACHE_NAME } from "./model-cache.js";
import { DEFAULT_RTF_THRESHOLD, readRtfVerdict, writeRtfVerdict } from "./rtf-verdict.js";

// Task 1 must-fail tests: the RTF verdict store and the `capability()` branch that
// consults it. All deterministic and offline — a CacheStorage double holds both the
// model-weight keys and the RTF-verdict key, so this proves the too-slow gate without
// downloading a single byte or running a single inference. No worker is constructed
// here; the capability probe reads cache state only.

const WASM_PATHS = "/ort/";
const MODEL = "Xenova/whisper-tiny.en";
const OTHER_MODEL = "Xenova/whisper-small.en";

const encoderUrl = (model: string) =>
  `https://huggingface.co/${model}/resolve/main/onnx/encoder_model_quantized.onnx`;
const decoderUrl = (model: string) =>
  `https://huggingface.co/${model}/resolve/main/onnx/decoder_model_merged_quantized.onnx`;

/**
 * A CacheStorage double that supports `has`, `open`, `keys`, `match`, and `put`
 * across multiple buckets. Tests need both read (model-cache `keys()` for
 * `isModelCached`) and write/read (RTF-verdict `put`/`match`) through the same
 * storage, which the simpler read-only double in `index.test.ts` cannot do.
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

// Must-fail test 1: a stored RTF above threshold, WITH the model cached, yields
// unavailable / too-slow, and the detail carries the measured value. This is the
// behaviour that does not exist today at any threshold — the old code sees cached
// weights and reports ready regardless of speed.
test("stored RTF above threshold with model cached yields unavailable/too-slow carrying the measured value", async () => {
  const caches = cachesWithModel(MODEL);
  await writeRtfVerdict(MODEL, 4.2, caches);

  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: caches,
  });
  const capability = await transcriber.capability();

  expect(capability.status).toBe("unavailable");
  if (capability.status === "unavailable") {
    expect(capability.reason).toBe("too-slow");
    expect(capability.detail).toContain("4.2");
  }
});

// Must-fail test 2: a stored RTF below threshold and the model cached yields ready.
// Guards against the threshold being too aggressive — a device that is slow but
// within tolerance should still be selected.
test("stored RTF below threshold and model cached yields ready", async () => {
  const caches = cachesWithModel(MODEL);
  await writeRtfVerdict(MODEL, 0.5, caches);

  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: caches,
  });
  await expect(transcriber.capability()).resolves.toEqual({ status: "ready" });
});

// Must-fail test 3: no stored verdict and the model cached yields ready — today's
// behaviour is unchanged for devices that never calibrate. A device that primed but
// never measured must not be demoted.
test("no stored verdict and model cached yields ready (today's behaviour unchanged)", async () => {
  const caches = cachesWithModel(MODEL);

  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: caches,
  });
  await expect(transcriber.capability()).resolves.toEqual({ status: "ready" });
});

// Must-fail test 4: isPermanentlyUnavailable() returns true for the verdict this
// produces. If it does not, firstCapable will re-probe a permanent fact on every
// drain — too-slow is in PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS, and the
// capability we produce must honour that.
test("the too-slow verdict is permanently unavailable so firstCapable stops re-probing", async () => {
  const caches = cachesWithModel(MODEL);
  await writeRtfVerdict(MODEL, 4.2, caches);

  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: caches,
  });
  const capability = await transcriber.capability();

  expect(isPermanentlyUnavailable(capability)).toBe(true);
});

// Must-fail test 5: a verdict written by one instance is read by a fresh one
// (durability across instances), and a verdict stored under a different model id
// is NOT read — a model swap must re-measure rather than inherit.
test("verdict is durable across instances and isolated by model id", async () => {
  const caches = cachesWithModel(MODEL);

  // Write the verdict through the store — Task 2 will write through `prime()`.
  await writeRtfVerdict(MODEL, 4.2, caches);

  // A fresh instance with the same model and storage reads it.
  const transcriberB = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: caches,
  });
  await expect(transcriberB.measuredRtf()).resolves.toBe(4.2);

  // A fresh instance with a DIFFERENT model does not inherit the verdict.
  const cachesForOther = cachesWithModel(OTHER_MODEL);
  // Copy the RTF verdict from the shared storage so the other model's cache has it
  // under MODEL's key — proving the key includes the model id.
  await writeRtfVerdict(MODEL, 4.2, cachesForOther);
  const transcriberC = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: OTHER_MODEL,
    cacheStorage: cachesForOther,
  });
  await expect(transcriberC.measuredRtf()).resolves.toBeUndefined();
  // And its capability is not too-slow — it is ready (the other model is cached).
  await expect(transcriberC.capability()).resolves.toEqual({ status: "ready" });
});

// The threshold is configurable — a custom threshold changes the verdict boundary.
test("rtfThreshold option controls the gate boundary", async () => {
  const caches = cachesWithModel(MODEL);
  // RTF 1.5 is below the default threshold (3) but above a custom threshold of 1.
  await writeRtfVerdict(MODEL, 1.5, caches);

  const defaultThreshold = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: caches,
  });
  await expect(defaultThreshold.capability()).resolves.toEqual({ status: "ready" });

  const strictThreshold = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: caches,
    rtfThreshold: 1,
  });
  const capability = await strictThreshold.capability();
  expect(capability.status).toBe("unavailable");
  if (capability.status === "unavailable") {
    expect(capability.reason).toBe("too-slow");
  }
});

// The accessor returns undefined before calibration, not a sentinel number.
test("measuredRtf returns undefined when no verdict is stored", async () => {
  const caches = cachesWithModel(MODEL);
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: caches,
  });
  await expect(transcriber.measuredRtf()).resolves.toBeUndefined();
});

// The accessor returns undefined when there is no storage at all.
test("measuredRtf returns undefined when there is no CacheStorage", async () => {
  const transcriber = new OnDeviceTranscriber({
    wasmPaths: WASM_PATHS,
    modelId: MODEL,
    cacheStorage: undefined,
  });
  await expect(transcriber.measuredRtf()).resolves.toBeUndefined();
});

// The default threshold is the documented provisional value.
test("DEFAULT_RTF_THRESHOLD is 3 (provisional default)", () => {
  expect(DEFAULT_RTF_THRESHOLD).toBe(3);
});

// Direct store round-trip: write then read returns the same value.
test("writeRtfVerdict then readRtfVerdict round-trips a value", async () => {
  const caches = fakeCacheStorage();
  await writeRtfVerdict(MODEL, 2.7, caches);
  await expect(readRtfVerdict(MODEL, caches)).resolves.toBe(2.7);
});

// readRtfVerdict returns undefined when storage is absent.
test("readRtfVerdict returns undefined when storage is absent", async () => {
  await expect(readRtfVerdict(MODEL, undefined)).resolves.toBeUndefined();
});
