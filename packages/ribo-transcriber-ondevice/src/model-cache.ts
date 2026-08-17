import type { OnnxDtype } from "./protocol.js";

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
  dtype?: OnnxDtype,
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
  // Both roles must be present: every ONNX weight names its role in the filename, so requiring
  // an encoder AND a decoder is what catches the half-download.
  //
  // The dtype check is the second half, and it was missing. This function used to match any
  // dtype's weights deliberately — "without false-negative-ing a complete cache primed under any
  // dtype" — which is right for a package with one configuration and wrong the moment there are
  // two. With fp32 cached and q8 not, a q8 instance reported `ready`, was selected by
  // `firstCapable`, and then downloaded mid-drain: precisely the un-consented fetch that
  // `needs-download` exists to prevent, and on a queue drain there is nobody to consent.
  //
  // `dtype` omitted keeps the old any-dtype behaviour, for callers that genuinely do not care.
  const matchesDtype = (url: string): boolean =>
    dtype === undefined || dtypeSuffixOf(url) === DTYPE_FILE_SUFFIX[dtype];
  return (
    onnxUrls.some((url) => url.includes("encoder") && matchesDtype(url)) &&
    onnxUrls.some((url) => url.includes("decoder") && matchesDtype(url))
  );
}

/**
 * The filename suffix transformers.js appends per dtype. fp32 is unsuffixed, which is exactly
 * why a substring test cannot distinguish it: `encoder_model.onnx` is a suffix-free *prefix* of
 * nothing, but `encoder_model_q4.onnx` contains it. The suffix has to be read, not searched for.
 */
const DTYPE_FILE_SUFFIX: Readonly<Record<string, string>> = {
  fp32: "",
  fp16: "_fp16",
  q8: "_quantized",
  int8: "_int8",
  uint8: "_uint8",
  q4: "_q4",
  q4f16: "_q4f16",
  bnb4: "_bnb4",
};

/** Longest first, so `_q4f16` is never mistaken for `_q4`. */
const KNOWN_SUFFIXES = Object.values(DTYPE_FILE_SUFFIX)
  .filter((s) => s !== "")
  .sort((a, b) => b.length - a.length);

/**
 * The dtype suffix carried by a weights URL, or `""` for the unsuffixed fp32 file.
 *
 * Reads the basename rather than searching the whole URL: a Hub path can contain a revision
 * hash or a repo name that happens to include one of these tokens.
 */
function dtypeSuffixOf(url: string): string {
  const base = url.slice(url.lastIndexOf("/") + 1).replace(/\.onnx(_data)?$/, "");
  return KNOWN_SUFFIXES.find((suffix) => base.endsWith(suffix)) ?? "";
}
