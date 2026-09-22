// Probe 6: what does the grounded x supported 2x2 actually look like on real extractions?
//
// The question this answers: is "grounded but unsupported" a real, common cell, or a corner
// case? If it is near-empty, support adds nothing that groundedness does not already flag.
//
// Uses the OLD-schema single-shot results in ../0001-extraction-snuggpro/results/, which are the
// only extractions in the repo carrying real model-produced sourceSpans. Field names are
// pre-rebuild; that does not matter here, because the unit of measurement is the envelope.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spanGroundedness } from "../../../packages/ribo-core/dist/index.js";
import { ask } from "./env.mjs";

const RESULTS = process.argv[2] ?? "codex";
const spikeDir = fileURLToPath(new URL("../0001-extraction-snuggpro/", import.meta.url));

const rows = [];
for (const file of readdirSync(`${spikeDir}results/${RESULTS}`).filter((f) =>
  f.endsWith(".json"),
)) {
  const name = file.slice(0, -5);
  const transcript = readFileSync(`${spikeDir}transcripts/${name}.txt`, "utf8").trim();
  const extraction = JSON.parse(readFileSync(`${spikeDir}results/${RESULTS}/${file}`, "utf8"));

  // Every committed leaf: a non-null value. That is what a reviewer is asked to accept.
  const leaves = Object.entries(extraction)
    .filter(([, v]) => v && typeof v === "object" && "value" in v && v.value !== null)
    .map(([field, v]) => ({
      field,
      value: v.value,
      sourceSpan: v.sourceSpan ?? null,
      groundedness: spanGroundedness(v.sourceSpan ?? null, transcript),
    }));

  const questions = {};
  leaves.forEach((l, i) => {
    questions[`h${i}`] = {
      type: "noul",
      instructions:
        `An extractor recorded "${l.field}" = "${l.value}" from this home-energy-audit ` +
        `dictation. Is that value unsupported by, or absent from, the dictation?`,
      criteria: { true: "the value is a hallucination", false: "the value is supported" },
    };
    questions[`o${i}`] = {
      type: "noul",
      instructions:
        `An extractor recorded "${l.field}" = "${l.value}". Does this dictation fail to ` +
        `genuinely report the field "${l.field}" itself?`,
      criteria: {
        true: "the value was pulled from incidental text, or inferred from a different field",
        false: "the dictation genuinely reports this field",
      },
    };
  });

  const res = await ask({ state: transcript, questions });
  leaves.forEach((l, i) => {
    const unsupported = Math.max(res.answers[`h${i}`].noul, res.answers[`o${i}`].noul);
    rows.push({ name, ...l, unsupported });
  });
  console.log(
    `${name.padEnd(28)} ${String(res.ms).padStart(5)}ms  ${leaves.length} committed leaves`,
  );
}

writeFileSync(
  new URL("./results/grounded-vs-supported.json", import.meta.url),
  JSON.stringify(rows, null, 2),
);

const T = 0.6;
const cell = (g, unsup) =>
  rows.filter((r) => r.groundedness === g && r.unsupported > T === unsup).length;

console.log(`\n${rows.length} committed leaves, FIRE_T=${T}\n`);
console.log("groundedness    supported   UNSUPPORTED");
for (const g of ["grounded", "near-miss", "ungrounded"]) {
  console.log(
    `${g.padEnd(14)} ${String(cell(g, false)).padStart(9)} ${String(cell(g, true)).padStart(13)}`,
  );
}

const hidden = rows.filter((r) => r.groundedness === "grounded" && r.unsupported > T);
console.log(
  `\n"grounded but unsupported" — invisible to every flag that exists today: ` +
    `${hidden.length} of ${rows.length} (${((100 * hidden.length) / rows.length).toFixed(1)}%)`,
);
for (const r of hidden.sort((a, b) => b.unsupported - a.unsupported).slice(0, 12)) {
  console.log(
    `  ${r.unsupported.toFixed(2)} ${r.name.slice(0, 2)} ${r.field} = ${JSON.stringify(r.value)}`,
  );
  console.log(`        span: ${JSON.stringify(r.sourceSpan)}`);
}

// And the converse: does groundedness flag things support thinks are fine?
const ung = rows.filter((r) => r.groundedness !== "grounded");
console.log(
  `\nconverse — not grounded but supported: ` +
    `${ung.filter((r) => r.unsupported <= T).length} of ${ung.length} non-grounded leaves`,
);
