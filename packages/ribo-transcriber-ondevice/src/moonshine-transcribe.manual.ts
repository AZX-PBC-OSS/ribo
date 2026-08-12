import { expect, test } from "vitest";

import longWavUrl from "../testdata/energy-audit-long-48k-mono.wav?url";
import { DEFAULT_MODEL_ID, OnDeviceTranscriber } from "./index.js";

/**
 * OPT-IN, NOT GATED. Runs only under `vitest.manual.config.ts`.
 *
 *   pnpm exec vitest run --config packages/ribo-transcriber-ondevice/vitest.manual.config.ts \
 *     packages/ribo-transcriber-ondevice/src/moonshine-transcribe.manual.ts
 *
 * **Nothing else runs the new default model through the real worker.** Every gated transcribe test
 * drives a `FakeWorker`, `transcribe.manual.ts` and `long-audio.manual.ts` both pin
 * `Xenova/whisper-base.en` because they exercise priming — so after the swap to Moonshine the
 * production path had a green suite and zero real executions. This file is that missing execution:
 * default config, no hints, real worker, real weights, real audio.
 *
 * It asserts coverage rather than accuracy. WER belongs to the corpus harness
 * (`spikes/transcription-measurement`), which is the measurement that decides whether this swap was
 * a good idea; this only proves the wiring produces a whole transcript instead of a comma.
 */
declare const __ORT_WASM_BASE__: string;

const recording = {
  id: "manual-moonshine",
  capturedAt: "2026-08-11T10:00:00.000Z",
  durationMs: 0,
  mimeType: "audio/wav",
  ctx: {},
};

test("the DEFAULT model transcribes a 54 s clip through the real worker", async () => {
  expect(DEFAULT_MODEL_ID).toMatch(/moonshine/i);

  const transcriber = new OnDeviceTranscriber({
    // No modelId: the point is to exercise whatever the shipped default is.
    // No hints: the default model refuses them, which is itself part of the contract.
    device: "wasm",
    dtype: "fp32",
    wasmPaths: __ORT_WASM_BASE__,
    createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  });

  const audio = await (await fetch(longWavUrl)).blob();
  const started = performance.now();
  const transcript = await transcriber.transcribe(recording, audio);
  const elapsed = performance.now() - started;
  transcriber.dispose();

  console.log(
    `\n── ${DEFAULT_MODEL_ID}, real worker ──\n` +
      `wall ${(elapsed / 1000).toFixed(1)}s\n\n${transcript.text}\n`,
  );

  // The END of the clip. Truncation at 30 s cuts off around the furnace, so anything from the
  // windows sentence onward proves the whole recording was seen. Anchored on "south elevation"
  // rather than the closing words, which whisper-base.en historically mishears — the same brittleness
  // fix `long-audio.manual.ts` records.
  expect(transcript.text.toLowerCase()).toMatch(/south elevation/);
  // And the MIDDLE, because an ends-only check passes even when a seam silently drops a segment.
  expect(transcript.text.toLowerCase()).toMatch(/blown cellulose|joist/);
  // Not the degenerate output a bad decoder prefix produces (`","`), which is the specific failure
  // this swap risked introducing.
  expect(transcript.text.trim().length).toBeGreaterThan(200);
});
