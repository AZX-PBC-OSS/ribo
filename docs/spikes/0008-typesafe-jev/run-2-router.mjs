// Probe 2: can a fan-out of nouls decide which resource groups a transcript touches?
// One request per transcript, five nouls inside it. Scored against the annotated corpus:
// a group is "present" when the ground truth records any leaf for it at all.
import { writeFileSync } from "node:fs";
import { ask, results } from "./env.mjs";
import { corpus } from "./corpus.mjs";
import { GROUPS, GROUP_IDS } from "./groups.mjs";

const questions = Object.fromEntries(
  GROUP_IDS.map((g) => [
    g,
    {
      type: "noul",
      instructions:
        `Does this energy-audit dictation say anything about ${GROUPS[g].blurb}? ` +
        `Answer yes only if the auditor actually speaks about it — including explicitly ` +
        `declining to give a value for it. Answer no if the topic never comes up.`,
    },
  ]),
);

const rows = [];
for (const entry of corpus()) {
  const res = await ask({ state: entry.transcript, questions });
  const noul = Object.fromEntries(GROUP_IDS.map((g) => [g, res.answers[g].noul]));
  const truth = Object.fromEntries(GROUP_IDS.map((g) => [g, (entry.groups[g]?.total ?? 0) > 0]));
  rows.push({ name: entry.name, noul, truth, ms: res.ms, usage: res.usage });
  console.log(
    `${entry.name.padEnd(28)} ${res.ms.toString().padStart(5)}ms  ` +
      GROUP_IDS.map((g) => `${g}=${noul[g].toFixed(2)}${truth[g] ? "*" : " "}`).join(" "),
  );
}

writeFileSync(results("router.json"), JSON.stringify(rows, null, 2));

// Threshold sweep over every (transcript, group) cell.
console.log("\nthreshold   TP  FP  FN  TN   precision  recall   wrongly-skipped-groups");
for (const t of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0;
  const missed = [];
  for (const r of rows) {
    for (const g of GROUP_IDS) {
      const pred = r.noul[g] >= t;
      if (pred && r.truth[g]) tp += 1;
      else if (pred && !r.truth[g]) fp += 1;
      else if (!pred && r.truth[g]) {
        fn += 1;
        missed.push(`${r.name.slice(0, 2)}:${g}`);
      } else tn += 1;
    }
  }
  const p = tp / (tp + fp || 1);
  const rc = tp / (tp + fn || 1);
  console.log(
    `  ${t.toFixed(2)}    ${String(tp).padStart(4)}${String(fp).padStart(4)}` +
      `${String(fn).padStart(4)}${String(tn).padStart(4)}    ` +
      `${p.toFixed(3)}     ${rc.toFixed(3)}   ${missed.join(",") || "-"}`,
  );
}

const totalIn = rows.reduce((a, r) => a + r.usage.input_tokens, 0);
const totalOut = rows.reduce((a, r) => a + r.usage.output_tokens, 0);
const meanMs = Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length);
console.log(`\n${rows.length} requests, mean ${meanMs}ms, ${totalIn} in / ${totalOut} out tokens`);
