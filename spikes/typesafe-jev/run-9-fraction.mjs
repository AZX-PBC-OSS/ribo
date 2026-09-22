// Probe 9: the corroboration fraction on the CURRENT schema, for two rungs.
//
// `corroborateExtractor`'s policy thresholds the FRACTION of committed leaves that score
// unsupported (probe 7: single-leaf scores are too inconsistent to gate on). This measures that
// fraction's distribution for a cheap rung and a strong one, which is what a default has to
// separate. Probe 6/7's 10-of-124 figure was the superseded 23-field schema.
//
//   node run-9-fraction.mjs <model>
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapExtractedLeaves, spanGroundedness } from "../../packages/ribo-core/dist/index.js";
import { LEAF_BY_PATH } from "../extraction-snuggpro/schema-leaves.mjs";
import { ask } from "./env.mjs";
import { corpus } from "./corpus.mjs";

const model = process.argv[2] ?? "claude-haiku-4-5";
const dir = fileURLToPath(new URL(`./results/extractions-${model}/`, import.meta.url));
const transcripts = new Map(corpus().map((e) => [e.name, e.transcript]));

// An instance index in the path is not part of the schema address: hvac[0].hvacDuctLeakage and
// hvac[1].hvacDuctLeakage are the same leaf. Drop numeric segments to look the schema up.
const schemaPath = (path) => path.filter((s) => typeof s === "string").join(".");

const ENCODING =
  "The value is a code from that fixed list, not a quote. A faithful encoding of what the " +
  "auditor said counts as SUPPORTED — a stated duration falling inside a band, a stated " +
  "material matching a category, a stated appliance matching an equipment class. It is " +
  "UNSUPPORTED only if the dictation does not state or plainly mean that code, including " +
  "when the code asserts a further fact the auditor never gave.";

const rows = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const name = file.slice(0, -5);
  const transcript = transcripts.get(name);
  const fields = JSON.parse(readFileSync(dir + file, "utf8"));

  const leaves = [];
  mapExtractedLeaves(fields, [], (leaf, path) => {
    if (leaf.value !== null && leaf.value !== undefined) {
      const sp = schemaPath(path);
      leaves.push({
        path: path.join("."),
        field: path[path.length - 1],
        value: leaf.value,
        options: LEAF_BY_PATH.get(sp)?.options ?? null,
        groundedness: spanGroundedness(leaf.sourceSpan ?? null, transcript),
      });
    }
    return leaf;
  });

  if (leaves.length === 0) {
    console.log(`${name.padEnd(28)} no committed leaves`);
    continue;
  }

  // Chunked: 2 questions per leaf, kept under the size probe 3 proved comfortable.
  const scores = new Map();
  for (let i = 0; i < leaves.length; i += 30) {
    const slice = leaves.slice(i, i + 30);
    const questions = {};
    slice.forEach((l, j) => {
      const vocab = l.options
        ? `The field "${l.field}" records exactly one of: ${l.options.join(", ")}. `
        : "";
      questions[`h${j}`] = {
        type: "noul",
        instructions:
          `${vocab}An extractor chose ${JSON.stringify(l.value)} for it from this ` +
          `home-energy-audit dictation. ${l.options ? ENCODING : ""} Is that choice unsupported?`,
        criteria: {
          true: "the dictation does not state or plainly mean this value",
          false: "the dictation states it, or the value faithfully encodes what was said",
        },
      };
      questions[`o${j}`] = {
        type: "noul",
        instructions: `An extractor recorded a value for "${l.field}". Does this dictation fail to genuinely report that field at all?`,
        criteria: {
          true: "the field is never discussed; the value was inferred from a different field",
          false: "the dictation genuinely reports this field",
        },
      };
    });
    const res = await ask({ state: transcript, questions });
    slice.forEach((l, j) => {
      scores.set(l.path, Math.max(res.answers[`h${j}`].noul, res.answers[`o${j}`].noul));
    });
  }

  const scored = leaves.map((l) => ({ ...l, unsupported: scores.get(l.path) ?? 0 }));
  const over = (t) => scored.filter((l) => l.unsupported > t).length;
  rows.push({ name, model, committed: leaves.length, scored, fraction: over(0.6) / leaves.length });
  console.log(
    `${name.padEnd(28)} ${String(leaves.length).padStart(4)} committed  ` +
      `${String(over(0.6)).padStart(3)} unsupported  fraction ${(over(0.6) / leaves.length).toFixed(3)}  ` +
      `(grounded ${scored.filter((l) => l.groundedness === "grounded").length}/${leaves.length})`,
  );
}

writeFileSync(
  new URL(`./results/fraction-${model}.json`, import.meta.url),
  JSON.stringify(rows, null, 2),
);

const fr = rows.map((r) => r.fraction).sort((a, b) => a - b);
const pick = (q) => fr[Math.min(fr.length - 1, Math.floor(q * fr.length))];
console.log(
  `\n${model}: ${rows.length} transcripts, ` +
    `${rows.reduce((a, r) => a + r.committed, 0)} committed leaves\n` +
    `  fraction  min ${fr[0]?.toFixed(3)}  median ${pick(0.5)?.toFixed(3)}  ` +
    `p90 ${pick(0.9)?.toFixed(3)}  max ${fr[fr.length - 1]?.toFixed(3)}`,
);
