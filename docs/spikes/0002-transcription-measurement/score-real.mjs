#!/usr/bin/env node
/**
 * Consolidates the two engines' real-audio runs into the ONE committed artifact for this ticket:
 * `results/real/metrics-real.json` — aggregate RTF/WER numbers, never transcript text.
 *
 * For a slug with no `testdata/real/ground-truth/<slug>.txt` yet, writes starting drafts
 * (`<slug>.draft-ondevice.txt` / `<slug>.draft-managed.txt`, both git-ignored) from whichever raw runs
 * exist, reports RTF/timing only, and leaves `wer: null` — there is no ground truth to score against
 * until a human corrects one of those drafts by ear. Re-run this script after doing that.
 *
 * Usage:
 *   node docs/spikes/0002-transcription-measurement/run-real-ondevice.mjs      # writes _raw/ondevice.json
 *                                                                  # (defaults to the on-device
 *                                                                  #  package's DEFAULT_MODEL_ID)
 *   node docs/spikes/0002-transcription-measurement/transcribe-managed-real.mjs # writes _raw/managed.json
 *   node docs/spikes/0002-transcription-measurement/score-real.mjs             # this script
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { wer } from "./wer.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RAW_DIR = join(HERE, "results", "real", "_raw");
const GT_DIR = join(HERE, "testdata", "real", "ground-truth");
const RESULTS_DIR = join(HERE, "results", "real");

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

const ondevice = readJson(join(RAW_DIR, "ondevice.json"));
const managed = readJson(join(RAW_DIR, "managed.json"));
if (!ondevice && !managed) {
  console.error(
    "[score] no raw results found — run run-real-ondevice.mjs and/or transcribe-managed-real.mjs first.",
  );
  process.exit(1);
}

const byslug = new Map();
for (const r of ondevice?.results ?? []) {
  byslug.set(r.slug, { ...byslug.get(r.slug), slug: r.slug, ondevice: r });
}
for (const r of managed?.results ?? []) {
  byslug.set(r.slug, { ...byslug.get(r.slug), slug: r.slug, managed: r });
}

mkdirSync(GT_DIR, { recursive: true });
mkdirSync(RESULTS_DIR, { recursive: true });

const perFile = [];
const groundTruthPending = [];

for (const entry of byslug.values()) {
  const gtPath = join(GT_DIR, `${entry.slug}.txt`);
  const hasGroundTruth = existsSync(gtPath);

  if (!hasGroundTruth) {
    groundTruthPending.push(entry.slug);
    if (entry.ondevice) {
      writeFileSync(join(GT_DIR, `${entry.slug}.draft-ondevice.txt`), `${entry.ondevice.text}\n`);
    }
    if (entry.managed) {
      writeFileSync(join(GT_DIR, `${entry.slug}.draft-managed.txt`), `${entry.managed.text}\n`);
    }
  }

  const groundTruth = hasGroundTruth ? readFileSync(gtPath, "utf8").trim() : null;
  // The managed engine's own run doesn't decode audio locally, so it has no audioSec of its own —
  // both engines transcribed the same file, so the on-device pass's decoded duration applies to
  // either one's RTF.
  const audioSecForSlug = entry.ondevice?.audioSec ?? entry.managed?.audioSec ?? null;

  const score = (r) => {
    if (!r) return null;
    const w = groundTruth ? wer(groundTruth, r.text) : null;
    const audioSec = r.audioSec ?? audioSecForSlug;
    return {
      audioSec: audioSec ?? null,
      processMs: r.processMs,
      rtf: r.rtf ?? (audioSec ? Number((r.processMs / 1000 / audioSec).toFixed(3)) : null),
      wer: w ? Number(w.wer.toFixed(4)) : null,
      sub: w?.sub ?? null,
      del: w?.del ?? null,
      ins: w?.ins ?? null,
      refWords: w?.refWords ?? null,
    };
  };

  // Cross-engine agreement needs no ground truth — it's just how far apart the two engines land on
  // the SAME real audio, which (per the ticket) has never been measured because they'd never
  // transcribed the same clip before. Not an accuracy figure: neither side is "correct" here.
  const agreement =
    entry.ondevice && entry.managed
      ? Number(wer(entry.managed.text, entry.ondevice.text).wer.toFixed(4))
      : null;

  perFile.push({
    slug: entry.slug,
    hasGroundTruth,
    ondevice: score(entry.ondevice),
    managed: score(entry.managed),
    ondeviceVsManagedWordDiffRate: agreement,
  });
}

perFile.sort((a, b) => a.slug.localeCompare(b.slug));

const metrics = {
  generatedAt: new Date().toISOString(),
  note: "Real field recordings — 2 clips, not a statistically meaningful sample. See doc 14 for the TTS-corpus floor these are checked against.",
  perFile,
  groundTruthPending,
};

const outPath = join(RESULTS_DIR, "metrics-real.json");
writeFileSync(outPath, `${JSON.stringify(metrics, null, 2)}\n`);
console.log(`[score] wrote ${outPath}`);

for (const f of perFile) {
  const wOn = f.ondevice?.wer;
  const wMg = f.managed?.wer;
  console.log(
    `[score] ${f.slug}: on-device RTF=${f.ondevice?.rtf ?? "?"} WER=${wOn == null ? "(no ground truth)" : `${(wOn * 100).toFixed(1)}%`}` +
      ` | managed WER=${wMg == null ? "(no ground truth)" : `${(wMg * 100).toFixed(1)}%`}`,
  );
}
if (groundTruthPending.length > 0) {
  console.log(
    `\n[score] no ground truth yet for: ${groundTruthPending.join(", ")}\n` +
      "[score] drafts written to testdata/real/ground-truth/<slug>.draft-{ondevice,managed}.txt — " +
      "correct one by ear into <slug>.txt, then re-run this script.",
  );
}
