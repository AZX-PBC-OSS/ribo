#!/usr/bin/env node
/**
 * Annotator self-check.
 *
 *   node spikes/extraction-snuggpro/validate-ground-truth.mjs ground-truth/NN-slug.json [more files...]
 *
 * Every one of the 26 parallel re-annotation tasks should run this on its own output before
 * submitting. It catches the mechanical mistakes (a missing leaf, a typo'd enum member, a
 * `sourceSpan` on an "unmentioned" leaf) that would otherwise only surface once two annotators'
 * files are diffed against each other — this is the fast, solo feedback loop for that.
 *
 * Exit code is 0 iff every given file is valid new-format ground truth. A file still in the OLD
 * format (no `leaves` key) is reported, not treated as an error — see ANNOTATOR_GUIDE.md.
 */

import { readFileSync } from "node:fs";
import { isNewFormat, validateGroundTruth } from "./ground-truth.mjs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node validate-ground-truth.mjs ground-truth/NN-slug.json [...]");
  process.exit(2);
}

let anyFailed = false;
for (const file of files) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.log(`FAIL  ${file}\n  not readable/parseable JSON: ${err.message}`);
    anyFailed = true;
    continue;
  }
  if (!isNewFormat(raw)) {
    console.log(`SKIP  ${file}  (old format — no "leaves" key; not yet re-annotated)`);
    continue;
  }
  const { ok, errors } = validateGroundTruth(raw);
  if (ok) {
    console.log(`PASS  ${file}`);
  } else {
    anyFailed = true;
    console.log(`FAIL  ${file}`);
    for (const e of errors) console.log(`  - ${e}`);
  }
}

process.exit(anyFailed ? 1 : 0);
