#!/usr/bin/env node
/**
 * Phase 3 Task 4 — Part B: the transcription->extraction interaction.
 *
 *   node spikes/transcription-measurement/score-partb.mjs <codex|opencode> <modelSlug>
 *
 * Scores the extraction outputs produced from the ON-DEVICE (noisy) transcripts, using score.mjs's
 * exported scoring — but feeding the NOISY transcript as the span-check text (a sourceSpan is verbatim
 * to what the extraction model actually SAW, so honesty of provenance is judged against the noisy
 * text, not the clean authored text). Then diffs the headline hazard rates against the committed
 * clean-text baseline (extraction-snuggpro/results/<extractor>-score.json).
 *
 * Writes results/partb-<modelSlug>-<extractor>-score.json and prints the delta table.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { aggregate, loadResult, scoreTranscript } from "../extraction-snuggpro/score.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SPIKE = join(HERE, "..", "extraction-snuggpro");

const extractor = process.argv[2];
const modelSlug = process.argv[3];
if (!["codex", "opencode"].includes(extractor) || !modelSlug) {
  console.error("usage: score-partb.mjs <codex|opencode> <modelSlug>");
  process.exit(1);
}

const GT_DIR = join(SPIKE, "ground-truth");
const ondeviceDir = join(HERE, "results", "ondevice", modelSlug);
const extractDir = join(HERE, "results", "extract", modelSlug, extractor);

const slugs = readdirSync(GT_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

const reports = [];
for (const slug of slugs) {
  const gt = JSON.parse(readFileSync(join(GT_DIR, `${slug}.json`), "utf8"));
  const tPath = join(ondeviceDir, `${slug}.txt`);
  const transcript = existsSync(tPath) ? readFileSync(tPath, "utf8") : "";
  const loaded = loadResult(extractDir, slug);
  reports.push(scoreTranscript(slug, gt, transcript, loaded.data, loaded.problem));
}

const { scored, totals, axisTally } = aggregate(reports);

function rates(t, ax) {
  const missDen = t.gtNonNull - t.missExcused;
  const hCorrect = t.hCorrectNull + t.hCorrectState;
  const hWrong =
    t.hHallucinatedPass + t.hHallucinatedProblem + t.hCleanDropped + t.hMiss + t.hWrongState;
  return {
    hallucinationHardRate: t.hallucinationHard / t.gtNull,
    hallucinationHard: t.hallucinationHard,
    missRate: t.miss / missDen,
    miss: t.miss,
    bothNonNullAccuracy: t.correct / (t.correct + t.wrong),
    wrong: t.wrong,
    enumAccuracy: t.enumGtMember ? t.enumCorrect / t.enumGtMember : null,
    bandAccuracy: t.bandGt ? t.bandCorrect / t.bandGt : null,
    fuelDropped: ax.fuelDropped ?? 0,
    fuelInvented: ax.fuelInvented ?? 0,
    healthHallucinatedPass: t.hHallucinatedPass,
    healthCleanDropped: t.hCleanDropped,
    healthStateAccuracy: hCorrect / (hCorrect + hWrong),
    spanVerbatimRate: t.spanChecked ? t.spanVerbatim / t.spanChecked : null,
    spanChecked: t.spanChecked,
    spanNearMiss: t.spanNearMiss,
    spanFabricated: t.spanFabricated,
    spanMissing: t.spanMissing,
  };
}

const noisy = rates(totals, axisTally);

// ---- baseline (clean text) ------------------------------------------------------------------------
const baselinePath = join(SPIKE, "results", `${extractor}-score.json`);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const clean = rates(baseline.totals, baseline.axisTally);

const pct = (x) => (x === null || x === undefined ? "n/a" : `${(100 * x).toFixed(1)}%`);
const fnum = (x) => String(x);

const rows = [
  ["hallucination (hard) rate", pct(clean.hallucinationHardRate), pct(noisy.hallucinationHardRate)],
  ["  hard hallucinations (count)", fnum(clean.hallucinationHard), fnum(noisy.hallucinationHard)],
  ["miss rate", pct(clean.missRate), pct(noisy.missRate)],
  ["  misses (count)", fnum(clean.miss), fnum(noisy.miss)],
  ["both-non-null accuracy", pct(clean.bothNonNullAccuracy), pct(noisy.bothNonNullAccuracy)],
  ["  wrong values (count)", fnum(clean.wrong), fnum(noisy.wrong)],
  ["enum member accuracy", pct(clean.enumAccuracy), pct(noisy.enumAccuracy)],
  ["band accuracy", pct(clean.bandAccuracy), pct(noisy.bandAccuracy)],
  ["axis: fuel DROPPED", fnum(clean.fuelDropped), fnum(noisy.fuelDropped)],
  ["axis: fuel INVENTED (08)", fnum(clean.fuelInvented), fnum(noisy.fuelInvented)],
  [
    "health: HALLUCINATED PASS",
    fnum(clean.healthHallucinatedPass),
    fnum(noisy.healthHallucinatedPass),
  ],
  ["health: clean dropped->null", fnum(clean.healthCleanDropped), fnum(noisy.healthCleanDropped)],
  ["health: state accuracy", pct(clean.healthStateAccuracy), pct(noisy.healthStateAccuracy)],
  ["sourceSpan verbatim rate", pct(clean.spanVerbatimRate), pct(noisy.spanVerbatimRate)],
  ["  spans checked (count)", fnum(clean.spanChecked), fnum(noisy.spanChecked)],
  [
    "  near-miss / fabricated / missing",
    `${clean.spanNearMiss}/${clean.spanFabricated}/${clean.spanMissing}`,
    `${noisy.spanNearMiss}/${noisy.spanFabricated}/${noisy.spanMissing}`,
  ],
];

const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);
console.log("");
console.log("=".repeat(78));
console.log(
  `PART B — extraction on ON-DEVICE (${modelSlug}) transcripts vs CLEAN text — ${extractor}`,
);
console.log("=".repeat(78));
console.log(`coverage: ${scored.length}/${reports.length} scored`);
console.log("");
console.log(`${pad("metric", 38)}${padL("clean", 14)}${padL("on-device", 14)}`);
console.log("-".repeat(78));
for (const [label, c, n] of rows) console.log(`${pad(label, 38)}${padL(c, 14)}${padL(n, 14)}`);
console.log("=".repeat(78));

// per-transcript span/hallucination flags for the writeup
console.log("\nPER-TRANSCRIPT (on-device):");
for (const r of reports) {
  const c = r.counts;
  const flags = [];
  if (r.status !== "scored") flags.push(`UNSCORED(${r.problem})`);
  if (c.hallucinationHard) flags.push(`HALLUC:${c.hallucinationHard}`);
  if (c.miss) flags.push(`MISS:${c.miss}`);
  if (c.wrong) flags.push(`WRONG:${c.wrong}`);
  if (c.hHallucinatedPass) flags.push(`HPASS:${c.hHallucinatedPass}`);
  if (c.spanFabricated || c.spanMissing || c.spanNearMiss)
    flags.push(`SPAN v${c.spanVerbatim}/n${c.spanNearMiss}/f${c.spanFabricated}/m${c.spanMissing}`);
  if (r.axis?.category === "fuelDropped") flags.push("FUELDROP");
  console.log(`  ${pad(r.slug, 28)}${flags.join("  ") || "ok"}`);
}

const out = {
  generatedAt: new Date().toISOString(),
  transcriptSource: `ondevice/${modelSlug}`,
  extractor,
  coverage: { total: reports.length, scored: scored.length },
  clean,
  noisy,
  wrongValues: reports.flatMap((r) => r.wrong.map((w) => ({ slug: r.slug, ...w }))),
  hallucinations: reports.flatMap((r) =>
    r.hallucinations.map((h) => ({ slug: r.slug, field: h.field, value: h.value })),
  ),
  badSpans: reports.flatMap((r) =>
    r.badSpans.map((b) => ({
      slug: r.slug,
      field: b.field,
      status: b.status,
      value: b.value,
      span: b.span,
    })),
  ),
  perTranscript: reports.map((r) => ({
    slug: r.slug,
    status: r.status,
    counts: r.counts,
    axis: r.axis,
  })),
};
const outPath = join(HERE, "results", `partb-${modelSlug}-${extractor}-score.json`);
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`\nWrote ${outPath}`);
