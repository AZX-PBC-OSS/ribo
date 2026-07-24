import { expect, test } from "vitest";

import {
  decodeTo16kMono,
  OnDeviceTranscriber,
} from "../../packages/ribo-transcriber-ondevice/src/index.js";

/**
 * Phase 3 Task 4 — the on-device transcription MEASUREMENT spike (browser half).
 *
 * MANUAL, OPT-IN. Runs only under vitest.measure.config.ts — never in ./check.sh. It fetches each
 * synthesized-audio segment (synth.mjs), runs it through the REAL OnDeviceTranscriber (WASM device,
 * fp32 — the headless-feasible path Task 3 measured), and emits the transcripts + timings as
 * @@MEASURE@@ / @@MODELMETA@@ JSON lines that run.mjs captures from stdout. WER, extraction, and
 * scoring happen in node afterwards.
 *
 * The chunking (multiple <=24s segments per transcript) is done in synth.mjs, at HARNESS level: the
 * transcriber itself is unchanged and still 30s-bound; we concatenate its per-segment output.
 *
 * TTS audio is a FLOOR, not a forecast (no noise / mic handling / disfluency / cross-talk).
 */
declare const __ORT_WASM_BASE__: string;
declare const __MANIFEST_URL__: string;
declare const __MODEL_ID__: string;
declare const __LIMIT__: string;
declare const __UNHINTED_SLUGS__: string;

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

interface Segment {
  wav: string;
  words: number;
  durationSec: number;
}
interface ManifestEntry {
  slug: string;
  sourceText: string;
  segments: Segment[];
  totalWords: number;
  totalDurationSec: number;
}

function makeTranscriber(hinted: boolean): OnDeviceTranscriber {
  return new OnDeviceTranscriber({
    modelId: __MODEL_ID__,
    device: "wasm", // headless-feasible + deterministic; WebGPU is not reachable in this environment.
    dtype: "fp32", // q4/q8 do not load on the pinned ORT build (Task 2); fp32 is proven.
    ...(hinted ? { hints: { vocabulary: VOCABULARY } } : {}),
    wasmPaths: __ORT_WASM_BASE__,
    createWorker: () =>
      new Worker(
        new URL("../../packages/ribo-transcriber-ondevice/src/worker.ts", import.meta.url),
        { type: "module" },
      ),
  });
}

const wavUrl = (wav: string): string =>
  __MANIFEST_URL__.replace(/manifest\.json$/, encodeURIComponent(wav));

function heapNow(): number {
  const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  return mem?.usedJSHeapSize ?? 0;
}

/** Prime a transcriber, measuring the load and whether any bytes actually streamed off the network. */
async function primeMeasured(
  t: OnDeviceTranscriber,
): Promise<{ ms: number; downloadedBytes: number }> {
  let downloadedBytes = 0;
  const t0 = performance.now();
  await t.prime((p) => {
    // Each vitest browser run gets a fresh context, so the Cache API starts empty and the first
    // prime streams the weights; summing the per-file `total`s at `done` approximates the transfer.
    if (p.stage === "done") downloadedBytes += 0;
    if (p.stage === "progress" && typeof p.total === "number") {
      downloadedBytes = Math.max(downloadedBytes, p.loaded ?? 0);
    }
  });
  return { ms: performance.now() - t0, downloadedBytes };
}

async function runCorpus(
  t: OnDeviceTranscriber,
  entries: ManifestEntry[],
  hinted: boolean,
  onHeap: (bytes: number) => void,
): Promise<void> {
  for (const entry of entries) {
    let audioSec = 0;
    let processMs = 0;
    const parts: string[] = [];
    for (const seg of entry.segments) {
      const audio = await (await fetch(wavUrl(seg.wav))).blob();
      const samples = await decodeTo16kMono(audio);
      audioSec += samples.length / 16_000;
      const recording = {
        id: `${entry.slug}--${seg.wav}`,
        capturedAt: "2026-07-23T10:00:00.000Z",
        durationMs: 0,
        mimeType: "audio/wav",
        ctx: {},
      };
      const s0 = performance.now();
      const out = await t.transcribe(recording, audio);
      processMs += performance.now() - s0;
      parts.push(out.text.trim());
      onHeap(heapNow());
    }
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    console.log(
      `@@MEASURE@@ ${JSON.stringify({
        model: __MODEL_ID__,
        slug: entry.slug,
        hinted,
        text,
        audioSec,
        processMs,
        segments: entry.segments.length,
      })}`,
    );
  }
}

test("measure on-device transcription across the corpus", async () => {
  const manifest = (await (await fetch(__MANIFEST_URL__)).json()) as {
    transcripts: ManifestEntry[];
  };
  let entries = manifest.transcripts;
  const limit = Number(__LIMIT__);
  if (Number.isFinite(limit) && limit > 0) entries = entries.slice(0, limit);

  let heapPeak = 0;
  const onHeap = (b: number): void => {
    if (b > heapPeak) heapPeak = b;
  };

  // Hinted pass (production config) over the whole corpus — these transcripts feed Part B.
  const hinted = makeTranscriber(true);
  // COLD: fresh browser context => empty Cache API => this streams the weights off the network AND
  // builds the ORT session. The true first-ever-load cost.
  const cold = await primeMeasured(hinted);
  // WARM (memoized): second prime on the SAME worker returns the in-memory pipeline — ~0.
  const warmReprime = await primeMeasured(hinted);
  await runCorpus(hinted, entries, true, onHeap);
  hinted.dispose();

  // WARM (from cache): a BRAND-NEW worker, so a cold ORT session, but the weights are now in the
  // Cache API this session populated — reads them back with NO network. The returning-user load.
  const warmCacheT = makeTranscriber(true);
  const warmCache = await primeMeasured(warmCacheT);
  warmCacheT.dispose();

  // Optional unhinted subset for the hint-delta.
  const unhintedSlugs = new Set(
    __UNHINTED_SLUGS__
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (unhintedSlugs.size > 0) {
    const subset = entries.filter((e) => unhintedSlugs.has(e.slug));
    const plain = makeTranscriber(false);
    await plain.prime();
    await runCorpus(plain, subset, false, onHeap);
    plain.dispose();
  }

  console.log(
    `@@MODELMETA@@ ${JSON.stringify({
      model: __MODEL_ID__,
      coldPrimeMs: cold.ms, // network download + ORT session build (fresh context, empty cache)
      warmReprimeMs: warmReprime.ms, // same worker, memoized pipeline (~0)
      warmCachePrimeMs: warmCache.ms, // fresh worker, weights from Cache API, no network
      coldDownloadPeakFileBytes: cold.downloadedBytes,
      warmCacheDownloadPeakFileBytes: warmCache.downloadedBytes, // ~0 confirms the cache hit
      jsHeapPeakBytes: heapPeak,
      transcripts: entries.length,
    })}`,
  );

  expect(entries.length).toBeGreaterThan(0);
}, 1_800_000);
