import { expect, test } from "vitest";

import {
  VAD_FRAME_SIZE,
  VAD_SAMPLE_RATE,
  StreamingVad,
  createSileroDetector,
} from "./vad-stream.js";

/**
 * OPT-IN, NOT GATED. Runs only under `vitest.manual.config.ts` — never in `./check.sh`. It
 * downloads the real Silero VAD model (2.14 MB fp32) over the network.
 *
 *   pnpm exec vitest run --config packages/ribo-transcriber-ondevice/vitest.manual.config.ts \
 *     packages/ribo-transcriber-ondevice/src/vad-stream.manual.ts
 *
 * `__ORT_WASM_BASE__` is injected by that config: a same-origin `/@fs/` URL for the ORT runtime,
 * standing in for the static directory a real consumer serves the wasm from.
 */
declare const __ORT_WASM_BASE__: string;

/**
 * Synthetic audio: 10 s at 16 kHz, alternating 0.5 s of 200 Hz tone (amplitude 0.5) and 0.5 s of
 * silence — the same fixture the spike used (`live-spike-findings.md` §Q2). Produces 312 complete
 * 512-sample frames.
 */
function makeToneBurstAudio(): Float32Array {
  const total = VAD_SAMPLE_RATE * 10;
  const audio = new Float32Array(total);
  const cycleSamples = VAD_SAMPLE_RATE / 200; // 80 samples per tone cycle
  for (let i = 0; i < total; i++) {
    const inTone = Math.floor(i / VAD_SAMPLE_RATE / 0.5) % 2 === 0;
    audio[i] = inTone ? 0.5 * Math.sin((2 * Math.PI * (i % cycleSamples)) / cycleSamples) : 0;
  }
  return audio;
}

function toFrames(audio: Float32Array): Float32Array[] {
  const frames: Float32Array[] = [];
  for (let i = 0; i + VAD_FRAME_SIZE <= audio.length; i += VAD_FRAME_SIZE) {
    // `slice`, not `subarray`: each frame is a standalone Float32Array so the Tensor constructor
    // gets a clean buffer with no offset into a larger ArrayBuffer.
    frames.push(audio.slice(i, i + VAD_FRAME_SIZE));
  }
  return frames;
}

test("real Silero VAD: loads, detects speech on a tone burst, closes utterances", async () => {
  const detector = await createSileroDetector({ wasmPaths: __ORT_WASM_BASE__ });
  const vad = new StreamingVad(detector);

  const frames = toFrames(makeToneBurstAudio());

  const utterances: { readonly samples: Float32Array }[] = [];
  for (const frame of frames) {
    const closed = await vad.feed(frame);
    for (const u of closed) utterances.push(u);
  }

  console.log(
    `[vad-stream.manual] frames=${frames.length} utterances=${utterances.length} ` +
      `durations=${utterances.map((u) => `${(u.samples.length / VAD_SAMPLE_RATE).toFixed(2)}s`).join(", ")}`,
  );

  // The tone bursts are speech — at least one utterance should be detected and emitted.
  expect(utterances.length).toBeGreaterThan(0);

  // The 250 ms min-speech filter should have discarded any noise. Every emitted utterance is
  // at least 250 ms of speech (plus the pre-speech FIFO and trailing silence).
  for (const u of utterances) {
    expect(u.samples.length / VAD_SAMPLE_RATE).toBeGreaterThanOrEqual(0.25);
  }
}, 300_000);

test("carrying state produces different probabilities than feeding zero state (spike Q2)", async () => {
  const detector = await createSileroDetector({ wasmPaths: __ORT_WASM_BASE__ });
  const frames = toFrames(makeToneBurstAudio());

  // Pass 1: carry state forward (the correct behavior).
  const carriedProbs: number[] = [];
  let carriedState = new Float32Array(detector.initialState);
  for (const frame of frames) {
    const { probability, state } = await detector.detect(frame, carriedState);
    carriedProbs.push(probability);
    carriedState = new Float32Array(state);
  }

  // Pass 2: feed zero state every time (the bug the frame loop must not make).
  const freshProbs: number[] = [];
  const zeroState = new Float32Array(detector.initialState);
  for (const frame of frames) {
    const { probability } = await detector.detect(frame, zeroState);
    freshProbs.push(probability);
  }

  // The spike found 312 of 313 frames differ, max ΔP = 0.29 — larger than the 0.3/0.1
  // hysteresis gap. This test reproduces that finding against the real model.
  let differing = 0;
  let maxDiff = 0;
  for (let i = 0; i < carriedProbs.length; i++) {
    const diff = Math.abs(carriedProbs[i]! - freshProbs[i]!);
    if (diff > 0.001) differing++;
    maxDiff = Math.max(maxDiff, diff);
  }

  console.log(
    `[vad-stream.manual] state-carrying: ${differing}/${carriedProbs.length} frames differ, ` +
      `max ΔP = ${maxDiff.toFixed(3)}`,
  );
  console.log(
    `[vad-stream.manual] first 20 carried: ${carriedProbs
      .slice(0, 20)
      .map((p) => p.toFixed(3))
      .join(", ")}`,
  );
  console.log(
    `[vad-stream.manual] first 20 fresh:   ${freshProbs
      .slice(0, 20)
      .map((p) => p.toFixed(3))
      .join(", ")}`,
  );

  // State-carrying matters: most frames should differ.
  expect(differing).toBeGreaterThan(carriedProbs.length * 0.5);
  // And the max difference should be large enough to flip hysteresis decisions.
  expect(maxDiff).toBeGreaterThan(0.1);
}, 300_000);
