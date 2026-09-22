import { expect, test } from "vitest";

import {
  decodeTo16kMono,
  modelSupportsHints,
  OnDeviceTranscriber,
} from "../../../packages/ribo-transcriber-ondevice/src/index.js";

/**
 * Real-audio companion to `measure.manual.ts` (Asana: "Add audio files ... to extraction accuracy
 * documentation"). Feeds each file in `testdata/real/` WHOLE to the real `OnDeviceTranscriber` — no
 * harness-level chunking: the transcriber's worker now segments audio past Whisper's 30 s window
 * itself (VAD-based `planChunks`), unlike when the synthetic-corpus harness's chunking was written.
 *
 * MANUAL, OPT-IN. Runs only under `vitest.measure-real.config.ts` — never in `./check.sh`, both
 * because it downloads a real model and because `testdata/real/` (git-ignored) may not exist on this
 * machine. Emits `@@MEASURE@@` JSON lines the Node driver (`run-real-ondevice.mjs`) captures. No WER
 * here — there is no ground truth yet; a human produces that by correcting a draft (see
 * `testdata/real/README.md`).
 *
 * These numbers are on REAL field audio, unlike everything in doc 14: real noise, real mic handling,
 * real disfluency. Still only two recordings — not a statistically meaningful sample.
 */
interface RealFile {
  slug: string;
  url: string;
}

declare const __ORT_WASM_BASE__: string;
declare const __MODEL_ID__: string;
// Vite `define` substitutes raw text, not a quoted string — the config passes
// `JSON.stringify(realFiles)` (an array), so this token is already a JS array literal in the
// transformed source, not a string to `JSON.parse`.
declare const __REAL_FILES__: RealFile[];

// Same production vocabulary the synthetic-corpus harness hints with (Part A) — keeping it identical
// is what makes a real-vs-synthetic comparison mean anything.
const VOCABULARY = [
  "R-value",
  "CFM50",
  "CFM25",
  "ACH50",
  "AFUE",
  "blower door",
  "backdrafting",
  "flue",
  "BTU",
  "condensing",
  "direct-vented",
  "cellulose",
  "spillage",
  "draft diverter",
];

function makeTranscriber(): OnDeviceTranscriber {
  return new OnDeviceTranscriber({
    modelId: __MODEL_ID__,
    device: "wasm", // headless-feasible + deterministic; WebGPU is not reachable in this environment.
    dtype: "fp32", // q4/q8 do not load on the pinned ORT build (doc 14 Task 2); fp32 is proven.
    ...(modelSupportsHints(__MODEL_ID__) ? { hints: { vocabulary: VOCABULARY } } : {}),
    wasmPaths: __ORT_WASM_BASE__,
    createWorker: () =>
      new Worker(
        new URL("../../../packages/ribo-transcriber-ondevice/src/worker.ts", import.meta.url),
        { type: "module" },
      ),
  });
}

test("measure on-device transcription on real field audio", async () => {
  const files = __REAL_FILES__;
  expect(
    files.length,
    "no files in testdata/real/ — see testdata/real/README.md to add a recording",
  ).toBeGreaterThan(0);

  const t = makeTranscriber();
  await t.prime();

  for (const f of files) {
    const blob = await (await fetch(f.url)).blob();
    // Decoded once here purely to report audioSec (RTF's denominator); transcribe() below decodes
    // again internally (decodeTo16kMono is cheap relative to the inference it feeds).
    const samples = await decodeTo16kMono(blob);
    const audioSec = samples.length / 16_000;

    const recording = {
      id: f.slug,
      capturedAt: new Date().toISOString(),
      durationMs: Math.round(audioSec * 1000),
      mimeType: blob.type,
      ctx: {},
    };
    const s0 = performance.now();
    const out = await t.transcribe(recording, blob);
    const processMs = performance.now() - s0;

    console.log(
      `@@MEASURE@@ ${JSON.stringify({
        slug: f.slug,
        text: out.text.trim(),
        audioSec,
        processMs,
      })}`,
    );
  }
  t.dispose();
}, 3_600_000);
