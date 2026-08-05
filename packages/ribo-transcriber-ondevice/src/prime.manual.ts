import { expect, test } from "vitest";

import { OnDeviceTranscriber, isModelCached } from "./index.js";
import type { PrimeProgress } from "./protocol.js";

/**
 * OPT-IN, NOT GATED. Runs only under `vitest.manual.config.ts` — never in `./check.sh`. It performs
 * a real network download of `whisper-tiny.en` (the smallest model that exercises the same code
 * path as `base.en`) and proves the whole Task 2 claim end to end against real bytes.
 *
 *   pnpm exec vitest run --config packages/ribo-transcriber-ondevice/vitest.manual.config.ts
 *
 * `__ORT_WASM_BASE__` is injected by that config: a same-origin `/@fs/` URL for the ORT runtime,
 * standing in for the static directory a real consumer serves the wasm from.
 */
declare const __ORT_WASM_BASE__: string;

const MODEL = "Xenova/whisper-tiny.en";
const CACHE = "transformers-cache";

function makeTranscriber(): OnDeviceTranscriber {
  return new OnDeviceTranscriber({
    modelId: MODEL,
    // Deterministic across headless Chromium (WebGPU may or may not be present): the WASM build is
    // always available, and priming loads it via the same-origin wasmPaths.
    device: "wasm",
    // fp32 avoids the quantized decoder weights, whose 4-bit MatMulNBits path this ORT dev build
    // rejects for tiny.en on WASM (both q4 and q8 variants fail session creation). Immaterial to
    // Task 2 (we prove download+cache, not inference); Task 3/4 pick the production dtype against
    // measured accuracy. This is also a real Task-3 finding — see the report.
    dtype: "fp32",
    wasmPaths: __ORT_WASM_BASE__,
    // The consumer constructs the worker in their own bundler context (AGENTS §5.2). Here the test
    // acts as that consumer; Vite bundles `./worker.ts` (and transformers) for the worker.
    createWorker: () => new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
  });
}

async function timedPrime(): Promise<{ ms: number; progress: PrimeProgress[] }> {
  const transcriber = makeTranscriber();
  const progress: PrimeProgress[] = [];
  const start = performance.now();
  await transcriber.prime((event) => progress.push(event));
  const ms = performance.now() - start;
  transcriber.dispose();
  return { ms, progress };
}

test("real whisper-tiny.en: downloads with progress, caches, second load is warm", async () => {
  // Start from a cold cache so the false→true flip is real, not incidental.
  await caches.delete(CACHE);
  expect(await isModelCached(MODEL)).toBe(false);

  // ── Cold: real network download ──────────────────────────────────────────────────────────────
  const cold = await timedPrime();

  const byteEvents = cold.progress.filter((event) => event.stage === "progress");
  expect(byteEvents.length).toBeGreaterThan(0);
  // The progress carried real, drivable byte counts (loaded/total per file) — enough for a bar.
  const withBytes = byteEvents.find((event) => event.stage === "progress" && event.total > 0);
  expect(withBytes).toBeDefined();

  // The flip: not cached → cached, across the prime. This is the load-bearing cache proof.
  expect(await isModelCached(MODEL)).toBe(true);

  // ── Warm: same page, fresh transcriber — capability now reads `ready` from cache ───────────────
  await expect(makeTranscriber().capability()).resolves.toEqual({ status: "ready" });

  // A second prime succeeds and is dramatically faster: no ~MB network download, just a cache read
  // plus ORT init. (transformers.js still fires `progress` while streaming the cached response, so
  // absence-of-progress is NOT the signal — the time gap and the is-cached flip are.)
  const warm = await timedPrime();

  console.log(`[prime.manual] cold=${cold.ms.toFixed(0)}ms warm=${warm.ms.toFixed(0)}ms`);
  expect(warm.ms).toBeLessThan(cold.ms);
}, 300_000);
