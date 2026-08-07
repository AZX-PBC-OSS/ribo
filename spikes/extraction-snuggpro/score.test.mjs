#!/usr/bin/env node
/**
 * Mutation tests for score.mjs, schema-leaves.mjs and ground-truth.mjs.
 *
 *   node spikes/extraction-snuggpro/score.test.mjs
 *
 * "A gate you haven't watched fail isn't a gate." Each test builds a PERFECT model output by
 * copying the ONE real new-format ground-truth file (11-ambiguous-attic — the worked example; see
 * ANNOTATOR_GUIDE.md) via `buildPerfectModel`, asserts the relevant metric is green, then MUTATES
 * one leaf and asserts the metric goes red — printing the before/after numbers.
 *
 * Only one real fixture exists because only one transcript has been re-annotated so far (deliberate
 * — see the report); several gates below (band boundary, a second axis pair) therefore build a
 * SYNTHETIC ground-truth object instead of reading a file, using `emptyGroundTruth()` (every leaf
 * "unmentioned", derived from schema-leaves.mjs's LEAF_PATHS) plus targeted overrides. This is not
 * a lesser test: a scorer unit test should not need a real annotated transcript at all, and
 * decoupling scorer coverage from annotation progress is a feature — the 26-way fan-out does not
 * block finishing this suite, and this suite does not need to wait on it.
 *
 * Exit non-zero if any assertion fails.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LEAF_PATHS,
  LEAVES,
  ENUM_VOCAB,
  resolveEnumMember,
  slugifyMember,
} from "./schema-leaves.mjs";
import { isNewFormat, validateGroundTruth } from "./ground-truth.mjs";
import {
  scoreTranscript,
  buildPerfectModel,
  aggregate,
  spanIsVerbatim,
  classifySpan,
} from "./score.mjs";

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

function heading(title) {
  console.log("");
  console.log("=".repeat(82));
  console.log(title);
  console.log("=".repeat(82));
}

function loadWorkedExample() {
  const gt = JSON.parse(readFileSync(join(GT_DIR, "11-ambiguous-attic.json"), "utf8"));
  const transcript = readFileSync(join(TRANSCRIPT_DIR, "11-ambiguous-attic.txt"), "utf8");
  return { gt, transcript };
}

/** Score the worked example with a model produced by mutating the perfect copy. */
function run(mutate) {
  const { gt, transcript } = loadWorkedExample();
  const model = buildPerfectModel(gt);
  if (mutate) mutate(model, gt);
  return scoreTranscript("11-ambiguous-attic", gt, transcript, model);
}

/** A synthetic, fully "unmentioned" ground truth over all 51 real leaves — no file, no transcript
 * dependency. `overrides` is `{ [path]: partialLeafTruth }`, merged onto the "unmentioned" default. */
function emptyGroundTruth(overrides = {}) {
  const leaves = {};
  for (const path of LEAF_PATHS) leaves[path] = { status: "unmentioned", sourceSpan: null };
  for (const [path, partial] of Object.entries(overrides)) leaves[path] = partial;
  return { transcript: "synthetic", leaves };
}

// ---------------------------------------------------------------------------
// 0. SCHEMA INTROSPECTION — the numbers this whole rewrite rests on.
// ---------------------------------------------------------------------------
heading("0. SCHEMA INTROSPECTION (schema-leaves.mjs) — derived, not hand-counted");
{
  const enumLeaves = LEAVES.filter((l) => l.kind === "enum");
  const totalMembers = enumLeaves.reduce((a, l) => a + l.options.length, 0);
  console.log(
    `   ${LEAVES.length} leaves, ${enumLeaves.length} enum leaves, ${totalMembers} enum members total`,
  );
  check("51 leaves across the 7 resource groups", LEAVES.length === 51);
  check("233 total enum members across all enum leaves", totalMembers === 233);
  check(
    "ENUM_VOCAB has an entry for every enum leaf (no collisions at import time)",
    ENUM_VOCAB.size === enumLeaves.length,
  );
  check(
    'slugifyMember keeps decimal-point members apart (1" vs 1.5")',
    slugifyMember('Duct Board 1"') !== slugifyMember('Duct Board 1.5"'),
  );
  check(
    "slugifyMember drops the leading 'N% - ' qualifier",
    slugifyMember("6% - Well sealed") === "well_sealed",
  );
}

heading("0b. RESOLVER (resolveEnumMember) — either vocabulary, same leaf");
{
  const api = resolveEnumMember("hvac.hvacDuctLeakage", "6% - Well sealed");
  const slug = resolveEnumMember("hvac.hvacDuctLeakage", "well_sealed");
  const bad = resolveEnumMember("hvac.hvacDuctLeakage", "not-a-real-member");
  const wrongLeaf = resolveEnumMember("this.path.does.not.exist", "well_sealed");
  check(
    "API-literal input resolves to the API member",
    api.member === "6% - Well sealed" && api.vocabulary === "api",
  );
  check(
    "slug input resolves to the SAME API member",
    slug.member === "6% - Well sealed" && slug.vocabulary === "slug",
  );
  check("a string matching neither vocabulary resolves to null", bad.member === null);
  check("an unknown leaf path resolves to null rather than throwing", wrongLeaf.member === null);
}

// ---------------------------------------------------------------------------
// 1. GROUND-TRUTH VALIDATOR
// ---------------------------------------------------------------------------
heading("1. GROUND-TRUTH VALIDATOR (ground-truth.mjs)");
{
  const { gt } = loadWorkedExample();
  check("the worked example is detected as new format", isNewFormat(gt));
  const { ok, errors } = validateGroundTruth(gt);
  console.log(`   worked example: ok=${ok} errors=${errors.length}`);
  check("the worked example validates clean", ok && errors.length === 0);

  const oldFormat = JSON.parse(readFileSync(join(GT_DIR, "01-attic-r-value-shell.json"), "utf8"));
  check(
    "an old-format file (no `leaves` key) is NOT detected as new format",
    !isNewFormat(oldFormat),
  );

  // Mutate a clone of the worked example to break specific rules, one at a time.
  const clone = () => JSON.parse(JSON.stringify(gt));

  {
    const bad = clone();
    delete bad.leaves["hvac.hvacSystemEquipmentType"];
    const res = validateGroundTruth(bad);
    check(
      "a missing leaf key is caught",
      !res.ok && res.errors.some((e) => e.includes("hvac.hvacSystemEquipmentType")),
    );
  }
  {
    const bad = clone();
    bad.leaves["hvac.hvacHeatingEnergySource"].member = "Some Fuel Nobody Publishes";
    const res = validateGroundTruth(bad);
    check(
      "a member not in schema.ts's list is caught",
      !res.ok && res.errors.some((e) => e.includes("Some Fuel Nobody Publishes")),
    );
  }
  {
    const bad = clone();
    bad.leaves["basedata.yearBuilt"] = {
      status: "asserted",
      sourceSpan: "x",
      value: "not a number",
    };
    const res = validateGroundTruth(bad);
    check(
      "a non-numeric value on a number leaf is caught",
      !res.ok && res.errors.some((e) => e.includes("basedata.yearBuilt")),
    );
  }
  {
    const bad = clone();
    bad.leaves["hvac.hvacUpgradeAction"] = { status: "unmentioned", sourceSpan: "should be null" };
    const res = validateGroundTruth(bad);
    check(
      "a non-null sourceSpan on an unmentioned leaf is caught",
      !res.ok && res.errors.some((e) => e.includes("hvac.hvacUpgradeAction")),
    );
  }
  {
    const bad = clone();
    bad.leaves["hvac.hvacUpgradeAction"] = { status: "asserted", sourceSpan: "x" }; // neither member nor noFittingMember
    const res = validateGroundTruth(bad);
    check("asserted enum leaf missing both member and noFittingMember is caught", !res.ok);
  }
}

// ---------------------------------------------------------------------------
// 2. PERFECT MATCH — a copy of the worked example must score 100% clean.
// ---------------------------------------------------------------------------
heading("2. PERFECT-MATCH FIXTURE — copy of the worked example must be clean");
{
  const r = run();
  const c = r.counts;
  const clean =
    c.hallucinationHard === 0 &&
    c.hallucinationSoft === 0 &&
    c.rvalueConversion === 0 &&
    c.miss === 0 &&
    c.wrong === 0 &&
    c.unscorable === 0 &&
    c.spanFabricated === 0 &&
    c.spanMissing === 0 &&
    c.spanVerbatim === c.spanChecked &&
    c.hHallucinatedPass === 0 &&
    c.hHallucinatedProblem === 0 &&
    c.hCleanDropped === 0 &&
    c.hMiss === 0 &&
    c.hWrongState === 0 &&
    c.hSilentNotTested === 0 &&
    r.conformance.missingGroups.length === 0 &&
    r.conformance.extraGroups.length === 0 &&
    r.conformance.missingLeaves.length === 0 &&
    r.conformance.extraLeaves.length === 0 &&
    r.conformance.envelopeErrors.length === 0;
  console.log(
    `   halluc=${c.hallucinationHard} miss=${c.miss} wrong=${c.wrong} unscorable=${c.unscorable} ` +
      `spanVerbatim=${c.spanVerbatim}/${c.spanChecked} hPass=${c.hHallucinatedPass}`,
  );
  check("11-ambiguous-attic scores 100% clean from its own ground truth", clean);
}

// ---------------------------------------------------------------------------
// 3. HALLUCINATION gate
// ---------------------------------------------------------------------------
heading("3. HALLUCINATION gate");
{
  const before = run();
  const after = run((m) => {
    m.wall.wallsInsulated = {
      value: "Well",
      confidence: 0.9,
      sourceSpan: "fiberglass batts between the joists",
    };
  });
  console.log(
    `   before hallucinationHard=${before.counts.hallucinationHard}   after=${after.counts.hallucinationHard}`,
  );
  check(
    "asserting wallsInsulated (never discussed) flips hallucinationHard 0 -> 1",
    before.counts.hallucinationHard === 0 && after.counts.hallucinationHard === 1,
  );
  check(
    "the fabricated field is listed",
    after.hallucinations.some((h) => h.field === "wall.wallsInsulated"),
  );
}

// ---------------------------------------------------------------------------
// 4. FABRICATED SPAN gate
// ---------------------------------------------------------------------------
heading("4. FABRICATED-SPAN gate");
{
  const before = run();
  const after = run((m) => {
    m.hvac.hvacHeatingEnergySource.sourceSpan = "the plate clearly said Frobozz Magic Gas Corp";
  });
  console.log(
    `   before spanFabricated=${before.counts.spanFabricated}   after=${after.counts.spanFabricated}`,
  );
  check(
    "a fabricated span flips spanFabricated 0 -> 1",
    before.counts.spanFabricated === 0 && after.counts.spanFabricated === 1,
  );
  check(
    "verbatim count drops by exactly one",
    after.counts.spanVerbatim === before.counts.spanVerbatim - 1,
  );
  check(
    "spanIsVerbatim/classifySpan agree it is fabricated",
    !spanIsVerbatim("Frobozz Magic Gas Corp", "no such text") &&
      classifySpan("Frobozz Magic Gas Corp", "no such text").status === "fabricated",
  );
}

// ---------------------------------------------------------------------------
// 5. EITHER-VOCABULARY gate — the whole point of this format.
// ---------------------------------------------------------------------------
heading(
  "5. EITHER-VOCABULARY gate — api and slug score identically when correct, differently when wrong",
);
{
  const apiRun = run(); // ground truth already stores the API literal; buildPerfectModel copies it verbatim
  const slugRun = run((m) => {
    m.hvac.hvacHeatingEnergySource.value = "natural_gas"; // the derived slug, not the API string
  });
  const wrongVocabRun = run((m) => {
    m.hvac.hvacHeatingEnergySource.value = "fuel_oil"; // wrong value, spelled in slug vocabulary
  });
  console.log(
    `   api: correct=${apiRun.counts.correct} vocabApi=${apiRun.counts.vocabApi} vocabSlug=${apiRun.counts.vocabSlug}`,
  );
  console.log(
    `   slug: correct=${slugRun.counts.correct} vocabApi=${slugRun.counts.vocabApi} vocabSlug=${slugRun.counts.vocabSlug}`,
  );
  console.log(`   wrong-in-slug: wrong=${wrongVocabRun.counts.wrong}`);
  check(
    "the API-literal run counts as correct via the api vocabulary",
    apiRun.counts.correct === 4 && apiRun.counts.vocabApi >= 1,
  );
  check(
    "the slug run counts as EQUALLY correct via the slug vocabulary",
    slugRun.counts.correct === apiRun.counts.correct && slugRun.counts.vocabSlug === 1,
  );
  check(
    "a genuinely wrong value spelled in slug form is still wrong, not merely unresolved",
    wrongVocabRun.counts.wrong === 1,
  );
}

// ---------------------------------------------------------------------------
// 6. R-VALUE -> BAND INVENTION gate
// ---------------------------------------------------------------------------
heading("6. R-VALUE -> BAND INVENTION gate");
{
  const before = run();
  const after = run((m) => {
    m.attic.atticInsulationDepth = {
      value: "10-12",
      confidence: 0.9,
      sourceSpan: "R-13, final answer.",
    };
  });
  console.log(
    `   before rvalueConversion=${before.counts.rvalueConversion}   after=${after.counts.rvalueConversion}`,
  );
  check(
    "converting the spoken R-13 into a depth band flips rvalueConversion 0 -> 1",
    before.counts.rvalueConversion === 0 && after.counts.rvalueConversion === 1,
  );
  check(
    "it is ALSO counted as a hard hallucination (the depth leaf's GT is null)",
    after.counts.hallucinationHard === 1,
  );
}

// ---------------------------------------------------------------------------
// 7. HALLUCINATED HEALTH PASS vs SILENT NOT-TESTED gate
// ---------------------------------------------------------------------------
heading("7a. HALLUCINATED-HEALTH-PASS gate");
{
  const before = run();
  const after = run((m) => {
    m.health.healthAsbestos = {
      value: "Passed",
      confidence: 0.9,
      sourceSpan: "fiberglass batts between the joists",
    };
  });
  console.log(
    `   before hHallucinatedPass=${before.counts.hHallucinatedPass}   after=${after.counts.hHallucinatedPass}`,
  );
  check(
    "silence -> Passed flips hHallucinatedPass 0 -> 1",
    before.counts.hHallucinatedPass === 0 && after.counts.hHallucinatedPass === 1,
  );
  check(
    "it is listed as a health deviation",
    after.health.some(
      (h) => h.test === "health.healthAsbestos" && h.category === "hallucinatedPass",
    ),
  );
}
heading("7b. SILENT -> 'Not Tested' is a SOFT overreach, not a hard hallucination");
{
  const after = run((m) => {
    m.health.healthRadon = {
      value: "Not Tested",
      confidence: 0.9,
      sourceSpan: "No tests, no blower door, no water heater, none of that stuff",
    };
  });
  console.log(
    `   hSilentNotTested=${after.counts.hSilentNotTested}   hHallucinatedProblem=${after.counts.hHallucinatedProblem}`,
  );
  check(
    "asserting 'Not Tested' on a never-discussed test is soft, NOT hallucinatedProblem",
    after.counts.hSilentNotTested === 1 && after.counts.hHallucinatedProblem === 0,
  );
}
heading("7c. CONTRAST — 'Failed' on the same silent test IS a hard hallucinatedProblem");
{
  const after = run((m) => {
    m.health.healthRadon = {
      value: "Failed",
      confidence: 0.9,
      sourceSpan: "No tests, no blower door, no water heater, none of that stuff",
    };
  });
  console.log(
    `   hHallucinatedProblem=${after.counts.hHallucinatedProblem}   hSilentNotTested=${after.counts.hSilentNotTested}`,
  );
  check(
    "inventing a Failed result is a hard hallucinatedProblem",
    after.counts.hHallucinatedProblem === 1 && after.counts.hSilentNotTested === 0,
  );
}

// ---------------------------------------------------------------------------
// 8. SANCTIONED SOFT ALTERNATIVE gate (arguable.acceptableAlternatives)
// ---------------------------------------------------------------------------
heading(
  "8. SANCTIONED ALTERNATIVE gate — the worked example's own arguable.acceptableAlternatives",
);
{
  const before = run();
  const after = run((m) => {
    m.hvac.hvacSystemEquipmentType.value = "Furnace / Central AC (shared ducts)"; // sanctioned alternative
  });
  const hardWrong = run((m) => {
    m.hvac.hvacSystemEquipmentType.value = "Boiler"; // NOT sanctioned — also the retracted value
  });
  console.log(
    `   sanctioned: wrong=${after.counts.wrong} hallucinationSoft=${after.counts.hallucinationSoft}`,
  );
  console.log(`   unsanctioned: wrong=${hardWrong.counts.wrong}`);
  check("before is clean", before.counts.wrong === 0 && before.counts.hallucinationSoft === 0);
  check(
    "the sanctioned alternative is NOT counted as wrong, and IS counted as a soft call",
    after.counts.wrong === 0 && after.counts.hallucinationSoft === 1,
  );
  check(
    "an unsanctioned wrong member on the SAME leaf is still hard-wrong",
    hardWrong.counts.wrong === 1 && hardWrong.counts.hallucinationSoft === 0,
  );
  check(
    "the unsanctioned wrong value is tagged 'retracted' (it matches the leaf's own retracted table)",
    hardWrong.wrong[0]?.tag === "retracted",
  );
}

// ---------------------------------------------------------------------------
// 9. MISS gate + acceptableMiss EXCUSED gate
// ---------------------------------------------------------------------------
heading("9a. MISS gate");
{
  const before = run();
  const after = run((m) => {
    m.hvac.hvacHeatingEnergySource.value = null;
    m.hvac.hvacHeatingEnergySource.sourceSpan = null;
  });
  console.log(`   before miss=${before.counts.miss}   after=${after.counts.miss}`);
  check(
    "nulling a stated value flips miss 0 -> 1",
    before.counts.miss === 0 && after.counts.miss === 1,
  );
}
heading(
  "9b. ACCEPTABLE-MISS gate — the worked example's healthAmbientCarbonMonoxide is arguable.acceptableMiss",
);
{
  const after = run((m) => {
    m.health.healthAmbientCarbonMonoxide.value = null;
    m.health.healthAmbientCarbonMonoxide.sourceSpan = null;
  });
  console.log(`   hMiss=${after.counts.hMiss} hMissExcused=${after.counts.hMissExcused}`);
  check(
    "leaving the CO test null is an EXCUSED miss, not a penalized one — the annotator flagged it as acceptableMiss",
    after.counts.hMiss === 0 && after.counts.hMissExcused === 1,
  );
}

// ---------------------------------------------------------------------------
// 10. AXIS-SPLIT gate
// ---------------------------------------------------------------------------
heading("10. AXIS-SPLIT gate — fuel dropped where stated");
{
  const before = run();
  const after = run((m) => {
    m.hvac.hvacHeatingEnergySource.value = null;
    m.hvac.hvacHeatingEnergySource.sourceSpan = null;
  });
  const beforeHvac = before.axis.find((a) => a.pair.startsWith("hvac"));
  const afterHvac = after.axis.find((a) => a.pair.startsWith("hvac"));
  console.log(`   before axis=${beforeHvac.category}   after axis=${afterHvac.category}`);
  check(
    "a clean run splits equipment+fuel onto both axes (bothCorrect)",
    beforeHvac.category === "bothCorrect",
  );
  check(
    "dropping the fuel value flips the hvac axis pair -> fuelDropped",
    afterHvac.category === "fuelDropped",
  );
  check(
    "the dhw axis pair is null (no water heater was stated, so nothing to split)",
    before.axis.find((a) => a?.pair?.startsWith("dhw")) === undefined ||
      before.axis.every((a) => a === null || a.pair.startsWith("hvac")),
  );
}

// ---------------------------------------------------------------------------
// 11. BAND BOUNDARY vs FLAT WRONG — synthetic fixture (the worked example has
//     no asserted band; a band leaf needs a value to be off by one FROM).
// ---------------------------------------------------------------------------
heading("11. BAND-BOUNDARY gate (synthetic: dhw.dhwAge)");
{
  const gt = emptyGroundTruth({
    "dhw.dhwAge": { status: "asserted", sourceSpan: "about twelve years", member: "11-15" },
  });
  const transcript = "about twelve years";
  const perfect = buildPerfectModel(gt);
  const boundary = buildPerfectModel(gt);
  boundary.dhw.dhwAge.value = "16-20"; // adjacent band
  const farWrong = buildPerfectModel(gt);
  farWrong.dhw.dhwAge.value = "36+"; // far band

  const rPerfect = scoreTranscript("synthetic", gt, transcript, perfect);
  const rBoundary = scoreTranscript("synthetic", gt, transcript, boundary);
  const rFarWrong = scoreTranscript("synthetic", gt, transcript, farWrong);
  console.log(
    `   perfect  bandCorrect=${rPerfect.counts.bandCorrect} boundary=${rPerfect.counts.bandBoundary} wrong=${rPerfect.counts.bandWrong}`,
  );
  console.log(
    `   +1 band  bandCorrect=${rBoundary.counts.bandCorrect} boundary=${rBoundary.counts.bandBoundary} wrong=${rBoundary.counts.bandWrong}`,
  );
  console.log(
    `   far      bandCorrect=${rFarWrong.counts.bandCorrect} boundary=${rFarWrong.counts.bandBoundary} wrong=${rFarWrong.counts.bandWrong}`,
  );
  check("the exact band is correct", rPerfect.counts.bandCorrect === 1);
  check(
    "an adjacent band is a BOUNDARY error, not flat-wrong",
    rBoundary.counts.bandBoundary === 1 && rBoundary.counts.bandWrong === 0,
  );
  check(
    "a far band is flat-wrong, not a boundary error",
    rFarWrong.counts.bandWrong === 1 && rFarWrong.counts.bandBoundary === 0,
  );
}

// ---------------------------------------------------------------------------
// 12. NO-FITTING-MEMBER gate — synthetic (the worked example has none).
// ---------------------------------------------------------------------------
heading("12. NO-FITTING-MEMBER gate (synthetic: hvac.hvacSystemEquipmentType)");
{
  const gt = emptyGroundTruth({
    "hvac.hvacSystemEquipmentType": {
      status: "asserted",
      sourceSpan: "a pellet stove insert",
      noFittingMember: {
        auditorMeaning:
          "a pellet-burning insert; closest is Stove or Insert but that is a real member, so this leaf should actually use member instead — kept here only to exercise the code path",
      },
      arguable: { acceptableAlternatives: ["Stove or Insert"], note: "closest real member" },
    },
  });
  const transcript = "a pellet stove insert";
  const modelSanctioned = buildPerfectModel(gt);
  modelSanctioned.hvac.hvacSystemEquipmentType.value = "Stove or Insert";
  const modelOther = buildPerfectModel(gt);
  modelOther.hvac.hvacSystemEquipmentType.value = "Boiler";

  const rSanctioned = scoreTranscript("synthetic", gt, transcript, modelSanctioned);
  const rOther = scoreTranscript("synthetic", gt, transcript, modelOther);
  console.log(`   sanctioned-alt: unscorable=${rSanctioned.counts.unscorable}`);
  console.log(`   off-list: wrong=${rOther.counts.wrong} unscorable=${rOther.counts.unscorable}`);
  check(
    "a sanctioned alternative on a no-fitting-member leaf is NOT reported as unscorable",
    rSanctioned.counts.unscorable === 0,
  );
  check(
    "a real member NOT on the sanctioned list is 'unscorable' (no correct answer to grade against), not silently wrong",
    rOther.counts.unscorable === 1 && rOther.counts.wrong === 0,
  );
}

// ---------------------------------------------------------------------------
// 13. ROBUSTNESS — missing file, missing leaf key, extra key, malformed envelope.
// ---------------------------------------------------------------------------
heading("13. ROBUSTNESS");
{
  const { gt, transcript } = loadWorkedExample();
  const miss = scoreTranscript("11-ambiguous-attic", gt, transcript, null, "result file absent");
  console.log(`   missing file: status=${miss.status} gtNonNull=${miss.counts.gtNonNull}`);
  check("a missing result is status=unscored, not a crash", miss.status === "unscored");
  check("its GT-side denominators survive (whole-transcript miss)", miss.counts.gtNonNull > 0);

  const missingKey = run((m) => {
    delete m.hvac.hvacHeatingEnergySource; // GT non-null
  });
  console.log(
    `   missing leaf: missingLeaves=[${missingKey.conformance.missingLeaves}] miss=${missingKey.counts.miss}`,
  );
  check(
    "a missing leaf key is reported and treated as null (a miss)",
    missingKey.conformance.missingLeaves.includes("hvac.hvacHeatingEnergySource") &&
      missingKey.counts.miss === 1,
  );

  const missingGroup = run((m) => {
    delete m.hvac;
  });
  check("a missing GROUP is reported", missingGroup.conformance.missingGroups.includes("hvac"));

  const extraKey = run((m) => {
    m.hvac.someBogusField = { value: 1, confidence: 1, sourceSpan: null };
  });
  console.log(`   extra leaf: extraLeaves=[${extraKey.conformance.extraLeaves}]`);
  check(
    "an extra leaf key is reported without crashing",
    extraKey.conformance.extraLeaves.includes("hvac.someBogusField"),
  );

  const malformed = run((m) => {
    m.hvac.hvacHeatingEnergySource = "Natural Gas"; // a bare string, not an envelope
  });
  console.log(
    `   malformed envelope: envelopeErrors=${malformed.conformance.envelopeErrors.length}`,
  );
  check(
    "a non-object envelope is reported, not thrown",
    malformed.conformance.envelopeErrors.some((e) => e.startsWith("hvac.hvacHeatingEnergySource")),
  );
}

// ---------------------------------------------------------------------------
// 14. AGGREGATE roll-up
// ---------------------------------------------------------------------------
heading("14. AGGREGATE roll-up");
{
  const reports = [run(), run()];
  const agg = aggregate(reports);
  console.log(
    `   aggregate over 2 perfect fixtures: hallucinationHard=${agg.totals.hallucinationHard} miss=${agg.totals.miss} hPass=${agg.totals.hHallucinatedPass}`,
  );
  check(
    "aggregate of perfect fixtures is all-clean",
    agg.totals.hallucinationHard === 0 &&
      agg.totals.miss === 0 &&
      agg.totals.hHallucinatedPass === 0,
  );
  check(
    "aggregate doubles the single-fixture correct count",
    agg.totals.correct === 2 * run().counts.correct,
  );
}

// ---------------------------------------------------------------------------
console.log("");
console.log("=".repeat(82));
console.log(`RESULT: ${passes} passed, ${failures} failed`);
console.log("=".repeat(82));
process.exit(failures ? 1 : 0);
