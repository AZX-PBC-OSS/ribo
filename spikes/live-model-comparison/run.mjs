#!/usr/bin/env node
/**
 * Live-model comparison spike, node half.
 *
 * Runs `compare.manual.ts` in headless Chromium, captures the `@@TIMINGS@@`/`@@FULL@@`/`@@LOAD@@`
 * lines it logs, and prints the one table this spike exists to produce: **latency against utterance
 * duration, per model**. Writes `results/timings.json` alongside.
 *
 *   node spikes/live-model-comparison/run.mjs
 *   COMPARE_MODELS=onnx-community/moonshine-base-ONNX node spikes/live-model-comparison/run.mjs
 *
 * Peak-RSS sampling is copied from `../transcription-measurement/run.mjs` and for the same reason:
 * the JS heap the page can read does NOT include the WASM/ORT arena where the model actually lives,
 * so the honest memory figure has to come from outside the browser. It matches only Playwright's
 * own Chromium so a developer's real Chrome is never counted, and `ps` RSS double-counts shared
 * pages across processes — so it is a CEILING, reported as one.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..");

let peakRssBytes = 0;
function sampleRss() {
  try {
    const out = execFileSync("ps", ["-axo", "rss=,command="], { encoding: "utf8" });
    let total = 0;
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      if (/ms-playwright/i.test(m[2])) total += Number(m[1]) * 1024;
    }
    if (total > peakRssBytes) peakRssBytes = total;
  } catch {
    /* ps hiccup — ignore this sample */
  }
}

const timings = [];
const fulls = [];
const loads = [];
const texts = [];

function consume(line) {
  for (const [tag, sink] of [
    ["TIMINGS", (v) => timings.push(...v)],
    ["FULL", (v) => fulls.push(v)],
    ["LOAD", (v) => loads.push(v)],
    ["TEXT", (v) => texts.push(v)],
  ]) {
    const marker = `@@${tag}@@`;
    const at = line.indexOf(marker);
    if (at === -1) continue;
    try {
      sink(JSON.parse(line.slice(at + marker.length)));
    } catch {
      /* a partial line — the next chunk carries the rest */
    }
    return;
  }
}

const child = spawn(
  "pnpm",
  ["exec", "vitest", "run", "--config", "spikes/live-model-comparison/vitest.compare.config.ts"],
  { cwd: REPO, env: process.env },
);

const sampler = setInterval(sampleRss, 500);
let buffer = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    process.stdout.write(chunk);
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
  });
}

const code = await new Promise((resolve) => child.on("close", resolve));
clearInterval(sampler);

if (timings.length === 0) {
  console.error("\nNo timings captured — the run failed before emitting any. See output above.");
  process.exit(code || 1);
}

// ---- the table ------------------------------------------------------------------------------------
// Median, not mean: a single GC pause or a scheduler hiccup in one of three runs would move a mean
// enough to invert the comparison this whole spike exists to make.
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const models = [...new Set(timings.map((t) => t.model))];
const durations = [...new Set(timings.map((t) => t.durationSec))].sort((a, b) => a - b);

const cell = (model, d) =>
  median(timings.filter((t) => t.model === model && t.durationSec === d).map((t) => t.ms));

console.log("\n\n── latency (ms, median) against utterance duration ──────────────────\n");
console.log(
  ["utterance".padEnd(12), ...models.map((m) => m.split("/").pop().padStart(22))].join(""),
);
for (const d of durations) {
  console.log(
    [`${String(d)}s`.padEnd(12), ...models.map((m) => cell(m, d).toFixed(0).padStart(22))].join(""),
  );
}

console.log("\n── flatness: longest / shortest ─────────────────────────────────────\n");
console.log("A ratio near 1.0 means cost is independent of utterance length — the padding");
console.log("signature. A ratio tracking the duration ratio means cost follows the audio.\n");
const durationRatio = durations[durations.length - 1] / durations[0];
for (const m of models) {
  const ratio = cell(m, durations[durations.length - 1]) / cell(m, durations[0]);
  console.log(
    `  ${m.split("/").pop().padEnd(26)} ${ratio.toFixed(2)}x   (audio grew ${durationRatio.toFixed(1)}x)`,
  );
}

console.log("\n── transcript at utterance length (the live-relevant quality) ───────\n");
for (const d of durations) {
  console.log(`  ${String(d)}s:`);
  for (const m of models) {
    const t = texts.find((x) => x.model === m && x.durationSec === d);
    console.log(
      `    ${m.split("/").pop().padEnd(24)} ${JSON.stringify((t?.text ?? "").trim().slice(0, 96))}`,
    );
  }
}

console.log("\n── full 54s fixture ─────────────────────────────────────────────────\n");
for (const f of fulls) {
  const load = loads.find((l) => l.model === f.model);
  console.log(`  ${f.model.split("/").pop()}`);
  console.log(
    `    wall ${(f.fullMs / 1000).toFixed(1)}s · RTF ${f.rtf.toFixed(3)} · load ${((load?.loadMs ?? 0) / 1000).toFixed(1)}s`,
  );
  console.log(`    ${f.text.trim().slice(0, 160)}…`);
}
console.log(`\n  peak Playwright-Chromium RSS (ceiling): ${(peakRssBytes / 1e6).toFixed(0)} MB\n`);

console.log("NOTE: Whisper truncates the 54s fixture to 30s, so its RTF above is over 30s of");
console.log("audio, not 54s, and its transcript stops early. Compare the per-utterance table,");
console.log("not the full-fixture RTF, across architectures.\n");

const outDir = join(HERE, "results");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "timings.json"),
  `${JSON.stringify({ timings, texts, fulls, loads, peakRssBytes }, null, 2)}\n`,
);
console.log(`Wrote ${join(outDir, "timings.json")}`);

process.exit(code);
