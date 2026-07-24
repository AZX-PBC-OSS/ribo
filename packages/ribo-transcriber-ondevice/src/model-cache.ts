/**
 * @file "Is the model already downloaded?" — answered by reading the Cache API, no network.
 *
 * transformers.js caches every fetched model file into a `CacheStorage` bucket named
 * `transformers-cache`, keyed by the file's full request URL (its `FileCache`, verified against the
 * 4.2.0 tarball). So we can tell `needs-download` from `ready` **without downloading anything**:
 * open that cache and look for this model's weight file among the keys. This is what lets
 * {@link ../index.ts OnDeviceTranscriber.capability} answer honestly (plan Task 2, item 5).
 */

/** The `CacheStorage` bucket transformers.js writes model files into. */
export const TRANSFORMERS_CACHE_NAME = "transformers-cache";

/**
 * Is `modelId` cached and usable offline, judged from the Cache API alone?
 *
 * "Usable" is stricter than "present": we require at least one **`.onnx` weight** entry for the
 * model, not merely its `config.json`. A half-populated cache (config fetched, weights not) would
 * otherwise report `ready` and then fail on first inference. The check is a substring match on the
 * model id plus an `.onnx` marker in the key URL — deliberately tolerant of revision, host and file
 * layout, which vary across model repos.
 *
 * Returns `false` (never throws) when there is no `CacheStorage` — node, or a browser that walled
 * off storage — so callers can treat "cannot tell" as "not cached", which is the safe direction.
 *
 * @param cacheStorage injectable for tests; defaults to `globalThis.caches`.
 */
export async function isModelCached(
  modelId: string,
  cacheStorage: CacheStorage | undefined = globalThis.caches,
): Promise<boolean> {
  if (!cacheStorage) return false;
  // `has` avoids creating the bucket as a side effect of the probe when nothing has cached yet.
  if (!(await cacheStorage.has(TRANSFORMERS_CACHE_NAME))) return false;
  const cache = await cacheStorage.open(TRANSFORMERS_CACHE_NAME);
  const keys = await cache.keys();
  const marker = `${modelId}/`;
  return keys.some((request) => request.url.includes(marker) && request.url.includes(".onnx"));
}
