#!/usr/bin/env node
/**
 * Node driver for `measure-real.manual.ts` — runs the real, unmodified `OnDeviceTranscriber` over
 * every file in `testdata/real/` and captures the `@@MEASURE@@` JSON it logs.
 *
 * Writes:
 *   results/real/_raw/ondevice.json   raw transcript text + timing (git-ignored — has real speech text)
 *
 * `score-real.mjs` is what turns this into the committed, numbers-only `results/real/metrics-real.json`.
 *
 * Usage:
 *   node docs/spikes/0002-transcription-measurement/run-real-ondevice.mjs [modelId]
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_MODEL_ID } from "@azx/ribo-transcriber-ondevice";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..");
const RAW_DIR = join(HERE, "results", "real", "_raw");

// Default to the same model the on-device package ships, not an arbitrary
// hardcoded id. Source of truth: packages/ribo-transcriber-ondevice/src/config.ts.
const modelId = process.argv[2] ?? DEFAULT_MODEL_ID;

const measures = [];
let buf = "";
function ingest(chunk) {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const mm = line.indexOf("@@MEASURE@@ ");
    if (mm !== -1) {
      try {
        measures.push(JSON.parse(line.slice(mm + "@@MEASURE@@ ".length)));
      } catch {
        /* partial/garbled — skip */
      }
    }
  }
}

console.log(`[run-real] model=${modelId}`);
const child = spawn(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--config",
    "docs/spikes/0002-transcription-measurement/vitest.measure-real.config.ts",
  ],
  { cwd: REPO, env: { ...process.env, MEASURE_MODEL: modelId } },
);

child.stdout.on("data", (d) => {
  const s = d.toString();
  ingest(s);
  process.stdout.write(s);
});
child.stderr.on("data", (d) => process.stderr.write(d));

child.on("close", (code) => {
  if (code !== 0) {
    console.error(`[run-real] vitest exited ${code}`);
    process.exit(code ?? 1);
  }
  finish();
});

function finish() {
  mkdirSync(RAW_DIR, { recursive: true });
  const results = measures.map((m) => ({
    slug: m.slug,
    text: m.text,
    audioSec: Number(m.audioSec.toFixed(2)),
    processMs: Math.round(m.processMs),
    rtf: Number((m.processMs / 1000 / m.audioSec).toFixed(3)),
  }));
  const outPath = join(RAW_DIR, "ondevice.json");
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: modelId,
        device: "wasm",
        dtype: "fp32",
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[run-real] wrote ${outPath}`);
  for (const r of results) {
    console.log(`[run-real] ${r.slug}: ${r.audioSec}s audio, RTF=${r.rtf}`);
  }
}
