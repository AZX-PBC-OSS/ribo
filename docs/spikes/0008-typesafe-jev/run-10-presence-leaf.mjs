// Probe 10: presence at LEAF granularity — the question `presencePhase` actually asks.
//
// Probe 2 measured whether a transcript touches a GROUP (5 nouls, recall 1.000 at 0.5). That is
// not what core's `presencePhase` produces: it emits `PresenceMaps`, a per-group map of per-LEAF
// booleans, one call per group. This asks the same per-leaf question for all 159 leaves of the
// five groups the corpus covers, in one request per transcript instead of one per group.
//
// Truth: a leaf is discussed if the annotation records it at all, under ANY instance and under
// any status — `asserted` and `declared_absent` both mean the auditor spoke about the field.
// That matches what presence decides: whether anything downstream should look at this leaf.
//
// Recall is the metric that matters. A false negative is silent data loss — the leaf is seeded
// null and no later phase ever plans an item for it. A false positive is one wasted item.
import { writeFileSync } from "node:fs";
import { LEAVES } from "../0001-extraction-snuggpro/schema-leaves.mjs";
import { ask, results } from "./env.mjs";
import { corpus } from "./corpus.mjs";
import { COVERED_GROUPS } from "./leaves.mjs";

const TARGET = LEAVES.filter((l) => COVERED_GROUPS.includes(l.path.split(".")[0]));
const CHUNK = 80;
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
  if (leaf.kind === "enum") {
    return `"${name}" (one of: ${leaf.options.join(", ")})`;
  }
  return `"${name}" (a ${leaf.kind})`;
};

const rows = [];
for (const entry of corpus()) {
  const truth = mentionedLeaves(entry);
  const answers = {};
  let ms = 0;
  let inputTokens = 0;

  for (let i = 0; i < TARGET.length; i += CHUNK) {
    const slice = TARGET.slice(i, i + CHUNK);
    const questions = Object.fromEntries(
      slice.map((l) => [
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
    const res = await ask({ state: entry.transcript, questions });
    ms += res.ms;
    inputTokens += res.usage?.input_tokens ?? 0;
    for (const l of slice) answers[l.path] = res.answers[qid(l.path)].noul;
  }

  const row = {
    name: entry.name,
    ms,
    inputTokens,
    cells: TARGET.map((l) => ({
      path: l.path,
      noul: answers[l.path],
      truth: truth.has(l.path),
    })),
  };
  rows.push(row);
  console.log(
    `${entry.name.padEnd(28)} ${String(ms).padStart(5)}ms  ` +
      `${truth.size} leaves discussed of ${TARGET.length}`,
  );
}

writeFileSync(results("presence-leaf.json"), JSON.stringify(rows, null, 2));

const cells = rows.flatMap((r) => r.cells);
const present = cells.filter((c) => c.truth).length;
console.log(
  `\n${cells.length} transcript x leaf cells, ${present} discussed / ${cells.length - present} not`,
);
console.log("\nthreshold    TP   FP   FN    TN   precision  recall   wasted-items-per-transcript");
for (const t of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
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

// What does a false negative actually cost? Name the leaves lost at the recall-1.0 boundary.
for (const t of [0.3, 0.5]) {
  const missed = cells.filter((c) => c.truth && c.noul < t);
  console.log(`\nleaves silently dropped at ${t.toFixed(2)} (${missed.length}):`);
  for (const m of missed.slice(0, 12)) console.log(`  ${m.noul.toFixed(2)} ${m.path}`);
}
