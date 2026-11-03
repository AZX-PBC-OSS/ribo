// Tests one hypothesis from diagnose.mjs: presence drops `dhwType2`-style leaves because the
// shipped question names the bare wire path, where probe 10 (recall 1.000) described each enum leaf
// by its members. Re-asks every leaf presence dropped, in probe 10's form, on the same model.
//
//   SYSTEMONE=md-1 node reask-described.mjs     (or SYSTEMONE=jev)
import { readFileSync } from "node:fs";
import { LEAF_BY_PATH } from "../0001-extraction-snuggpro/schema-leaves.mjs";
import { ask } from "../0008-typesafe-jev/env.mjs";
import { corpus } from "../0008-typesafe-jev/corpus.mjs";

const arm = process.env.SYSTEMONE;
const rows = JSON.parse(readFileSync(new URL("./results/diagnose.json", import.meta.url), "utf8"));
const dropped = rows.filter(
  (r) =>
    r.arm === arm && r.instance === 0 && r.narrowed === null && r.baseline !== null && r.noul < 0.2,
);
const transcripts = new Map(corpus().map((e) => [e.name, e.transcript]));

// Probe 10's question, verbatim.
const describe = (leaf) => {
  const name = leaf.path.split(".")[1];
  if (leaf.kind === "enum") return `"${name}" (one of: ${leaf.options.join(", ")})`;
  return `"${name}" (a ${leaf.kind})`;
};

let rescued = 0;
for (const r of dropped) {
  const schemaPath = r.presenceId;
  const leaf = LEAF_BY_PATH.get(schemaPath);
  const res = await ask({
    state: transcripts.get(r.name),
    questions: {
      q: {
        type: "noul",
        instructions:
          `Does this home-energy-audit dictation discuss the field ${describe(leaf)}? ` +
          `Answer yes if the auditor says something about it — including explicitly ` +
          `declining to give a value. Answer no if the field never comes up.`,
      },
    },
  });
  const p = res.answers.q.noul;
  if (p >= 0.2) rescued += 1;
  console.log(`${r.noul.toFixed(3)} -> ${p.toFixed(3)}  ${r.name.slice(0, 2)} ${r.path}`);
}
console.log(`\n${arm}: ${rescued} of ${dropped.length} dropped leaves clear 0.2 when described`);
