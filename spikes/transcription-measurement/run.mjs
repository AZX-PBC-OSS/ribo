#!/usr/bin/env node
/**
 * Phase 3 Task 4 orchestrator (Part A). Runs the browser measurement for ONE model, sampling the
 * headless-Chromium process RSS the whole time (the honest "peak memory" — the JS heap the test can
 * read from inside the page does NOT include the WASM/ORT arena where the ~290 MB model actually
 * lives). Captures the @@MEASURE@@/@@MODELMETA@@ JSON the test logs, computes WER against the authored
 * source text, and writes:
 *
 *   results/ondevice/<modelSlug>/<slug>.txt            hinted on-device transcript (feeds Part B)
 *   results/ondevice/<modelSlug>/<slug>.unhinted.txt   unhinted transcript (hint-delta subset)
 *   results/metrics-<modelSlug>.json                   per-transcript RTF+WER + load times + peak RSS
 *
 * Usage:
 *   node spikes/transcription-measurement/run.mjs <modelId> [unhintedSlugsCsv] [limit]
 *   node spikes/transcription-measurement/run.mjs Xenova/whisper-base.en 01-attic-r-value-shell,05-full-walkthrough,07-combustion-safety
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { wer } from "./wer.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..");

const modelId = process.argv[2] ?? "Xenova/whisper-base.en";
const unhintedSlugs = process.argv[3] ?? "";
const limit = process.argv[4] ?? "";
// Optional tag (5th arg) isolates a throwaway run (e.g. a short memory-only sample) so it does not
// clobber the canonical full-corpus outputs.
const tag = process.argv[5] ?? "";
const modelSlug = modelId.split("/").pop() + (tag ? `-${tag}` : "");

const manifest = JSON.parse(readFileSync(join(HERE, "testdata", "manifest.json"), "utf8"));
const sourceBySlug = Object.fromEntries(manifest.transcripts.map((t) => [t.slug, t.sourceText]));

// ---- sample the headless-browser RSS while the run is live ----------------------------------------
// Match the FULL command against the ms-playwright cache path, so we sum ONLY Playwright's own
// Chromium (all its helper/renderer processes) and never the developer's real Google Chrome. `ps`
// RSS double-counts shared pages across processes, so this over-counts a little — a ceiling, not an
// exact figure; reported as such.
let peakRssBytes = 0;
function sampleRss() {
  try {
    const out = execFileSync("ps", ["-axo", "rss=,command="], { encoding: "utf8" });
    let total = 0;
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      if (/ms-playwright/i.test(m[2])) total += Number(m[1]) * 1024; // ps rss is in KiB
    }
    if (total > peakRssBytes) peakRssBytes = total;
  } catch {
    /* ps hiccup — ignore this sample */
  }
}

// ---- run vitest, capturing stdout -----------------------------------------------------------------
const measures = [];
let modelMeta = null;
let buf = "";

function ingest(chunk) {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const mm = line.indexOf("@@MEASURE@@ ");
    const md = line.indexOf("@@MODELMETA@@ ");
    if (mm !== -1) {
      try {
        measures.push(JSON.parse(line.slice(mm + "@@MEASURE@@ ".length)));
      } catch {
        /* partial/garbled — skip */
      }
    } else if (md !== -1) {
      try {
        modelMeta = JSON.parse(line.slice(md + "@@MODELMETA@@ ".length));
      } catch {
        /* skip */
      }
    }
  }
}

console.log(`[run] model=${modelId} unhinted=[${unhintedSlugs}] limit=${limit || "all"}`);
const child = spawn(
  "pnpm",
  [
    "exec",
    "vitest",
    "run",
    "--config",
    "spikes/transcription-measurement/vitest.measure.config.ts",
  ],
  {
    cwd: REPO,
    env: {
      ...process.env,
      MEASURE_MODEL: modelId,
      MEASURE_UNHINTED_SLUGS: unhintedSlugs,
      MEASURE_LIMIT: limit,
    },
  },
);

const rssTimer = setInterval(sampleRss, 500);
child.stdout.on("data", (d) => {
  const s = d.toString();
  ingest(s);
  process.stdout.write(s);
});
child.stderr.on("data", (d) => process.stderr.write(d));

child.on("close", (code) => {
  clearInterval(rssTimer);
  if (code !== 0) {
    console.error(`[run] vitest exited ${code}`);
    process.exit(code ?? 1);
  }
  finish();
});

function finish() {
  const outDir = join(HERE, "results", "ondevice", modelSlug);
  mkdirSync(outDir, { recursive: true });

  const perTranscript = [];
  let totAudio = 0;
  let totProcess = 0;
  let totRefWords = 0;
  let totErrors = 0;

  for (const m of measures.filter((x) => x.hinted)) {
    const source = sourceBySlug[m.slug] ?? "";
    writeFileSync(join(outDir, `${m.slug}.txt`), `${m.text}\n`);
    const w = wer(source, m.text);
    const rtf = m.processMs / 1000 / m.audioSec;
    totAudio += m.audioSec;
    totProcess += m.processMs;
    totRefWords += w.refWords;
    totErrors += w.sub + w.del + w.ins;
    perTranscript.push({
      slug: m.slug,
      audioSec: Number(m.audioSec.toFixed(2)),
      processMs: Math.round(m.processMs),
      rtf: Number(rtf.toFixed(3)),
      wer: Number(w.wer.toFixed(4)),
      sub: w.sub,
      del: w.del,
      ins: w.ins,
      refWords: w.refWords,
      segments: m.segments,
    });
  }

  const unhinted = [];
  for (const m of measures.filter((x) => !x.hinted)) {
    writeFileSync(join(outDir, `${m.slug}.unhinted.txt`), `${m.text}\n`);
    const source = sourceBySlug[m.slug] ?? "";
    const wh = wer(source, m.text);
    const hintedMeasure = measures.find((x) => x.hinted && x.slug === m.slug);
    const hintedWer = hintedMeasure ? wer(source, hintedMeasure.text).wer : null;
    unhinted.push({
      slug: m.slug,
      unhintedWer: Number(wh.wer.toFixed(4)),
      hintedWer: hintedWer === null ? null : Number(hintedWer.toFixed(4)),
      delta: hintedWer === null ? null : Number((wh.wer - hintedWer).toFixed(4)),
    });
  }

  const corpusWer = totRefWords === 0 ? 0 : totErrors / totRefWords;
  const corpusRtf = totAudio === 0 ? 0 : totProcess / 1000 / totAudio;

  const metrics = {
    generatedAt: new Date().toISOString(),
    model: modelId,
    device: "wasm",
    dtype: "fp32",
    modelMeta,
    peakChromiumRssBytes: peakRssBytes,
    corpus: {
      transcripts: perTranscript.length,
      totalAudioSec: Number(totAudio.toFixed(1)),
      totalProcessMs: Math.round(totProcess),
      corpusRtf: Number(corpusRtf.toFixed(3)),
      corpusWer: Number(corpusWer.toFixed(4)),
      totalRefWords: totRefWords,
    },
    perTranscript,
    hintDelta: unhinted,
  };
  const metricsPath = join(HERE, "results", `metrics-${modelSlug}.json`);
  mkdirSync(join(HERE, "results"), { recursive: true });
  writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);

  console.log(
    `\n[run] ${modelSlug}: corpus RTF=${corpusRtf.toFixed(3)} WER=${(corpusWer * 100).toFixed(1)}%`,
  );
  console.log(`[run] peak Chromium RSS=${(peakRssBytes / 1e6).toFixed(0)} MB`);
  console.log(`[run] wrote ${metricsPath}`);
  console.log(`[run] wrote ${perTranscript.length} on-device transcripts to ${outDir}`);
}
