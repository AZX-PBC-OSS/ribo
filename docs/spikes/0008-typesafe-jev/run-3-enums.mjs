// Probe 3: one `choice` per enum leaf, all in one request per transcript.
//
// Two arms, because the interesting failure is not "picks the wrong member" but "invents a
// member for a field nobody mentioned" — most of these 61 leaves are never spoken in any
// transcript (every *Improved field, every windowExteriorTreatment*).
//
//   arm "escape"  — criteria include an explicit "Not stated" option
//   arm "bare"    — criteria are the real members only; silence must show up as low confidence
import { writeFileSync } from "node:fs";
import { ask, results } from "./env.mjs";
import { corpus, assertedLeaves } from "./corpus.mjs";
import { ENUM_LEAVES, NOT_STATED, qid } from "./leaves.mjs";

const ARM = process.argv[2] ?? "escape";
if (!["escape", "bare"].includes(ARM)) throw new Error(`unknown arm: ${ARM}`);

const questions = Object.fromEntries(
  ENUM_LEAVES.map((l) => {
    const criteria = Object.fromEntries(l.options.map((o) => [o, o]));
    if (ARM === "escape") {
      criteria[NOT_STATED] = "The dictation does not state a value for this field.";
    }
    return [
      qid(l.path),
      {
        type: "choice",
        instructions:
          `In this home-energy-audit dictation, which value does the auditor state for the ` +
          `field "${l.path.split(".")[1]}"? Choose only what the auditor actually says.`,
        criteria,
      },
    ];
  }),
);

console.log(`arm=${ARM}  ${ENUM_LEAVES.length} choice questions per request\n`);

const rows = [];
for (const entry of corpus()) {
  const truth = new Map();
  for (const a of assertedLeaves(entry)) {
    if (a.isEnum) truth.set(`${a.group}.${a.leaf}`, a);
  }

  let res;
  try {
    res = await ask({ state: entry.transcript, questions });
  } catch (e) {
    console.log(`${entry.name}: REQUEST FAILED ${String(e).slice(0, 300)}`);
    continue;
  }

  const answers = {};
  for (const l of ENUM_LEAVES) {
    const a = res.answers[qid(l.path)];
    answers[l.path] = { choice: a.choice, confidence: a.confidence };
  }
  rows.push({
    name: entry.name,
    ms: res.ms,
    usage: res.usage,
    answers,
    truth: Object.fromEntries(
      [...truth].map(([k, v]) => [k, { value: v.value, alts: v.alternatives }]),
    ),
  });
  console.log(
    `${entry.name.padEnd(28)} ${res.ms.toString().padStart(5)}ms  ` +
      `${res.usage.input_tokens} in / ${res.usage.output_tokens} out  ` +
      `(${truth.size} enum leaves asserted in ground truth)`,
  );
}

writeFileSync(results(`enums-${ARM}.json`), JSON.stringify(rows, null, 2));
console.log(`\nwrote results/enums-${ARM}.json`);
