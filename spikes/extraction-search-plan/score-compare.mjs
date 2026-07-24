#!/usr/bin/env node
/**
 * Score the search-plan pipeline's DECIDE outputs with the UNMODIFIED snuggpro
 * scorer, and diff every headline metric against the committed single-shot
 * baseline in spikes/extraction-snuggpro/results/<model>-score.json.
 *
 *   node score-compare.mjs            # both models
 *   node score-compare.mjs codex      # one model
 *
 * We import score.mjs's exported functions — we do NOT modify it and do NOT write
 * anything into spikes/extraction-snuggpro/. Our scored summaries land in
 * results/<model>-score.json under THIS spike.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOP_FIELDS,
  HEALTH_TESTS,
  loadResult,
  scoreTranscript,
  aggregate,
} from "../extraction-snuggpro/score.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNUGG = join(HERE, "..", "extraction-snuggpro");
const GT_DIR = join(SNUGG, "ground-truth");
const TRANSCRIPT_DIR = join(SNUGG, "transcripts");

const models = process.argv[2] ? [process.argv[2]] : ["codex", "opencode"];

function scoreModel(model) {
  const resultsDir = join(HERE, "results", model);
  if (!existsSync(resultsDir)) return null;
  const slugs = readdirSync(GT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
  const reports = [];
  for (const slug of slugs) {
    const gt = JSON.parse(readFileSync(join(GT_DIR, `${slug}.json`), "utf8"));
    const transcript = readFileSync(join(TRANSCRIPT_DIR, `${slug}.txt`), "utf8");
    const loaded = loadResult(resultsDir, slug);
    reports.push(scoreTranscript(slug, gt, transcript, loaded.data, loaded.problem));
  }
  const agg = aggregate(reports);
  return { reports, ...agg };
}

/** Pull the metrics we report from a `totals`/`axisTally` pair (matches baseline JSON shape). */
function metrics(t, axisTally) {
  const pct = (n, d) => (d === 0 ? null : +(100 * (n / d)).toFixed(1));
  return {
    // headline
    hallucinationHard: t.hallucinationHard,
    hallucinationHardPct: pct(t.hallucinationHard, t.gtNull),
    hallucinationSoft: t.hallucinationSoft,
    miss: t.miss,
    missPct: pct(t.miss, t.gtNonNull),
    // both-non-null value accuracy
    bothNonNull: t.bothNonNull,
    correct: t.correct,
    wrong: t.wrong,
    bothAccuracyPct: pct(t.correct, t.bothNonNull),
    // hazard 1: silent fuel drop (axis) — category names from scoreAxis()
    axisBothCorrect: axisTally.bothCorrect ?? 0,
    axisFuelDropped: axisTally.fuelDropped ?? 0,
    axisConfused: axisTally.axisConfused ?? 0,
    axisFuelInvented: axisTally.fuelInvented ?? 0,
    axisWrongMember: (axisTally.eqWrongMember ?? 0) + (axisTally.fuelWrongMember ?? 0),
    axisSilentDropRespected: axisTally.silentDropRespected ?? 0,
    axisRaw: axisTally,
    // hazard 2: R-value -> band invention
    rvalueConversion: t.rvalueConversion,
    bandGt: t.bandGt,
    bandCorrect: t.bandCorrect,
    bandBoundary: t.bandBoundary,
    bandWrong: t.bandWrong,
    // hazard 3: health passes
    hHallucinatedPass: t.hHallucinatedPass,
    hHallucinatedProblem: t.hHallucinatedProblem,
    hCleanDropped: t.hCleanDropped,
    hGtPassed: t.hGtPassed,
    hGtPassedCorrect: t.hGtPassedCorrect,
    hGtState: t.hGtState,
    hCorrectState: t.hCorrectState,
    hWrongState: t.hWrongState,
    // hazard 4: enum member accuracy
    enumGtMember: t.enumGtMember,
    enumCorrect: t.enumCorrect,
    enumWrongMember: t.enumWrongMember,
    enumOtherDump: t.enumOtherDump,
    enumAccuracyPct: pct(t.enumCorrect, t.enumGtMember),
    // verbatim span rate
    spanChecked: t.spanChecked,
    spanVerbatim: t.spanVerbatim,
    spanNearMiss: t.spanNearMiss,
    spanFabricated: t.spanFabricated,
    spanVerbatimPct: pct(t.spanVerbatim, t.spanChecked),
  };
}

function loadBaseline(model) {
  const p = join(SNUGG, "results", `${model}-score.json`);
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, "utf8"));
  return metrics(j.totals, j.axisTally ?? {});
}

const out = {};
for (const model of models) {
  const scored = scoreModel(model);
  if (!scored) {
    console.log(`\n### ${model}: no results dir — skipped`);
    continue;
  }
  const pipeline = metrics(scored.totals, scored.axisTally);
  const baseline = loadBaseline(model);
  const coverage = scored.reports.filter((r) => r.status === "scored").length;
  out[model] = { coverage, pipeline, baseline };

  // Per-transcript miss-trade detector: fields the pipeline nulled that baseline got.
  const baseDir = join(SNUGG, "results", model);
  const missTrade = [];
  for (const r of scored.reports) {
    if (r.status !== "scored") continue;
    const slug = r.slug;
    const gt = JSON.parse(readFileSync(join(GT_DIR, `${slug}.json`), "utf8"));
    const baseLoaded = loadResult(baseDir, slug);
    const pipeLoaded = loadResult(join(HERE, "results", model), slug);
    if (!baseLoaded.data || !pipeLoaded.data) continue;
    for (const f of TOP_FIELDS) {
      const g = gt.fields[f].value;
      if (g === null) continue;
      const b = baseLoaded.data[f]?.value ?? null;
      const p = pipeLoaded.data[f]?.value ?? null;
      if (p === null && b !== null) missTrade.push({ slug, field: f, gt: g, baseline: b });
    }
    for (const hkey of HEALTH_TESTS) {
      const g = gt.fields.healthSafety[hkey].value;
      if (g === null) continue;
      const b = baseLoaded.data.healthSafety?.[hkey]?.value ?? null;
      const p = pipeLoaded.data.healthSafety?.[hkey]?.value ?? null;
      if (p === null && b !== null)
        missTrade.push({ slug, field: `healthSafety.${hkey}`, gt: g, baseline: b });
    }
  }
  out[model].missTrade = missTrade;

  writeFileSync(
    join(HERE, "results", `${model}-score.json`),
    JSON.stringify(
      { model, coverage, totals: scored.totals, axisTally: scored.axisTally },
      null,
      2,
    ) + "\n",
  );
}

// -------- console report --------
const rows = [
  ["hard halluc (of gtNull)", "hallucinationHard", "hallucinationHardPct"],
  ["soft halluc (grounded alt)", "hallucinationSoft", null],
  ["miss (of gtNonNull)", "miss", "missPct"],
  ["both-non-null accuracy", "correct", "bothAccuracyPct"],
  ["axis both-correct", "axisBothCorrect", null],
  ["axis fuel-dropped", "axisFuelDropped", null],
  ["R-value->band conversion", "rvalueConversion", null],
  ["band correct / gt", "bandCorrect", null],
  ["health hallucinated-pass", "hHallucinatedPass", null],
  ["health clean-dropped", "hCleanDropped", null],
  ["health passed correct/gt", "hGtPassedCorrect", null],
  ["enum member accuracy", "enumCorrect", "enumAccuracyPct"],
  ["verbatim span rate", "spanVerbatim", "spanVerbatimPct"],
  ["span fabricated", "spanFabricated", null],
];

for (const model of models) {
  if (!out[model]) continue;
  const { pipeline: P, baseline: B, coverage, missTrade } = out[model];
  console.log(
    `\n${"=".repeat(78)}\n${model.toUpperCase()}  —  pipeline coverage ${coverage}/14   (baseline = committed single-shot)\n${"=".repeat(78)}`,
  );
  console.log(
    `${"metric".padEnd(30)}${"baseline".padStart(14)}${"pipeline".padStart(14)}${"delta".padStart(14)}`,
  );
  console.log("-".repeat(78));
  for (const [label, key, pctKey] of rows) {
    const bv = B ? B[key] : null;
    const pv = P[key];
    const bcell = B ? `${bv}${pctKey && B[pctKey] != null ? ` (${B[pctKey]}%)` : ""}` : "—";
    const pcell = `${pv}${pctKey && P[pctKey] != null ? ` (${P[pctKey]}%)` : ""}`;
    const delta =
      B && typeof bv === "number" && typeof pv === "number"
        ? pv - bv > 0
          ? `+${pv - bv}`
          : `${pv - bv}`
        : "—";
    console.log(
      `${label.padEnd(30)}${bcell.padStart(14)}${pcell.padStart(14)}${String(delta).padStart(14)}`,
    );
  }
  if (missTrade.length) {
    console.log(`\n  MISS-TRADE (pipeline nulled a field single-shot caught):`);
    for (const m of missTrade)
      console.log(
        `    ${m.slug}  ${m.field}  gt=${JSON.stringify(m.gt)}  baseline=${JSON.stringify(m.baseline)}`,
      );
  } else {
    console.log(`\n  MISS-TRADE: none — pipeline dropped no field the baseline caught.`);
  }
}

writeFileSync(join(HERE, "results", "comparison.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`\nWrote results/comparison.json`);
