// Probe 7: does telling the verifier the field's vocabulary separate schema-mapping from
// hallucination?
//
// Probe 6 asked "is `dhwAgeBand = "0-5"` supported?" against "Yeah, two years" and said no —
// the literal string is not in the text. But "0-5" is the schema's ENCODING of two years, and
// the extractor was told the vocabulary when it chose. The verifier was not. This probe hands
// it the same vocabulary and states that a faithful encoding counts as supported.
//
// Same 124 leaves as probe 6, so the two are directly comparable.
import { readFileSync, writeFileSync } from "node:fs";
import { ask, results } from "./env.mjs";
import { FIELD_OPTIONS } from "./old-schema.mjs";

const prior = JSON.parse(readFileSync(results("grounded-vs-supported.json"), "utf8"));
const byName = new Map();
for (const r of prior) {
  if (!byName.has(r.name)) byName.set(r.name, []);
  byName.get(r.name).push(r);
}
const spikeDir = new URL("../0001-extraction-snuggpro/", import.meta.url);

const vocabLine = (field) => {
  const opts = FIELD_OPTIONS.get(field);
  return opts ? `The field "${field}" records exactly one of: ${opts.join(", ")}. ` : "";
};

// The encoding clause is the whole experiment: it tells the verifier that the value is a code
// from a closed list, not a phrase expected to appear in the dictation.
const ENCODING =
  "The value is a code from that fixed list, not a quote. A faithful encoding of what the " +
  "auditor said counts as SUPPORTED — a stated duration falling inside a band, a stated " +
  "material matching a category, a stated appliance matching an equipment class. It is " +
  "UNSUPPORTED only if the dictation does not state or plainly mean that code, including " +
  "when the code asserts a further fact the auditor never gave.";

const rows = [];
for (const [name, leaves] of byName) {
  const transcript = readFileSync(new URL(`transcripts/${name}.txt`, spikeDir), "utf8").trim();

  const questions = {};
  leaves.forEach((l, i) => {
    questions[`h${i}`] = {
      type: "noul",
      instructions:
        `${vocabLine(l.field)}An extractor chose "${l.value}" for it from this ` +
        `home-energy-audit dictation. ${ENCODING} Is that choice unsupported?`,
      criteria: {
        true: "the dictation does not state or plainly mean this code",
        false: "the dictation states it, or the code faithfully encodes what was said",
      },
    };
    questions[`o${i}`] = {
      type: "noul",
      instructions:
        `${vocabLine(l.field)}An extractor chose "${l.value}" for it. Does this dictation ` +
        `fail to genuinely report the field "${l.field}" at all?`,
      criteria: {
        true: "the field is never discussed; the value was inferred from a different field",
        false: "the dictation genuinely reports this field",
      },
    };
  });

  const res = await ask({ state: transcript, questions });
  leaves.forEach((l, i) => {
    rows.push({
      ...l,
      hasVocab: FIELD_OPTIONS.has(l.field),
      before: l.unsupported,
      after: Math.max(res.answers[`h${i}`].noul, res.answers[`o${i}`].noul),
    });
  });
  console.log(`${name.padEnd(28)} ${String(res.ms).padStart(5)}ms  ${leaves.length} leaves`);
}

writeFileSync(results("vocab.json"), JSON.stringify(rows, null, 2));

const T = 0.6;
const flagged = (k) => rows.filter((r) => r[k] > T);
console.log(`\n${rows.length} leaves, FIRE_T=${T}`);
console.log(`flagged before (no vocabulary): ${flagged("before").length}`);
console.log(`flagged after  (vocabulary):    ${flagged("after").length}`);

const moved = rows.filter((r) => r.before > T !== r.after > T).sort((a, b) => b.before - a.before);
console.log(`\nleaves that changed side (${moved.length}):`);
for (const r of moved) {
  const dir = r.before > T ? "CLEARED" : "NEWLY FLAGGED";
  console.log(
    `  ${dir.padEnd(14)} ${r.before.toFixed(2)} -> ${r.after.toFixed(2)}  ` +
      `${r.name.slice(0, 2)} ${r.field} = ${JSON.stringify(r.value)}`,
  );
  console.log(`      span: ${JSON.stringify(r.sourceSpan)}`);
}

const still = flagged("after").sort((a, b) => b.after - a.after);
console.log(`\nstill flagged with vocabulary (${still.length}):`);
for (const r of still) {
  console.log(
    `  ${r.after.toFixed(2)} ${r.name.slice(0, 2)} ${r.field} = ${JSON.stringify(r.value)}`,
  );
  console.log(`      span: ${JSON.stringify(r.sourceSpan)}`);
}
