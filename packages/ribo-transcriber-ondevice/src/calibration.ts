/**
 * @file The RTF calibration step: run one inference over the committed clip after
 * `prime()` has warmed the pipeline, and persist the measured real-time factor.
 *
 * Called from `OnDeviceTranscriber.prime()` after the pipeline is constructed —
 * the worker is warm at that point, so this measures inference (and decode)
 * rather than model load. Measuring the load instead would produce a number that
 * says more about the disk than the device.
 *
 * A calibration failure must not fail `prime()`. If the timed run throws, it is
 * swallowed and no verdict is stored — Task 1 treats "no verdict" as "unknown,
 * therefore ready", so the device degrades to today's behaviour instead of a
 * broken prime.
 */
import type { Recording, Transcript } from "@azx/ribo-core";

import {
  CALIBRATION_CLIP_DURATION_MS,
  CALIBRATION_CLIP_MIME_TYPE,
  calibrationClip,
} from "./calibration-clip.js";
import { writeRtfVerdict } from "./rtf-verdict.js";

/** The synthetic recording the calibration clip is transcribed under. */
const CALIBRATION_RECORDING: Recording = {
  id: "ribo-calibration",
  capturedAt: "2026-08-17T00:00:00.000Z",
  durationMs: CALIBRATION_CLIP_DURATION_MS,
  mimeType: CALIBRATION_CLIP_MIME_TYPE,
  ctx: {},
};

/**
 * Run one calibration transcription and persist the measured real-time factor.
 *
 * Wall-clock elapsed time is divided by {@link CALIBRATION_CLIP_DURATION_MS} to
 * produce the RTF — wall-clock over audio duration, the same units the on-device
 * gate and the managed path's effective RTF use, so the two can be compared
 * directly. The result is written through `writeRtfVerdict` (Task 1's store),
 * keyed by model id so a model swap re-measures.
 *
 * Errors are swallowed: a device that primed successfully but could not be timed
 * ends with no verdict, which `capability()` treats as "unknown, therefore ready"
 * — not a broken prime. This is the safe direction: a broken prime would lock
 * the device out of the on-device path entirely, while a missing verdict merely
 * preserves today's behaviour.
 *
 * @param transcribe the transcriber's `transcribe` method — called on the warm
 *   pipeline, so the measurement covers decode + inference, not model load.
 * @param modelId keyed into the RTF verdict store so a model swap re-measures.
 * @param cacheStorage where the verdict is persisted, following the same injection
 *   pattern as the model cache.
 * @param now wall-clock source — defaults to `performance.now` in the caller.
 *   Injected so tests can control the clock and assert the arithmetic exactly.
 */
export async function measureRtf(
  transcribe: (recording: Recording, audio: Blob) => Promise<Transcript>,
  modelId: string,
  cacheStorage: CacheStorage | undefined,
  now: () => number,
): Promise<void> {
  try {
    const clip = calibrationClip();
    const start = now();
    await transcribe(CALIBRATION_RECORDING, clip);
    const elapsed = now() - start;
    const rtf = elapsed / CALIBRATION_CLIP_DURATION_MS;
    await writeRtfVerdict(modelId, rtf, cacheStorage);
  } catch {
    // Swallow: a calibration failure must not fail prime(). No verdict is stored,
    // so capability() treats the device as "unknown, therefore ready" — the
    // safe degradation to today's behaviour rather than a broken prime.
  }
}
