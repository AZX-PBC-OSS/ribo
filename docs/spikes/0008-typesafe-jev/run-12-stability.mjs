// Probe 12: does the same question get the same answer?
//
// ADR 0027 rules out a recovery pass that re-asks, on the strength of TypeSafe's cookbooks rather
// than a measurement here. Microsoft-Decision-1's launch claims zero decision flips under
// reordered options. Both are checkable on the corpus with questions earlier probes already ask:
//
//   repeat   — probe 3's bare enum choices and probe 10's presence nouls, asked REPEATS times
//   reorder  — the same enum choices with each criteria map reversed, asked once
//
// A flip is a different `choice`, or a noul that lands on both sides of a threshold the presence
// phase might actually use.
import { writeFileSync } from "node:fs";
import { LEAVES } from "../0001-extraction-snuggpro/schema-leaves.mjs";
import { ask, results } from "./env.mjs";
import { corpus } from "./corpus.mjs";
import { COVERED_GROUPS, ENUM_LEAVES, qid } from "./leaves.mjs";

const REPEATS = 3;
const CHUNK = 80;
const PRESENCE = LEAVES.filter((l) => COVERED_GROUPS.includes(l.path.split(".")[0]));
const pqid = (path) => path.replace(/\./g, "__");

const enumQuestions = (reversed) =>
  Object.fromEntries(
    ENUM_LEAVES.map((l) => {
      const options = reversed ? [...l.options].reverse() : l.options;
      return [
        qid(l.path),
        {
          type: "choice",
          instructions:
            `In this home-energy-audit dictation, which value does the auditor state for the ` +
            `field "${l.path.split(".")[1]}"? Choose only what the auditor actually says.`,
          criteria: Object.fromEntries(options.map((o) => [o, o])),
        },
      ];
    }),
  );

// Probe 10's question, verbatim.
const describe = (leaf) => {
  const name = leaf.path.split(".")[1];
  if (leaf.kind === "enum") return `"${name}" (one of: ${leaf.options.join(", ")})`;
  return `"${name}" (a ${leaf.kind})`;
};
const presenceQuestion = (l) => ({
  type: "noul",
  instructions:
    `Does this home-energy-audit dictation discuss the field ${describe(l)}? ` +
    `Answer yes if the auditor says something about it — including explicitly ` +
    `declining to give a value. Answer no if the field never comes up.`,
});

async function askEnums(state, reversed) {
  const res = await ask({ state, questions: enumQuestions(reversed) });
  return Object.fromEntries(
    ENUM_LEAVES.map((l) => {
      const a = res.answers[qid(l.path)];
      return [l.path, { choice: a.choice, confidence: a.confidence }];
    }),
  );
}

async function askPresence(state) {
  const out = {};
  for (let i = 0; i < PRESENCE.length; i += CHUNK) {
    const slice = PRESENCE.slice(i, i + CHUNK);
    const questions = Object.fromEntries(slice.map((l) => [pqid(l.path), presenceQuestion(l)]));
    const res = await ask({ state, questions });
    for (const l of slice) out[l.path] = res.answers[pqid(l.path)].noul;
  }
  return out;
}

const rows = [];
for (const entry of corpus()) {
  const enums = [];
  const presence = [];
  for (let r = 0; r < REPEATS; r++) {
    enums.push(await askEnums(entry.transcript, false));
    presence.push(await askPresence(entry.transcript));
  }
  const reversed = await askEnums(entry.transcript, true);
  rows.push({ name: entry.name, enums, reversed, presence });
  console.log(`${entry.name.padEnd(28)} done`);
}

writeFileSync(results("stability.json"), JSON.stringify(rows, null, 2));

// --- choice: repeat and reorder flips ---------------------------------------------------------
let cells = 0,
  repeatFlips = 0,
  reorderFlips = 0,
  confSpread = 0;
for (const r of rows) {
  for (const l of ENUM_LEAVES) {
    cells += 1;
    const picks = r.enums.map((e) => e[l.path].choice);
    if (new Set(picks).size > 1) repeatFlips += 1;
    if (r.reversed[l.path].choice !== picks[0]) reorderFlips += 1;
    const confs = r.enums.map((e) => e[l.path].confidence);
    confSpread += Math.max(...confs) - Math.min(...confs);
  }
}
console.log(
  `\nchoice: ${cells} transcript x enum-leaf cells, ${REPEATS} repeats + 1 reversed order`,
);
console.log(`  repeat flips   ${repeatFlips} (${((100 * repeatFlips) / cells).toFixed(2)}%)`);
console.log(`  reorder flips  ${reorderFlips} (${((100 * reorderFlips) / cells).toFixed(2)}%)`);
console.log(`  mean confidence spread across repeats ${(confSpread / cells).toFixed(4)}`);

// --- noul: spread and threshold straddles ------------------------------------------------------
const spreads = [];
const straddles = { 0.3: 0, 0.5: 0 };
for (const r of rows) {
  for (const l of PRESENCE) {
    const ps = r.presence.map((p) => p[l.path]);
    const mean = ps.reduce((a, b) => a + b, 0) / ps.length;
    spreads.push(Math.sqrt(ps.reduce((a, b) => a + (b - mean) ** 2, 0) / ps.length));
    for (const t of Object.keys(straddles)) {
      if (ps.some((p) => p >= Number(t)) && ps.some((p) => p < Number(t))) straddles[t] += 1;
    }
  }
}
spreads.sort((a, b) => a - b);
const pct = (q) => spreads[Math.min(spreads.length - 1, Math.floor(q * spreads.length))];
console.log(`\nnoul: ${spreads.length} transcript x leaf presence cells, ${REPEATS} repeats`);
console.log(
  `  per-cell std  mean ${(spreads.reduce((a, b) => a + b, 0) / spreads.length).toFixed(4)}  ` +
    `p50 ${pct(0.5).toFixed(4)}  p90 ${pct(0.9).toFixed(4)}  max ${spreads.at(-1).toFixed(4)}`,
);
for (const [t, n] of Object.entries(straddles)) {
  console.log(`  straddles ${t}  ${n} (${((100 * n) / spreads.length).toFixed(2)}%)`);
}
