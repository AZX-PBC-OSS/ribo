import { test } from "vitest";

import { CALIBRATION_CLIP_DURATION_MS, calibrationClip } from "./calibration-clip.js";
import { OnDeviceTranscriber } from "./index.js";

/**
 * What the calibration clip actually says. Quantization damage shows up as drift from
 * this, so the probe prints the transcript rather than asserting on it — the interesting
 * failure is a dtype that loads and then returns plausible nonsense, which no session-
 * creation check can see and no exact-match assertion would describe usefully.
 */
const EXPECTED =
  "The attic insulation is fiberglass batts with visible gaps near the eaves and the furnace is a condensing unit.";

/**
 * OPT-IN, NOT GATED. Runs only under `vitest.manual.config.ts` — never in `./check.sh`.
 *
 * **The question.** `config.ts` ships fp32 because "q4/q8 do not load on the ORT build
 * transformers.js 4.2.0 pins", and `prime.manual.ts` records the observation behind it:
 * the 4-bit `MatMulNBits` path "rejects for tiny.en on WASM (both q4 and q8 variants fail
 * session creation)". Two qualifiers make that worth re-running rather than inheriting:
 * it was measured on **WASM only**, and `prime.manual.ts` itself says "Task 3/4 pick the
 * production dtype" — Task 3 has now landed, so this is that decision coming due.
 *
 * It matters because of memory, not bytes. Peak RSS was measured at ~3.5 GB for
 * base.en fp32 on clips of 30 s or less. The pilot device is a Surface Go 3 with 4–8 GB,
 * and an out-of-memory kill does not fire `error` — the worker simply dies, which is the
 * failure `workerTimeoutMs` exists to convert into something retryable.
 *
 *   pnpm exec vitest run --config packages/ribo-transcriber-ondevice/vitest.manual.config.ts \
 *     packages/ribo-transcriber-ondevice/src/dtype-probe.manual.ts
 *
 * **This probes session creation, not accuracy.** A dtype that loads still has to be
 * measured against the corpus before it ships; a dtype that cannot load needs no such
 * measurement. Loading is the cheaper question and it gates the other one.
 *
 * Every combination is reported whether it passes or fails — the failures are the finding.
 * The test therefore does not assert; it prints a table and always passes, because "q4
 * still rejects on WASM" is a result worth recording, not a red run.
 */
declare const __ORT_WASM_BASE__: string;

/** Smallest variant of each family — session creation is what is under test, not quality. */
const MODELS = ["onnx-community/moonshine-tiny-ONNX", "onnx-community/whisper-tiny.en"] as const;

/**
 * `fp32` is the incumbent and the control: if it fails, the harness is wrong rather than
 * the dtype. The rest are the candidates that would cut both download and resident memory.
 */
const DTYPES = ["fp32", "fp16", "q8", "int8", "q4"] as const;

/**
 * WASM is the documented failure; WebGPU has never been tried and is the open half.
 *
 * **A WebGPU run needs a real GPU adapter**, which headless Chromium does not have — it
 * reports `Failed to get GPU adapter` for every dtype alike, which is an absence of a
 * device rather than a verdict on any dtype. Re-run headed to get a real answer:
 *
 *   RIBO_PROBE_DEVICES=webgpu pnpm exec vitest run \
 *     --config packages/ribo-transcriber-ondevice/vitest.manual.config.ts \
 *     --browser.headless=false packages/ribo-transcriber-ondevice/src/dtype-probe.manual.ts
 */
const DEVICES = ["wasm", "webgpu"] as const;

/** Narrow the sweep. A full pass is minutes of real downloads; iterating on one cell should not be. */
function selected<T extends readonly string[]>(all: T, envVar: string): string[] {
  const raw = (import.meta as { env?: Record<string, string> }).env?.[envVar];
  if (!raw) return [...all];
  const wanted = raw.split(",").map((s) => s.trim());
  return all.filter((v) => wanted.includes(v));
}

interface Outcome {
  readonly model: string;
  readonly dtype: string;
  readonly device: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}

/** One combination, isolated: a worker that dies must not take the next probe with it. */
async function probe(model: string, dtype: string, device: string): Promise<Outcome> {
  const transcriber = new OnDeviceTranscriber({
    modelId: model,
    device: device as "wasm" | "webgpu",
    dtype: dtype as never,
    wasmPaths: __ORT_WASM_BASE__,
    // Generous: a cold fetch of even a tiny model over a real network is slow, and a
    // timeout here would be indistinguishable from the rejection we are looking for.
    workerTimeoutMs: 240_000,
    createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  });
  const start = performance.now();
  try {
    await transcriber.prime();
    // Loading is not correctness. transformers.js #1317 reports a q8 decoder that created a
    // session happily and then produced wrong text, so a probe that stops at `prime()` would
    // green-light exactly the failure worth catching.
    const text = await transcriber.transcribe(
      {
        id: "dtype-probe",
        capturedAt: "2026-08-17T00:00:00.000Z",
        durationMs: CALIBRATION_CLIP_DURATION_MS,
        mimeType: "audio/webm;codecs=opus",
        ctx: {},
      },
      calibrationClip(),
    );
    return {
      model,
      dtype,
      device,
      ok: true,
      ms: performance.now() - start,
      detail: text.text.trim(),
    };
  } catch (cause) {
    return {
      model,
      dtype,
      device,
      ok: false,
      ms: performance.now() - start,
      detail: (cause instanceof Error ? cause.message : String(cause))
        .replace(/\s+/g, " ")
        .slice(0, 160),
    };
  } finally {
    transcriber.dispose();
  }
}

test("which (model, dtype, device) combinations create a session at all", async () => {
  const results: Outcome[] = [];
  const models = selected(MODELS, "VITE_RIBO_PROBE_MODELS");
  const devices = selected(DEVICES, "VITE_RIBO_PROBE_DEVICES");
  const dtypes = selected(DTYPES, "VITE_RIBO_PROBE_DTYPES");
  for (const model of models) {
    for (const device of devices) {
      for (const dtype of dtypes) {
        const outcome = await probe(model, dtype, device);
        results.push(outcome);
        // Printed as it goes: a run that dies partway still leaves evidence, and a full
        // sweep is minutes of real downloads.
        console.log(
          `${outcome.ok ? "LOADS " : "FAILS "} ${model.split("/")[1]} ${device}/${dtype} ` +
            `${Math.round(outcome.ms)}ms ${outcome.detail}`,
        );
      }
    }
  }

  console.log("\n=== dtype probe summary ===");
  for (const r of results) {
    console.log(
      [
        r.model,
        r.device,
        r.dtype,
        r.ok ? "LOADS" : "FAILS",
        `${Math.round(r.ms)}ms`,
        r.detail,
      ].join(" | "),
    );
  }
  const loaded = results.filter((r) => r.ok);
  console.log(`\n${loaded.length} of ${results.length} combinations created a session.`);
  console.log(`\nexpected transcript:\n  ${EXPECTED}`);
}, 3_600_000);
