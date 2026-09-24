// Probe 4: spike 0008's probe 4 (one noul per field/value pair), re-run on kev-0.6b on-device.
//
// Probe 3 found the three-way choice collapses: `contradicts` won 0 of 951 cells. This asks
// whether that is the three-way SPLIT failing or the verification task failing, by putting the
// same cells to the simpler question — one noul, "does the dictation support this value?".
//
// It is also the only cell-for-cell comparison available: ../0008-typesafe-jev/results/triage.json
// carries hosted Jev's noul for every one of these cells, so the two models are scored on
// identical inputs and the per-cell correlation is computable.
//
// Hosted Jev: supported mean 0.804, corrupted 0.035, invented 0.146; at a 0.50 gate it kept 84.2%
// of good values while catching 98.9% of corrupted and 91.7% of invented.
import { readFileSync, writeFileSync } from "node:fs";
import { LEAF_BY_PATH } from "../0001-extraction-snuggpro/schema-leaves.mjs";
import { corpus } from "../0008-typesafe-jev/corpus.mjs";
import { loadKev } from "./kev.mjs";

const SIZE = process.argv[2] ?? "0.6b";
const CHUNK = Number(process.argv[3] ?? 40);
const cells = JSON.parse(
  readFileSync(new URL("../0008-typesafe-jev/results/triage.json", import.meta.url), "utf8"),
);
const transcripts = new Map(corpus().map((e) => [e.name, e.transcript]));
const byName = new Map();
for (const c of cells) {
  if (!byName.has(c.name)) byName.set(c.name, []);
  byName.get(c.name).push(c);
}

const t0 = Date.now();
const kev = await loadKev({ size: SIZE });
console.log(
  `kev-${kev.size} (${kev.repo}) loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s, T=${kev.temperature.toFixed(4)}, chunk=${CHUNK}\n`,
);

const out = [];
for (const [name, list] of byName) {
  const state = transcripts.get(name);
  const questions = {};
  list.forEach((c, j) => {
    const field = c.path.split(".")[1];
    const options = LEAF_BY_PATH.get(c.path)?.options ?? null;
    const vocab = options
      ? `The field "${field}" records exactly one of: ${options.join(", ")}. `
      : "";
    questions[`c${j}`] = {
      type: "noul",
      instructions:
        `${vocab}An extractor read this home-energy-audit dictation and recorded ` +
        `"${field}" = ${JSON.stringify(c.value)}. The value is a code from that list, not a ` +
        `quote — a faithful encoding of what the auditor said counts as supporting it. ` +
        `Does the dictation support that recorded value?`,
    };
  });

  const res = await kev.ask({ state, questions, chunk: CHUNK });
  list.forEach((c, j) => out.push({ ...c, jevNoul: c.noul, kevNoul: res.answers[`c${j}`].noul }));
  console.log(`${name.padEnd(28)} ${String(res.ms).padStart(6)}ms  ${list.length} cells`);
}

writeFileSync(
  new URL(`./results/noul-${SIZE}.json`, import.meta.url),
  JSON.stringify(out, null, 2),
);

const by = (k) => out.filter((r) => r.kind === k);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const pc = (n, d) => `${((100 * n) / (d || 1)).toFixed(1)}%`;

console.log("\npopulation      n   kev mean   kev median   (jev mean)");
for (const k of ["supported", "corrupted", "invented"]) {
  const rows = by(k);
  const s = rows.map((r) => r.kevNoul).sort((a, b) => a - b);
  console.log(
    k.padEnd(12) +
      String(rows.length).padStart(5) +
      mean(s).toFixed(3).padStart(11) +
      s[(s.length / 2) | 0].toFixed(3).padStart(13) +
      mean(rows.map((r) => r.jevNoul))
        .toFixed(3)
        .padStart(13),
  );
}

console.log("\ngate   supported kept   corrupted caught   invented caught");
for (const t of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
  const kept = by("supported").filter((r) => r.kevNoul >= t).length;
  const caught = (k) => by(k).filter((r) => r.kevNoul < t).length;
  console.log(
    `${t.toFixed(2)}   ${pc(kept, by("supported").length).padStart(8)}` +
      `          ${pc(caught("corrupted"), by("corrupted").length).padStart(8)}` +
      `           ${pc(caught("invented"), by("invented").length).padStart(8)}`,
  );
}

// Threshold-free, temperature-invariant separation, computed identically for both models so the
// two AUCs are directly comparable.
const auc = (field) => {
  const good = by("supported").map((r) => r[field]);
  const bad = [...by("corrupted"), ...by("invented")].map((r) => r[field]);
  let better = 0;
  for (const a of good) for (const b of bad) better += a > b ? 1 : a === b ? 0.5 : 0;
  return better / (good.length * bad.length);
};
console.log(
  `\nAUC (good vs escalate-worthy)   kev ${auc("kevNoul").toFixed(4)}   jev ${auc("jevNoul").toFixed(4)}`,
);

// Do the two models agree cell by cell, or find different things?
const xs = out.map((r) => r.kevNoul);
const ys = out.map((r) => r.jevNoul);
const [mx, my] = [mean(xs), mean(ys)];
const cov = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
const sd = (zs, m) => Math.sqrt(mean(zs.map((z) => (z - m) ** 2)));
console.log(
  `per-cell Pearson r(kev, jev) over ${out.length} cells: ${(cov / (sd(xs, mx) * sd(ys, my))).toFixed(3)}`,
);

console.log("\nhosted Jev at a 0.50 gate (spike 0008 probe 4):");
console.log("  84.2% supported kept | 98.9% corrupted caught | 91.7% invented caught");
