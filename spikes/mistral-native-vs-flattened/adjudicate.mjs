#!/usr/bin/env node
/**
 * Adjudication for the mistral-native-vs-flattened spike.
 *
 * Method: every disagreement row in results/adjudication-queue.json was
 * reviewed against the source PDF's own text layer (pdfplumber extract,
 * cross-checked against the Mistral OCR markdown the models saw). Verdicts
 * are mechanical where the correct reading is unambiguous; the field-level
 * verdicts that needed a judgment call are:
 *
 *   - house.totalCoolingLoad on Wrightsoft: the report carries BOTH
 *     "Clg load 22162" (sensible-only, in the Entire House row) and
 *     "Equipment Total Load (Sen+Lat) 24251" on the TOTALS row. Schema field
 *     is "the whole-house total cooling load (Btuh)" — the TOTALS row value
 *     (24251, sensible+latent) is the Manual J "total cooling load". Native
 *     consistently picked 22162 (the row's clg column); flattened
 *     consistently picked 24251 (TOTALS row). Verdict: flattened correct.
 *
 *   - rooms.*.coolingLoad on CoolCalc: the Room Detail pages give
 *     "Total Cooling BTUH" per room. No disagreement there in practice.
 *
 *   - rooms.*.coolingAvf / heatingAvf on CoolCalc: Room Detail pages give one
 *     "CFM: N" per room (CoolCalc does not split heating/cooling airflow).
 *     Native put that number in coolingAvf on every run (and in heatingAvf on
 *     one run). The document DOES state the number, but the schema's
 *     heatingAvf/coolingAvf asks for heating/cooling airflow specifically,
 *     and one undifferentiated CFM field cannot populate both. Since the
 *     flattened arm uniformly emitted null for both, and the native arm's
 *     span ("CFM: 66") is genuine document text, the verdict is: value REAL
 *     (stated), attribution AMBIGUOUS — scored separately rather than as
 *     right/wrong (see FINDINGS.md).
 *
 * Output: results/adjudication.json with per-row verdicts, and a printed
 * aggregate per arm (correct / incorrect / real-stated-by-native-only).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESULTS_DIR } from "./lib.mjs";

const queue = JSON.parse(readFileSync(join(RESULTS_DIR, "adjudication-queue.json"), "utf8"));

const verdicts = [];
for (const row of queue) {
  const { doc, path, nativeValue, flatValue, unpairedSide } = row;
  let v;

  if (
    doc === "coolcalc" &&
    /(coolingAvf|heatingAvf)$/.test(path) &&
    nativeValue !== null &&
    flatValue === null
  ) {
    // CoolCalc Room Detail "CFM: N" — real document text, but a single
    // undifferentiated CFM that the schema's per-heating/cooling-airflow
    // fields cannot both honestly claim. Adjudicated as "stated, attribution
    // ambiguous": native's number is genuinely in the doc (never invented),
    // flat's null is the conservative reading.
    v = { verdict: "native-real-ambiguous-field", correct: ["native-stated", "flat-conservative"] };
  } else if (doc === "wrightsoft" && path === "house.totalCoolingLoad") {
    // TOTALS row Sen+Lat 24251 is the whole-house total cooling load;
    // 22162 is the sensible-only column of the Entire House row.
    v =
      nativeValue === 22162 && flatValue === 24251
        ? { verdict: "flat-correct", correct: ["flat"] }
        : { verdict: "check-manually", correct: [] };
  } else if (doc === "wrightsoft" && unpairedSide === "native") {
    // Native emitted zone-summary rows (Level 1/2 ODU) as extra rooms;
    // flattened omitted them. Those rows exist in the report but duplicate
    // the per-room rows above them — an over-extraction, not an invention.
    v = { verdict: "native-extra-zone-rows", correct: ["flat"] };
  } else if (
    doc === "wrightsoft" &&
    /^house\.(heatingEquipmentManufacturer|heatingEquipmentModel|hvacSystemType)$/.test(path) &&
    nativeValue === null &&
    flatValue !== null
  ) {
    // Document states all three on the Manual S page; native abstained,
    // flattened found them with grounded spans.
    v = { verdict: "flat-correct-native-abstained", correct: ["flat"] };
  } else {
    v = { verdict: "unclassified", correct: [] };
  }

  verdicts.push({ ...row, ...v });
}

writeFileSync(join(RESULTS_DIR, "adjudication.json"), JSON.stringify(verdicts, null, 2));

import { strict as assert } from "node:assert";
const unclassified = verdicts.filter(
  (v) => v.verdict === "unclassified" || v.verdict === "check-manually",
);
if (unclassified.length) {
  console.log("UNCLASSIFIED ROWS — adjudicate by hand before scoring:");
  for (const u of unclassified)
    console.log(" ", u.doc, u.run, u.path, u.nativeValue, "vs", u.flatValue);
  process.exit(1);
}

// Aggregate
const tally = {};
for (const v of verdicts) {
  tally[v.verdict] = (tally[v.verdict] ?? 0) + 1;
}
console.log("verdicts:", tally);

// Per-arm correct counts over the adjudicated set. For
// "native-real-ambiguous-field" rows we count BOTH arms as defensible but
// report them separately — see FINDINGS.md.
let flatCorrect = 0,
  nativeCorrect = 0,
  ambiguous = 0;
for (const v of verdicts) {
  if (v.verdict === "native-real-ambiguous-field") {
    ambiguous++;
    continue;
  }
  if (v.correct.includes("flat")) flatCorrect++;
  if (v.correct.includes("native")) nativeCorrect++;
}
console.log(`adjudicated disagreements: ${verdicts.length}`);
console.log(
  `  decisive (one arm right): flat-correct ${flatCorrect}, native-correct ${nativeCorrect}`,
);
console.log(`  ambiguous (native stated a real number, field attribution debatable): ${ambiguous}`);
assert.ok(flatCorrect + nativeCorrect + ambiguous === verdicts.length);
