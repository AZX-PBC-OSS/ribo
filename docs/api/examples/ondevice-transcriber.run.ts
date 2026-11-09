/**
 * The runnable example behind docs/api/ondevice-transcriber.html.
 *
 * Every export is a zero-argument function ending in `node:assert/strict`
 * assertions on exactly what the page prose claims. The runner
 * (`run-examples.test.ts`) executes each export in the Vitest `unit` project,
 * so a source change that breaks what the page says breaks the `test` stage.
 * Runs with no credentials and no network: capability is probed against an
 * injected `CacheStorage` double, and no model is ever loaded.
 */

import assert from "node:assert/strict";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_RTF_THRESHOLD,
  DEFAULT_WORKER_TIMEOUT_MS,
  estimateDownloadBytes,
  OnDeviceTranscriber,
  TRANSFORMERS_CACHE_NAME,
} from "@azx/ribo-transcriber-ondevice";

const MOONSHINE = "onnx-community/moonshine-base-ONNX";

/**
 * A minimal `CacheStorage` double: a named bucket whose keys are the URLs a
 * primed model would have cached. Only the two members `isModelCached` reads
 * are implemented.
 */
function cacheStorageWith(urls: string[]): CacheStorage {
  const cache = { keys: async () => urls.map((url) => ({ url })) } as unknown as Cache;
  const buckets = new Map<string, Cache>([[TRANSFORMERS_CACHE_NAME, cache]]);
  return {
    has: async (name: string) => buckets.has(name),
    open: async (name: string) => buckets.get(name)!,
  } as unknown as CacheStorage;
}

const encoderAndDecoder = (modelId: string): string[] => [
  `https://huggingface.co/${modelId}/resolve/main/onnx/encoder_model.onnx`,
  `https://huggingface.co/${modelId}/resolve/main/onnx/decoder_model_merged.onnx`,
];

export async function capabilityAnswersFromTheEnvironmentNotTheNetwork(): Promise<void> {
  // #region usage
  const engine = new OnDeviceTranscriber({ wasmPaths: "/ort/" });
  const capability = await engine.capability();
  // #endregion usage
  // In node there is no CacheStorage global, so the probe reports the platform
  // itself as unsupported — asserted here as the no-cache branch of the probe.
  assert.equal(capability.status, "unavailable");
  assert.equal(capability.reason, "unsupported-platform");

  // An empty cache is capable but not primed: needs-download, carrying the
  // byte estimate for the consent screen.
  const unprimed = new OnDeviceTranscriber({
    wasmPaths: "/ort/",
    cacheStorage: cacheStorageWith([]),
  });
  const needsDownload = await unprimed.capability();
  assert.equal(needsDownload.status, "needs-download");
  assert.equal(needsDownload.downloadBytes, estimateDownloadBytes(MOONSHINE));

  // Weights for both encoder and decoder present: ready.
  const primed = new OnDeviceTranscriber({
    wasmPaths: "/ort/",
    cacheStorage: cacheStorageWith(encoderAndDecoder(MOONSHINE)),
  });
  assert.deepEqual(await primed.capability(), { status: "ready" });
}

export async function theEngineIdNamesTheOperatingPoint(): Promise<void> {
  const auto = new OnDeviceTranscriber({ wasmPaths: "/ort/" });
  assert.equal(auto.engine, "ondevice:moonshine-base:auto:auto");

  const webgpu = new OnDeviceTranscriber({ wasmPaths: "/ort/", device: "webgpu" });
  assert.equal(webgpu.engine, "ondevice:moonshine-base:webgpu:auto");
}

export async function theDownloadEstimateCountsTheRuntimeAndTheVadModel(): Promise<void> {
  // Weights plus the ONNX Runtime binary plus the voice-activity model.
  assert.equal(estimateDownloadBytes(MOONSHINE), 253_000_000);
  // The weights-only figure a caller who already primed VAD would want.
  assert.equal(estimateDownloadBytes(MOONSHINE, false), 247_000_000);
  // An unknown model falls back to a base-en-ish total, so the bar is never absurd.
  assert.equal(estimateDownloadBytes("some/unknown-model"), 320_000_000);
}

export async function hintsOnAModelWithoutPrimingIsRefusedAtConstruction(): Promise<void> {
  assert.throws(
    () => new OnDeviceTranscriber({ wasmPaths: "/ort/", hints: { vocabulary: ["R-value"] } }),
    /cannot be primed/,
  );
}

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The exported defaults, read from
  // packages/ribo-transcriber-ondevice/src/config.ts and src/rtf-verdict.ts.
  // The page quotes these values in prose next to this region; a source change
  // that moved one fails here.
  assert.equal(DEFAULT_MODEL_ID, "onnx-community/moonshine-base-ONNX");
  assert.equal(DEFAULT_WORKER_TIMEOUT_MS, 600_000);
  assert.equal(DEFAULT_RTF_THRESHOLD, 3);
}
// #endregion defaults
