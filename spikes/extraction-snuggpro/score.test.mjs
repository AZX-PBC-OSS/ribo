#!/usr/bin/env node
/**
 * Mutation tests for score.mjs.
 *
 *   node spikes/extraction-snuggpro/score.test.mjs
 *
 * "A gate you haven't watched fail isn't a gate." Each test builds a PERFECT model output by
 * copying a real ground-truth file (spans in GT are verbatim substrings of the transcript, so a
 * copy scores clean), asserts the relevant metric is green, then MUTATES one field and asserts the
 * metric goes red — printing the before/after numbers. The fixtures are synthetic (built from GT +
 * transcript), never from results/ extraction output, so the scorer is proven independent of what
 * the live runs produce.
 *
 * Exit non-zero if any assertion fails.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scoreTranscript, buildPerfectModel, aggregate } from "./score.mjs";

const HERE = import.meta.dirname;
const GT_DIR = join(HERE, "ground-truth");
const TRANSCRIPT_DIR = join(HERE, "transcripts");

let failures = 0;
let passes = 0;

function check(desc, cond) {
  if (cond) {
    passes++;
    console.log(`   PASS  ${desc}`);
  } else {
    failures++;
    console.log(`   FAIL  ${desc}`);
  }
}

function load(slug) {
  const gt = JSON.parse(readFileSync(join(GT_DIR, `${slug}.json`), "utf8"));
  const transcript = readFileSync(join(TRANSCRIPT_DIR, `${slug}.txt`), "utf8");
  return { gt, transcript };
}

/** Score a slug with a model produced by mutating the perfect copy. */
function run(slug, mutate) {
  const { gt, transcript } = load(slug);
  const model = buildPerfectModel(gt);
  if (mutate) mutate(model, gt);
  return scoreTranscript(slug, gt, transcript, model);
}

function heading(title) {
  console.log("");
  console.log("=".repeat(82));
  console.log(title);
  console.log("=".repeat(82));
}

// ---------------------------------------------------------------------------
// 0. PERFECT MATCH — a copy of ground truth must score 100% clean.
// ---------------------------------------------------------------------------
heading("0. PERFECT-MATCH FIXTURES — copy of GT must be clean");
for (const slug of [
  "05-full-walkthrough",
  "08-no-fuel-silent-drop",
  "07-combustion-safety",
  "14-rapid-recap",
]) {
  const r = run(slug);
  const c = r.counts;
  const clean =
    c.hallucinationHard === 0 &&
    c.hallucinationSoft === 0 &&
    c.rvalueConversion === 0 &&
    c.miss === 0 &&
    c.wrong === 0 &&
    c.spanFabricated === 0 &&
    c.spanMissing === 0 &&
    c.spanVerbatim === c.spanChecked &&
    c.hHallucinatedPass === 0 &&
    c.hHallucinatedProblem === 0 &&
    c.hCleanDropped === 0 &&
    c.hMiss === 0 &&
    c.hWrongState === 0 &&
    r.conformance.missingKeys.length === 0 &&
    r.conformance.envelopeErrors.length === 0;
  console.log(
    `   ${slug}: halluc=${c.hallucinationHard} miss=${c.miss} wrong=${c.wrong} ` +
      `spanVerbatim=${c.spanVerbatim}/${c.spanChecked} hPass=${c.hHallucinatedPass} cleanDropped=${c.hCleanDropped}`,
  );
  check(`${slug} scores 100% clean`, clean);
}

// ---------------------------------------------------------------------------
// 1. HALLUCINATION — non-null on a GT-null field.
// ---------------------------------------------------------------------------
heading("1. HALLUCINATION gate");
{
  const before = run("14-rapid-recap");
  const after = run("14-rapid-recap", (m) => {
    m.heatingEquipmentType = { value: "boiler", confidence: 0.9, sourceSpan: "electric tank" };
  });
  console.log(
    `   before hallucinationHard=${before.counts.hallucinationHard}   after=${after.counts.hallucinationHard}`,
  );
  check(
    "fabricating heatingEquipmentType flips hallucinationHard 0 -> 1",
    before.counts.hallucinationHard === 0 && after.counts.hallucinationHard === 1,
  );
  check(
    "the fabricated field is listed",
    after.hallucinations.some((h) => h.field === "heatingEquipmentType"),
  );
}

// ---------------------------------------------------------------------------
// 2. FABRICATED SPAN — sourceSpan not in the transcript.
// ---------------------------------------------------------------------------
heading("2. FABRICATED-SPAN gate");
{
  const before = run("05-full-walkthrough");
  const after = run("05-full-walkthrough", (m) => {
    m.heatingManufacturer.sourceSpan = "the plate clearly said Frobozz Magic HVAC Corp";
  });
  console.log(
    `   before spanFabricated=${before.counts.spanFabricated} verbatim=${before.counts.spanVerbatim}/${before.counts.spanChecked}`,
  );
  console.log(
    `   after  spanFabricated=${after.counts.spanFabricated} verbatim=${after.counts.spanVerbatim}/${after.counts.spanChecked}`,
  );
  check(
    "fabricated span flips spanFabricated 0 -> 1",
    before.counts.spanFabricated === 0 && after.counts.spanFabricated === 1,
  );
  check(
    "verbatim count drops by exactly one",
    after.counts.spanVerbatim === before.counts.spanVerbatim - 1,
  );
}

// ---------------------------------------------------------------------------
// 3. OTHER-DODGE — `other` where GT is a real enum member.
// ---------------------------------------------------------------------------
heading("3. OTHER-DODGE gate (enum-mapping)");
{
  const before = run("13-enum-paraphrase");
  const after = run("13-enum-paraphrase", (m) => {
    m.windowFrame.value = "other"; // GT is wood_or_metal_clad
  });
  console.log(
    `   before enumCorrect=${before.counts.enumCorrect}/${before.counts.enumGtMember} otherDump=${before.counts.enumOtherDump}`,
  );
  console.log(
    `   after  enumCorrect=${after.counts.enumCorrect}/${after.counts.enumGtMember} otherDump=${after.counts.enumOtherDump}`,
  );
  check(
    "other-dodge flips enumOtherDump 0 -> 1",
    before.counts.enumOtherDump === 0 && after.counts.enumOtherDump === 1,
  );
  check(
    "enumCorrect drops by one (other is scored WRONG)",
    after.counts.enumCorrect === before.counts.enumCorrect - 1,
  );
}

// ---------------------------------------------------------------------------
// 4. R-VALUE -> BAND INVENTION — a band conjured from a spoken R-value.
// ---------------------------------------------------------------------------
heading("4. R-VALUE -> BAND INVENTION gate");
{
  const before = run("01-attic-r-value-shell");
  const after = run("01-attic-r-value-shell", (m) => {
    m.atticInsulationDepthIn = { value: "10-12", confidence: 0.9, sourceSpan: "about R-38" };
  });
  console.log(
    `   before rvalueConversion=${before.counts.rvalueConversion} hallucinationHard=${before.counts.hallucinationHard}`,
  );
  console.log(
    `   after  rvalueConversion=${after.counts.rvalueConversion} hallucinationHard=${after.counts.hallucinationHard}`,
  );
  check(
    "converting R-38 -> band flips rvalueConversion 0 -> 1",
    before.counts.rvalueConversion === 0 && after.counts.rvalueConversion === 1,
  );
  check("it is also counted as a hard hallucination", after.counts.hallucinationHard === 1);
  check(
    "the hallucination is flagged rvalueConversion",
    after.hallucinations.some((h) => h.field === "atticInsulationDepthIn" && h.rvalueConversion),
  );
}

// ---------------------------------------------------------------------------
// 5. SILENT-FUEL-DROP — two directions.
// ---------------------------------------------------------------------------
heading("5a. SILENT-FUEL-DROP — fuel INVENTED where none stated (08)");
{
  const before = run("08-no-fuel-silent-drop");
  const after = run("08-no-fuel-silent-drop", (m) => {
    m.heatingFuel = {
      value: "natural_gas",
      confidence: 0.9,
      sourceSpan: "heating is a furnace, forced air",
    };
  });
  console.log(
    `   before axis=${before.axis.category} hallucinationHard=${before.counts.hallucinationHard}`,
  );
  console.log(
    `   after  axis=${after.axis.category} hallucinationHard=${after.counts.hallucinationHard}`,
  );
  check("clean run respects the silent drop", before.axis.category === "silentDropRespected");
  check("inventing a fuel flips axis -> fuelInvented", after.axis.category === "fuelInvented");
  check(
    "and is a hard hallucination (fuel emitted where GT null)",
    after.counts.hallucinationHard === 1,
  );
}
heading("5b. SILENT-FUEL-DROP — fuel DROPPED where stated (05)");
{
  const before = run("05-full-walkthrough");
  const after = run("05-full-walkthrough", (m) => {
    m.heatingFuel.value = null; // GT is propane
    m.heatingFuel.sourceSpan = null;
  });
  console.log(`   before axis=${before.axis.category} miss=${before.counts.miss}`);
  console.log(`   after  axis=${after.axis.category} miss=${after.counts.miss}`);
  check("clean run splits both axes (bothCorrect)", before.axis.category === "bothCorrect");
  check("dropping the fuel flips axis -> fuelDropped", after.axis.category === "fuelDropped");
  check("and registers a miss", after.counts.miss === before.counts.miss + 1);
}

// ---------------------------------------------------------------------------
// 6. HALLUCINATED HEALTH PASS — `passed` on a silent test.
// ---------------------------------------------------------------------------
heading("6. HALLUCINATED-HEALTH-PASS gate");
{
  const before = run("14-rapid-recap");
  const after = run("14-rapid-recap", (m) => {
    m.healthSafety.ambientCo = {
      value: "passed",
      confidence: 0.9,
      sourceSpan: "electric tank, standard storage unit",
    };
  });
  console.log(
    `   before hHallucinatedPass=${before.counts.hHallucinatedPass}   after=${after.counts.hHallucinatedPass}`,
  );
  check(
    "silence -> passed flips hHallucinatedPass 0 -> 1",
    before.counts.hHallucinatedPass === 0 && after.counts.hHallucinatedPass === 1,
  );
  check(
    "it is listed as a health deviation",
    after.health.some((h) => h.test === "ambientCo" && h.category === "hallucinatedPass"),
  );
}

// ---------------------------------------------------------------------------
// 7. MISS — null where GT has a value.
// ---------------------------------------------------------------------------
heading("7. MISS gate");
{
  const before = run("05-full-walkthrough");
  const after = run("05-full-walkthrough", (m) => {
    m.blowerDoorCfm50.value = null;
    m.blowerDoorCfm50.sourceSpan = null;
  });
  console.log(`   before miss=${before.counts.miss}   after=${after.counts.miss}`);
  check(
    "nulling a stated value flips miss 0 -> 1",
    before.counts.miss === 0 && after.counts.miss === 1,
  );
}

// ---------------------------------------------------------------------------
// 8. CLEAN DROPPED TO NULL — a clean health result lost.
// ---------------------------------------------------------------------------
heading("8. CLEAN-DROPPED-TO-NULL gate");
{
  const before = run("07-combustion-safety");
  const after = run("07-combustion-safety", (m) => {
    m.healthSafety.naturalConditionSpillage.value = null; // GT is passed
    m.healthSafety.naturalConditionSpillage.sourceSpan = null;
  });
  console.log(
    `   before cleanDropped=${before.counts.hCleanDropped} gtPassedCorrect=${before.counts.hGtPassedCorrect}/${before.counts.hGtPassed}`,
  );
  console.log(
    `   after  cleanDropped=${after.counts.hCleanDropped} gtPassedCorrect=${after.counts.hGtPassedCorrect}/${after.counts.hGtPassed}`,
  );
  check(
    "dropping a passed result flips cleanDropped 0 -> 1",
    before.counts.hCleanDropped === 0 && after.counts.hCleanDropped === 1,
  );
}

// ---------------------------------------------------------------------------
// 9. BAND BOUNDARY vs FLAT WRONG — off-by-one bucket is its own category.
// ---------------------------------------------------------------------------
heading("9. BAND-BOUNDARY gate (13 dhwAgeBand 11-15)");
{
  const before = run("13-enum-paraphrase");
  const boundary = run("13-enum-paraphrase", (m) => {
    m.dhwAgeBand.value = "16-20"; // adjacent to 11-15
  });
  const farWrong = run("13-enum-paraphrase", (m) => {
    m.dhwAgeBand.value = "36+"; // far
  });
  console.log(
    `   before  bandCorrect=${before.counts.bandCorrect} boundary=${before.counts.bandBoundary} wrong=${before.counts.bandWrong}`,
  );
  console.log(
    `   +1band  bandCorrect=${boundary.counts.bandCorrect} boundary=${boundary.counts.bandBoundary} wrong=${boundary.counts.bandWrong}`,
  );
  console.log(
    `   far     bandCorrect=${farWrong.counts.bandCorrect} boundary=${farWrong.counts.bandBoundary} wrong=${farWrong.counts.bandWrong}`,
  );
  check(
    "16-20 is a boundary error, not flat-wrong",
    boundary.counts.bandBoundary === 1 && boundary.counts.bandWrong === 0,
  );
  check(
    "36+ is flat-wrong, not a boundary",
    farWrong.counts.bandWrong === 1 && farWrong.counts.bandBoundary === 0,
  );
}

// ---------------------------------------------------------------------------
// 10. PARTIAL-CREDIT — sanctioned alternatives must NOT read as hard failures.
// ---------------------------------------------------------------------------
heading(
  "10a. PARTIAL-CREDIT — 07 worst-case depressurization passed is a MILD read, not a hallucinated pass",
);
{
  const after = run("07-combustion-safety", (m) => {
    m.healthSafety.worstCaseDepressurization = {
      value: "passed",
      confidence: 0.6,
      sourceSpan: "minus fifty pascals",
    };
  });
  console.log(
    `   after hHallucinatedPass=${after.counts.hHallucinatedPass} softPass=${after.counts.hSoftPass}`,
  );
  check(
    "passed on 07 wcd is softPass, NOT a hallucinated pass",
    after.counts.hHallucinatedPass === 0 && after.counts.hSoftPass === 1,
  );
}
heading(
  "10b. PARTIAL-CREDIT — 03 windowGlazing double_pane is wrong-but-grounded, not a hard hallucination",
);
{
  const after = run("03-quick-exterior-short", (m) => {
    m.windowGlazing = { value: "double_pane", confidence: 0.5, sourceSpan: "so I'm not certain" };
  });
  console.log(
    `   after hallucinationHard=${after.counts.hallucinationHard} hallucinationSoft=${after.counts.hallucinationSoft}`,
  );
  check(
    "double_pane on 03 glazing is a sanctioned soft alternative",
    after.counts.hallucinationHard === 0 && after.counts.hallucinationSoft === 1,
  );
}
heading("10c. CONTRAST — a NON-sanctioned member on 07 wcd (failed) IS wrong");
{
  const after = run("07-combustion-safety", (m) => {
    m.healthSafety.worstCaseDepressurization = {
      value: "failed",
      confidence: 0.6,
      sourceSpan: "minus fifty pascals",
    };
  });
  console.log(
    `   after hHallucinatedProblem=${after.counts.hHallucinatedProblem} softPass=${after.counts.hSoftPass}`,
  );
  check(
    "failed on 07 wcd is a hallucinated problem (note says failed/warning wrong)",
    after.counts.hHallucinatedProblem === 1 && after.counts.hSoftPass === 0,
  );
}

// ---------------------------------------------------------------------------
// 11. ROBUSTNESS — missing file, missing key, extra key, malformed envelope.
// ---------------------------------------------------------------------------
heading("11. ROBUSTNESS");
{
  const { gt, transcript } = load("05-full-walkthrough");
  const miss = scoreTranscript("05-full-walkthrough", gt, transcript, null, "result file absent");
  console.log(`   missing file: status=${miss.status} gtNonNull=${miss.counts.gtNonNull}`);
  check("a missing result is status=unscored, not a crash", miss.status === "unscored");
  check("its GT-side denominators survive (whole-transcript miss)", miss.counts.gtNonNull > 0);

  const missingKey = run("05-full-walkthrough", (m) => {
    delete m.blowerDoorCfm50; // GT non-null
  });
  console.log(
    `   missing key: missingKeys=[${missingKey.conformance.missingKeys}] miss=${missingKey.counts.miss}`,
  );
  check(
    "a missing key is reported and treated as null (a miss)",
    missingKey.conformance.missingKeys.includes("blowerDoorCfm50") && missingKey.counts.miss === 1,
  );

  const extraKey = run("05-full-walkthrough", (m) => {
    m.someBogusField = { value: 1, confidence: 1, sourceSpan: null };
  });
  console.log(`   extra key: extraKeys=[${extraKey.conformance.extraKeys}]`);
  check(
    "an extra key is reported without crashing",
    extraKey.conformance.extraKeys.includes("someBogusField"),
  );

  const malformed = run("05-full-walkthrough", (m) => {
    m.heatingFuel = "propane"; // a bare string, not an envelope
  });
  console.log(
    `   malformed envelope: envelopeErrors=${malformed.conformance.envelopeErrors.length}`,
  );
  check(
    "a non-object envelope is reported, not thrown",
    malformed.conformance.envelopeErrors.some((e) => e.startsWith("heatingFuel")),
  );
}

// ---------------------------------------------------------------------------
// 12. AGGREGATE — the multi-transcript roll-up runs and sums.
// ---------------------------------------------------------------------------
heading("12. AGGREGATE roll-up");
{
  const slugs = ["05-full-walkthrough", "08-no-fuel-silent-drop", "14-rapid-recap"];
  const reports = slugs.map((s) => run(s));
  const agg = aggregate(reports);
  console.log(
    `   aggregate over ${slugs.length} perfect fixtures: hallucinationHard=${agg.totals.hallucinationHard} miss=${agg.totals.miss} hPass=${agg.totals.hHallucinatedPass}`,
  );
  check(
    "aggregate of perfect fixtures is all-clean",
    agg.totals.hallucinationHard === 0 &&
      agg.totals.miss === 0 &&
      agg.totals.hHallucinatedPass === 0,
  );
}

// ---------------------------------------------------------------------------
console.log("");
console.log("=".repeat(82));
console.log(`RESULT: ${passes} passed, ${failures} failed`);
console.log("=".repeat(82));
process.exit(failures ? 1 : 0);
