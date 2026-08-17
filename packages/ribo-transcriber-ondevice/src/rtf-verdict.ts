/**
 * @file The measured real-time-factor verdict: one number per engine id, persisted
 * across reloads, consulted by `capability()` to produce `too-slow`.
 *
 * `too-slow` is in `PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS` (`ribo-core`'s
 * `transcriber.ts`), so the verdict must survive a reload — re-measuring on every
 * page load would defeat the point of a permanent reason, and `firstCapable`
 * would re-probe a permanent fact on every drain. It is keyed by ENGINE id, so
 * swapping models re-measures rather than inheriting a verdict that may not apply
 * to the new weights.
 *
 * Storage is injected as a `CacheStorage`, following the same pattern as the model
 * cache (`model-cache.ts`): the caller defaults to `globalThis.caches` and tests
 * supply a double. The verdict lives in its own cache bucket, separate from
 * `transformers-cache`, so model-file eviction never takes the verdict with it.
 *
 * No inference happens here. Task 2's calibration writes through
 * {@link writeRtfVerdict}; this task writes it directly from tests. The read path
 * is all `capability()` needs.
 */

/** The `CacheStorage` bucket the RTF verdict is stored in, separate from model weights. */
export const RTF_VERDICT_CACHE_NAME = "ribo-rtf-verdict";

/**
 * Default real-time-factor threshold above which `capability()` reports `too-slow`.
 *
 * Provisional. RTF < 1 is the usual hard floor for interactive ASR, but the gate is
 * not the same question as interactivity and should sit higher — a device at RTF 1.5
 * is slow but still usable for batch transcription, while one at RTF 4 is not. Refine
 * with measured Surface Go 3 numbers when available (design §9 open question 2).
 */
export const DEFAULT_RTF_THRESHOLD = 3;

/** The persisted shape — one measured real-time factor. */
interface RtfVerdictRecord {
  /** Wall-clock time divided by audio duration. < 1 is faster than real-time. */
  readonly rtf: number;
}

/**
 * Read the stored real-time factor for `engineId`, or `undefined` if no verdict
 * has been recorded.
 *
 * Returns `undefined` (never throws) when storage is absent, the bucket does not
 * exist, or the read fails — "cannot tell" is the same as "not measured", which
 * `capability()` treats as "unknown, therefore ready". A corrupted or malformed
 * record is likewise `undefined`, not a sentinel: the safe direction is to
 * re-measure (or to proceed as if unmeasured) rather than to demote a device on
 * bad data.
 */
export async function readRtfVerdict(
  engineId: string,
  cacheStorage: CacheStorage | undefined,
): Promise<number | undefined> {
  if (!cacheStorage) return undefined;
  if (!(await cacheStorage.has(RTF_VERDICT_CACHE_NAME))) return undefined;
  const cache = await cacheStorage.open(RTF_VERDICT_CACHE_NAME);
  const response = await cache.match(verdictKey(engineId));
  if (!response) return undefined;
  try {
    return parseRtfVerdict(await response.json());
  } catch {
    return undefined;
  }
}

/**
 * Write a measured real-time factor for `engineId`. Called by Task 2's calibration
 * after `prime()`; in this task, called only by tests.
 *
 * A verdict stored under one engine id is not read under another —
 * {@link readRtfVerdict} keys by engine id, so a change of model, device or dtype re-measures rather
 * than inheriting. No-ops (never throws) when storage is absent.
 */
export async function writeRtfVerdict(
  engineId: string,
  rtf: number,
  cacheStorage: CacheStorage | undefined,
): Promise<void> {
  if (!cacheStorage) return;
  const cache = await cacheStorage.open(RTF_VERDICT_CACHE_NAME);
  const body = JSON.stringify({ rtf } satisfies RtfVerdictRecord);
  await cache.put(verdictKey(engineId), new Response(body));
}

/**
 * The storage key for `engineId`'s verdict.
 *
 * Shape: `https://ribo.local/rtf/<engineId>` — a synthetic URL under a dedicated
 * host so it never collides with the HuggingFace model-file URLs that
 * `transformers-cache` holds. An engine id (`ondevice:moonshine-base:wasm:q8`)
 * carries no `/` and no character a URL path objects to, and the bucket name
 * (`ribo-rtf-verdict`) plus this key together form the full storage address.
 */
function verdictKey(engineId: string): Request {
  return new Request(`https://ribo.local/rtf/${engineId}`);
}

/** Parse a stored verdict, returning `undefined` for anything that is not a finite number. */
function parseRtfVerdict(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { rtf } = value as { rtf?: unknown };
  if (typeof rtf !== "number" || !Number.isFinite(rtf)) return undefined;
  return rtf;
}
