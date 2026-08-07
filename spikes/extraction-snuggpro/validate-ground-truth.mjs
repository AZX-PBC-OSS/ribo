#!/usr/bin/env node
/**
 * Annotator self-check.
 *
 *   node spikes/extraction-snuggpro/validate-ground-truth.mjs ground-truth/NN-slug.json [more files...]
 *
 * Every one of the 26 parallel re-annotation tasks should run this on its own output before
 * submitting. It catches the mechanical mistakes — an unknown leaf key, a typo'd enum member (or
 * one carried on the wrong leaf kind), a `sourceSpan` (on a leaf OR a disclaimer) that is not a
 * verbatim substring of the actual transcript, a wrong `schemaVersion`, two disclaimers whose
 * scopes overlap, a disclaimer with no span/topic/note or an unrecognized scope — that would
 * otherwise only surface once two annotators' files are diffed against each other. This is the
 * fast, solo feedback loop for that. NOTE: sparse `leaves` means a leaf simply absent from the file
 * (and not covered by any disclaimer) is VALID — it resolves to "unmentioned" — so this is not a
 * "missing leaf" checker; nothing here claims to require every one of the 51 keys to be present.
 *
 * Exit code is 0 iff every given file is valid new-format ground truth (warnings do not fail the
 * exit code — they flag things worth a human's attention, like an `unresolved` disclaimer scope or
 * a topic/scope pairing that looks like a copy-paste mistake, that cannot be mechanically proven
 * wrong). A file still in the OLD format (no `leaves` key) is reported, not treated as an error —
 * see ANNOTATOR_GUIDE.md. `validateGroundTruth` itself never throws, but this script also wraps the
 * call so a defect in the validator degrades to a reported failure for that one file, not a crash
 * that stops every other file in the batch from being checked.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isNewFormat, validateGroundTruth } from "./ground-truth.mjs";

const HERE = import.meta.dirname;

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
  const transcriptPath = join(HERE, raw.transcript ?? "");
  if (!existsSync(transcriptPath)) {
    console.log(
      `FAIL  ${file}\n  "transcript" path ${JSON.stringify(raw.transcript)} does not resolve to a real file (looked at ${transcriptPath})`,
    );
    anyFailed = true;
    continue;
  }
  const transcriptText = readFileSync(transcriptPath, "utf8");
  let result;
  try {
    result = validateGroundTruth(raw, transcriptText);
  } catch (err) {
    console.log(`FAIL  ${file}\n  validator threw: ${err.stack ?? err.message}`);
    anyFailed = true;
    continue;
  }
  const { ok, errors, warnings } = result;
  if (ok) {
    console.log(`PASS  ${file}`);
  } else {
    anyFailed = true;
    console.log(`FAIL  ${file}`);
    for (const e of errors) console.log(`  - ${e}`);
  }
  for (const w of warnings ?? []) console.log(`  ! WARNING: ${w}`);
}

process.exit(anyFailed ? 1 : 0);
