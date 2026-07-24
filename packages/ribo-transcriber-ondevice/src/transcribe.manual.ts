import { expect, test } from "vitest";

import wavUrl from "../testdata/energy-audit-48k-mono.wav?url";
import { decodeTo16kMono, OnDeviceTranscriber } from "./index.js";

/**
 * OPT-IN, NOT GATED. Runs only under `vitest.manual.config.ts` — never in `./check.sh`. This is the
 * Task 3 proof that the central bet works: a real spoken-audio clip goes through the FULL path —
 * `Blob` → main-thread decode/resample → worker → **real Whisper inference** → text — and prints the
 * transcript, the measured real-time factor, and the effect of the domain-jargon hints.
 *
 *   pnpm exec vitest run --config packages/ribo-transcriber-ondevice/vitest.manual.config.ts \
 *     packages/ribo-transcriber-ondevice/src/transcribe.manual.ts
 *
 * The clip (`testdata/energy-audit-48k-mono.wav`, 48 kHz mono, ~11 s) is macOS `say` TTS of energy-
 * audit jargon — generated offline so there is no network/consent dependency. TTS is cleaner than
 * real field speech (doc: a floor, not a forecast). Regenerate it with:
 *
 *   say -v Samantha -r 155 -o /tmp/clip.aiff "The blower door test measured four hundred CFM \
 *     fifty. The attic insulation is R value forty nine. The furnace AFUE is ninety five percent. \
 *     We observed backdrafting at the water heater flue." && \
 *   afconvert -f WAVE -d LEI16@48000 -c 1 /tmp/clip.aiff \
 *     packages/ribo-transcriber-ondevice/testdata/energy-audit-48k-mono.wav
 *
 * 48 kHz (not 16 kHz) on purpose: it forces the main-thread decode to actually resample 48k→16k.
 *
 * `__ORT_WASM_BASE__` is the same-origin ORT runtime base the manual config injects.
 */
declare const __ORT_WASM_BASE__: string;

// whisper-base.en is the production default and best shows the hint biasing. Switch to
// `Xenova/whisper-tiny.en` for a faster (~2×) plumbing check.
const MODEL = "Xenova/whisper-base.en";

const VOCABULARY = ["R-value", "CFM50", "AFUE", "blower door", "backdrafting", "ACH50", "flue"];

function makeTranscriber(hints?: { vocabulary: string[] }): OnDeviceTranscriber {
  return new OnDeviceTranscriber({
    modelId: MODEL,
    // WASM is always present in headless Chromium; WebGPU may not be. Determinism over speed here.
    device: "wasm",
    dtype: "fp32", // q4/q8 do not load on the pinned ORT build (Task 2 finding); fp32 is proven.
    ...(hints ? { hints } : {}),
    wasmPaths: __ORT_WASM_BASE__,
    createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  });
}

test("real Whisper: decode a spoken clip end-to-end and transcribe it, with and without hints", async () => {
  const recording = {
    id: "manual-1",
    capturedAt: "2026-07-23T10:00:00.000Z",
    durationMs: 0,
    mimeType: "audio/wav",
    ctx: {},
  };
  const audio = await (await fetch(wavUrl)).blob();

  // Audio duration, for the real-time factor. Decode once here to measure it (the transcriber decodes
  // again internally — that decode is part of what we time below).
  const samples = await decodeTo16kMono(audio);
  const audioSeconds = samples.length / 16_000;

  // ── Baseline: no hints ───────────────────────────────────────────────────────────────────────
  const plain = makeTranscriber();
  await plain.prime(); // download + warm the pipeline (not counted in RTF)
  const t0 = performance.now();
  const bare = await plain.transcribe(recording, audio);
  const bareMs = performance.now() - t0;
  plain.dispose();

  // ── Hinted: same clip, decoder primed with the jargon vocabulary ───────────────────────────────
  const hinted = makeTranscriber({ vocabulary: VOCABULARY });
  await hinted.prime(); // warm cache — no re-download
  const t1 = performance.now();
  const primed = await hinted.transcribe(recording, audio);
  const primedMs = performance.now() - t1;
  hinted.dispose();

  const rtf = bareMs / 1000 / audioSeconds;
  // Surfacing the numbers is the entire point of the manual run (no-console is off for *.manual.ts).
  console.log(
    `\n[transcribe.manual] model=${MODEL} device=wasm dtype=fp32 audio=${audioSeconds.toFixed(2)}s`,
  );
  console.log(
    `[transcribe.manual] no-hints  (${bareMs.toFixed(0)}ms, RTF=${rtf.toFixed(2)}): ${JSON.stringify(bare.text)}`,
  );
  console.log(
    `[transcribe.manual] hinted    (${primedMs.toFixed(0)}ms): ${JSON.stringify(primed.text)}`,
  );

  // It genuinely transcribed something, stamped with this engine's provenance.
  expect(bare.engine).toBe("ondevice-whisper");
  expect(bare.recordingId).toBe("manual-1");
  expect(bare.text.trim().length).toBeGreaterThan(0);
  // The jargon prompt must NOT leak into the transcript (worker slices the decoder prefix off).
  expect(primed.text.toLowerCase()).not.toContain("blower door, backdrafting");
}, 600_000);
