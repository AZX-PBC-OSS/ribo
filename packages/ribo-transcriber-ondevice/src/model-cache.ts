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
 * "Usable" is stricter than "present": Whisper is an **encoder-decoder** model, and the two are
 * separate ONNX files (`encoder_model*.onnx` and `decoder_model*.onnx`, confirmed against the
 * `Xenova/whisper-base.en` repo — both the merged and split decoder variants contain "decoder" in
 * the filename). A cache with only one of the pair — a download dropped mid-way, exactly the
 * basement-connectivity case this product exists for — must NOT report `ready`, or `firstCapable`
 * selects this engine and transcription fails on a fetch while offline.
 *
 * The check requires at least one cached `.onnx` URL containing `"encoder"` and at least one
 * containing `"decoder"` for the model id. This is derived from the cached filenames rather than
 * hardcoded against a specific dtype or variant: `encoder_model.onnx` (fp32),
 * `encoder_model_quantized.onnx` (int8), `decoder_model_merged.onnx` (fp32),
 * `decoder_model_quantized.onnx` (int8) — all satisfy it, so a legitimately complete cache is
 * never turned away regardless of which weights were primed.
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
  const onnxUrls = keys
    .map((request) => request.url)
    .filter((url) => url.includes(marker) && url.includes(".onnx"));
  // Substring match on "encoder"/"decoder" rather than an explicit file list: the exact filenames
  // vary by dtype (fp32 / quantized / bnb4 / int8…), by variant (merged vs split decoder), and by
  // repo (`Xenova` vs `onnx-community`). But every Whisper ONNX weight names its role in the
  // filename, so requiring both roles catches the half-download without false-negative-ing a
  // complete cache primed under any dtype.
  return (
    onnxUrls.some((url) => url.includes("encoder")) &&
    onnxUrls.some((url) => url.includes("decoder"))
  );
}
