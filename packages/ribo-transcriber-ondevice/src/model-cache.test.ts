import { expect, test } from "vitest";

import { TRANSFORMERS_CACHE_NAME, isModelCached } from "./model-cache.js";

// Deterministic and offline: a fake CacheStorage stands in for the browser's. This proves the
// "is it cached?" logic — including the false→true flip a real prime causes — with no network and
// no bytes. The real-model version of this flip is the opt-in browser run (see the README / report),
// not a CI gate.

/** Minimal CacheStorage/Cache double: URLs in, keyed like the real Cache API keys transformers.js. */
function fakeCacheStorage(urlsByBucket: Record<string, string[]> = {}): CacheStorage {
  const buckets = new Map<string, string[]>(Object.entries(urlsByBucket));
  return {
    has: (name: string) => Promise.resolve(buckets.has(name)),
    open: (name: string) => {
      const urls = buckets.get(name) ?? [];
      buckets.set(name, urls);
      return Promise.resolve({
        keys: () => Promise.resolve(urls.map((url) => ({ url }) as Request)),
      } as unknown as Cache);
    },
  } as unknown as CacheStorage;
}

const MODEL = "Xenova/whisper-tiny.en";
const weightUrl = `https://huggingface.co/${MODEL}/resolve/main/onnx/encoder_model_quantized.onnx`;
const configUrl = `https://huggingface.co/${MODEL}/resolve/main/config.json`;

test("false when there is no CacheStorage at all (node, walled-off storage)", async () => {
  await expect(isModelCached(MODEL, undefined)).resolves.toBe(false);
});

test("false when the transformers-cache bucket does not exist yet", async () => {
  await expect(isModelCached(MODEL, fakeCacheStorage())).resolves.toBe(false);
});

test("false when only metadata is cached — weights are what make it usable", async () => {
  const caches = fakeCacheStorage({ [TRANSFORMERS_CACHE_NAME]: [configUrl] });
  await expect(isModelCached(MODEL, caches)).resolves.toBe(false);
});

test("true once an .onnx weight for the model is present", async () => {
  const caches = fakeCacheStorage({ [TRANSFORMERS_CACHE_NAME]: [configUrl, weightUrl] });
  await expect(isModelCached(MODEL, caches)).resolves.toBe(true);
});

test("does not confuse a different model's weights for this one", async () => {
  const other = "https://huggingface.co/Xenova/whisper-small.en/resolve/main/onnx/model.onnx";
  const caches = fakeCacheStorage({ [TRANSFORMERS_CACHE_NAME]: [other] });
  await expect(isModelCached(MODEL, caches)).resolves.toBe(false);
});

test("the flip: not cached, then cached, across the same probe", async () => {
  const urls: string[] = [];
  const caches = fakeCacheStorage({ [TRANSFORMERS_CACHE_NAME]: urls });
  await expect(isModelCached(MODEL, caches)).resolves.toBe(false);
  urls.push(configUrl, weightUrl); // what a real prime writes
  await expect(isModelCached(MODEL, caches)).resolves.toBe(true);
});
