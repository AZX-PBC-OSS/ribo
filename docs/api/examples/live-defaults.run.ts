/**
 * The runnable defaults example behind docs/api/live-transcription.html.
 *
 * The page's main example is type-checked only (live sessions run in a Web
 * Worker), so this small dedicated file carries the R4 tier-1 constant
 * assertions: the runner executes them in the Vitest `unit` project, and a
 * source change that moved a documented default fails the `test` stage.
 */

import assert from "node:assert/strict";
import {
  DEFAULT_LIVE_OPEN_TIMEOUT_MS,
  OnDeviceLiveTranscriber,
} from "@azx/ribo-transcriber-ondevice";

// #region defaults
export async function theDefaultsThePageQuotesComeFromTheSource(): Promise<void> {
  // The exported default, read from
  // packages/ribo-transcriber-ondevice/src/live.ts. The page quotes the value
  // in prose next to this region; a source change that moved it fails here.
  assert.equal(DEFAULT_LIVE_OPEN_TIMEOUT_MS, 60_000);
}
// #endregion defaults

export async function liveCapabilityAnswersFromTheEnvironmentNotTheNetwork(): Promise<void> {
  // In node there is no CacheStorage global, so the probe reports the platform
  // itself as unsupported — the no-cache branch of the probe.
  const live = new OnDeviceLiveTranscriber({ wasmPaths: "/ort/" });
  const capability = await live.liveCapability();
  assert.equal(capability.status, "unavailable");
  assert.equal(capability.reason, "unsupported-platform");
}
