// Probe 2: spike 0008's probe 10 (presence at leaf granularity), re-run on kev-0.6b on-device.
//
// Deliberately a copy of ../0008-typesafe-jev/run-10-presence-leaf.mjs with the import swapped:
// same corpus, same truth definition, same question text, same threshold table. Anything else
// changed would make the two sets of numbers incomparable, and comparing them is the point.
//
// Hosted Jev scored recall 1.000 at threshold 0.20 (precision 0.326, ~19.9 wasted items per
// transcript) over 2226 cells, and the spike recorded that recall 1.000 was "one leaf wide" —
// the lowest true positive sat exactly at 0.30. A 0.6B model is not expected to match it; the
// question is whether the populations separate at all, and at what recall cost.
//
// Thresholds here are on TEMPERATURE-CALIBRATED probabilities (see kev.mjs). Temperature is
// monotone, so the precision/recall CURVE is identical either way — only the threshold numbers
// move — but a threshold quoted without saying which scale it is on is not reusable.
import { writeFileSync } from "node:fs";
import { LEAVES } from "../0001-extraction-snuggpro/schema-leaves.mjs";
import { corpus } from "../0008-typesafe-jev/corpus.mjs";
import { COVERED_GROUPS } from "../0008-typesafe-jev/leaves.mjs";
import { loadKev } from "./kev.mjs";

const CHUNK = Number(process.argv[2] ?? 40);
const TARGET = LEAVES.filter((l) => COVERED_GROUPS.includes(l.path.split(".")[0]));
const qid = (path) => path.replace(/\./g, "__");

/** Every leaf the annotation mentions, at any status, across every instance of its group. */
const mentionedLeaves = (entry) => {
  const out = new Set();
  for (const [group, insts] of Object.entries(entry.gt.instances ?? {})) {
    for (const inst of insts) {
      for (const leaf of Object.keys(inst.leaves ?? {})) out.add(`${group}.${leaf}`);
    }
  }
  return out;
};

const describe = (leaf) => {
  const name = leaf.path.split(".")[1];
  if (leaf.kind === "enum") return `"${name}" (one of: ${leaf.options.join(", ")})`;
  return `"${name}" (a ${leaf.kind})`;
};

const t0 = Date.now();
const kev = await loadKev();
console.log(`model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s, chunk=${CHUNK}\n`);

const questions = Object.fromEntries(
  TARGET.map((l) => [
    qid(l.path),
    {
      type: "noul",
      instructions:
        `Does this home-energy-audit dictation discuss the field ${describe(l)}? ` +
        `Answer yes if the auditor says something about it — including explicitly ` +
        `declining to give a value. Answer no if the field never comes up.`,
    },
  ]),
);

const rows = [];
for (const entry of corpus()) {
  const truth = mentionedLeaves(entry);
  const res = await kev.ask({ state: entry.transcript, questions, chunk: CHUNK });
  rows.push({
    name: entry.name,
    ms: res.ms,
    tokens: res.tokens,
    cells: TARGET.map((l) => ({
      path: l.path,
      noul: res.answers[qid(l.path)].noul,
      truth: truth.has(l.path),
    })),
  });
  console.log(
    `${entry.name.padEnd(28)} ${String(res.ms).padStart(6)}ms  ${String(res.tokens).padStart(5)} tok/pass  ` +
      `${truth.size} of ${TARGET.length} discussed`,
  );
}

writeFileSync(
  new URL("./results/presence-leaf.json", import.meta.url),
  JSON.stringify(rows, null, 2),
);

const cells = rows.flatMap((r) => r.cells);
const present = cells.filter((c) => c.truth).length;
console.log(
  `\n${cells.length} transcript x leaf cells, ${present} discussed / ${cells.length - present} not`,
);
console.log(
  `mean ${(rows.reduce((a, r) => a + r.ms, 0) / rows.length / 1000).toFixed(1)}s per transcript\n`,
);

console.log("threshold    TP   FP   FN    TN   precision  recall   wasted-items-per-transcript");
for (const t of [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0;
  for (const c of cells) {
    const pred = c.noul >= t;
    if (pred && c.truth) tp += 1;
    else if (pred && !c.truth) fp += 1;
    else if (!pred && c.truth) fn += 1;
    else tn += 1;
  }
  console.log(
    `  ${t.toFixed(2)}     ${String(tp).padStart(4)} ${String(fp).padStart(4)} ` +
      `${String(fn).padStart(4)} ${String(tn).padStart(5)}    ` +
      `${(tp / (tp + fp || 1)).toFixed(3)}     ${(tp / (tp + fn || 1)).toFixed(3)}   ` +
      `${(fp / rows.length).toFixed(1)}`,
  );
}

// The decisive number for a presence phase is the LOWEST true positive: any threshold above it
// silently drops a discussed leaf, and no later phase ever plans an item for it.
const pos = cells
  .filter((c) => c.truth)
  .map((c) => c.noul)
  .sort((a, b) => a - b);
const neg = cells
  .filter((c) => !c.truth)
  .map((c) => c.noul)
  .sort((a, b) => a - b);
const q = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
console.log(
  `\ndiscussed   min ${q(pos, 0).toFixed(3)}  p5 ${q(pos, 0.05).toFixed(3)}  median ${q(pos, 0.5).toFixed(3)}`,
);
console.log(
  `undiscussed p50 ${q(neg, 0.5).toFixed(3)}  p95 ${q(neg, 0.95).toFixed(3)}  max ${q(neg, 1).toFixed(3)}`,
);

// Threshold-free separation. Temperature-invariant, so this is THE comparable number.
let better = 0;
for (const a of pos) for (const b of neg) better += a > b ? 1 : a === b ? 0.5 : 0;
console.log(
  `\nAUC ${(better / (pos.length * neg.length)).toFixed(4)}  (rank separation, threshold-free)`,
);

console.log("\nhosted Jev on these same 2226 cells (spike 0008 probe 10):");
console.log("  0.20  precision 0.326  recall 1.000  19.9 wasted/transcript");
console.log("  0.50  precision 0.551  recall 0.956   7.5 wasted/transcript");
console.log("  lowest true positive 0.30");
