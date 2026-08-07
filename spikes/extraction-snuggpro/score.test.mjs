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
import { isNewFormat, validateGroundTruth, SCHEMA_VERSION } from "./ground-truth.mjs";
import { NAMED_SETS, topicScopeMismatchWarning } from "./disclaimer-policy.mjs";
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

heading(
  "0c. RESOLVER exact-match — a near-miss of the API string is UNRECOGNIZED, not mislabelled 'slug'",
);
{
  // fix-round-2: resolveEnumMember used to slugify the raw value and compare it to the slug SET
  // before giving up — which meant a mis-cased/re-punctuated near-miss of the API string (not the
  // deliberately generated token) slugified to a real slug and was reported as "slug" regardless of
  // whether the run actually emitted that token. Attribution is now exact-match only, in both
  // directions: the raw value must equal the literal API string or one of the PRECOMPUTED slugs
  // character-for-character.
  const nearMissCasing = resolveEnumMember("hvac.hvacDuctLeakage", "well sealed"); // API string, wrong case, dropped "6% -"
  const nearMissPunctuation = resolveEnumMember("hvac.hvacDuctInsulation", 'duct board 1.5"'); // API string, wrong case
  const exactSlug = resolveEnumMember("hvac.hvacDuctLeakage", "well_sealed");
  console.log(
    `   near-miss casing: member=${nearMissCasing.member} vocab=${nearMissCasing.vocabulary}`,
  );
  check(
    "a lowercased, qualifier-dropped near-miss of the API string resolves to UNRECOGNIZED, not 'slug'",
    nearMissCasing.member === null && nearMissCasing.vocabulary === null,
  );
  check(
    "a mis-cased near-miss with the API's own punctuation intact ALSO resolves to unrecognized",
    nearMissPunctuation.member === null,
  );
  check(
    "the ACTUAL precomputed slug still resolves correctly",
    exactSlug.member === "6% - Well sealed" && exactSlug.vocabulary === "slug",
  );
}

heading("0d. NAMED_SETS self-check (MINOR 10) — every entry must be a subset of LEAF_PATHS");
{
  // disclaimer-policy.mjs asserts this at import time (a typo throws immediately, for every real
  // entry, since this module is the single place that re-scores every transcript using a given named
  // set — see its own comment). That means the REAL NAMED_SETS can never be caught failing this check
  // by a runtime assertion here (if it had a bad path, this file would already have failed to import).
  // What we CAN and must test is the check formula itself: feed it a deliberately-corrupted copy and
  // confirm the formula says "no" — proving the load-time assertion would have caught a real typo,
  // without needing to corrupt the actual module (which would break every other test in this file).
  const isSubsetOfLeafPaths = (paths) => paths.every((p) => LEAF_PATHS.includes(p));
  check(
    "every REAL NAMED_SETS entry passes the subset check",
    Object.values(NAMED_SETS).every(isSubsetOfLeafPaths),
  );
  const corruptedBlowerDoor = [...NAMED_SETS.blowerDoor, "basedata.blowerdoorReading"]; // typo'd case
  check(
    "the check formula correctly REJECTS a typo'd path that isn't a real leaf",
    !isSubsetOfLeafPaths(corruptedBlowerDoor),
  );
}

// ---------------------------------------------------------------------------
// 1b. DISCLAIMER VALIDATION — schemaVersion, malformed shapes, topic/scope
//     plausibility warnings, and "unresolved" reconciliation (fix-round-2).
// ---------------------------------------------------------------------------
heading("1b. DISCLAIMER / SCHEMA-SHAPE VALIDATION (fix-round-2)");
{
  const { gt, transcript } = loadWorkedExample();
  const clone = () => JSON.parse(JSON.stringify(gt));

  {
    const bad = clone();
    bad.schemaVersion = "snuggpro-51-leaf-v1"; // stale/wrong version
    const res = validateGroundTruth(bad, transcript);
    check(
      "a wrong schemaVersion is caught (IMPORTANT 7)",
      !res.ok && res.errors.some((e) => e.includes("schemaVersion")),
    );
    check(
      "the real worked example's schemaVersion matches the current format",
      gt.schemaVersion === SCHEMA_VERSION,
    );
  }
  {
    const bad = clone();
    bad.leaves = []; // an array, not an object
    const res = validateGroundTruth(bad, transcript);
    check(
      'leaves: [] (an array) is rejected, not silently treated as "no leaves" (IMPORTANT 7)',
      !res.ok && res.errors.some((e) => e.includes("leaves")),
    );
  }
  {
    const bad = clone();
    bad.leaves["hvac.hvacHeatingEnergySource"].value = "Natural Gas"; // enum leaf carrying a stray `value`
    const res = validateGroundTruth(bad, transcript);
    check(
      "an enum leaf carrying a stray `value` is caught (IMPORTANT 7)",
      !res.ok &&
        res.errors.some(
          (e) => e.includes("hvac.hvacHeatingEnergySource") && e.includes("must not carry"),
        ),
    );
  }
  {
    const bad = clone();
    bad.leaves["attic.atticInsulation"].member = "Fiberglass or Rockwool (batts or blown)"; // number leaf carrying a stray `member`
    const res = validateGroundTruth(bad, transcript);
    check(
      "a number leaf carrying a stray `member` is caught (IMPORTANT 7)",
      !res.ok &&
        res.errors.some((e) => e.includes("attic.atticInsulation") && e.includes("must not carry")),
    );
  }
  {
    const bad = clone();
    bad.leaves["attic.atticInsulation"].retracted = [{ value: { nested: "object" }, note: "x" }];
    const res = validateGroundTruth(bad, transcript);
    check(
      "an object-valued retracted.value is caught, not silently accepted (IMPORTANT 7)",
      !res.ok && res.errors.some((e) => e.includes("retracted[0].value")),
    );
  }
  {
    const bad = clone();
    bad.leaves["attic.atticInsulation"].arguable = "oops"; // a primitive where an object is required
    let threw = false;
    let res;
    try {
      res = validateGroundTruth(bad, transcript);
    } catch {
      threw = true;
    }
    check(
      "arguable as a bare primitive does NOT throw — it becomes a reported error (IMPORTANT 7)",
      !threw && res && !res.ok && res.errors.some((e) => e.includes("arguable must be an object")),
    );
  }
  {
    const bad = clone();
    bad.disclaimers.push({ span: "no water heater", topic: "x", scope: { kind: "unresolved" } }); // no note
    const res = validateGroundTruth(bad, transcript);
    check(
      "an 'unresolved' scope with no note is rejected (IMPORTANT 6)",
      !res.ok && res.errors.some((e) => e.includes("unresolved") && e.includes("note")),
    );
  }
  {
    const bad = clone();
    // overlaps nothing (dhw/blowerDoor/healthTests are all already claimed) — use "hvac" group, and
    // give it a real note so it's VALID, just still flagged for reconciliation.
    bad.disclaimers.push({
      span: "Definitely a furnace, scratch the boiler.",
      topic: "the furnace, deliberately marked unresolved for this test",
      scope: { kind: "unresolved" },
      note: "test fixture: exercising the always-warns behavior, not a real unresolved case",
    });
    const res = validateGroundTruth(bad, transcript);
    console.log(`   unresolved-with-note: ok=${res.ok} warnings=${res.warnings.length}`);
    check(
      "an 'unresolved' scope WITH a note is valid but ALWAYS produces a reconciliation warning (IMPORTANT 6)",
      res.ok && res.warnings.some((w) => w.includes("NEEDS RECONCILIATION")),
    );
  }
  {
    const bad = clone();
    bad.disclaimers[0].topic = "the attic insulation"; // dhw scope, attic-flavored topic — implausible pairing
    const res = validateGroundTruth(bad, transcript);
    console.log(`   topic/scope mismatch: ok=${res.ok} warnings=${JSON.stringify(res.warnings)}`);
    check(
      "an implausible topic/scope pairing WARNS but does not fail validation (IMPORTANT 5)",
      res.ok && res.warnings.some((w) => w.includes("does not obviously match")),
    );
  }
  {
    // topicScopeMismatchWarning unit-level: a plausible pairing warns nothing.
    check(
      "a plausible topic for its scope produces no warning",
      topicScopeMismatchWarning({ kind: "group", group: "dhw" }, "the water heater") === null,
    );
    check(
      "an implausible topic for its scope produces a warning",
      typeof topicScopeMismatchWarning({ kind: "group", group: "attic" }, "the water heater") ===
        "string",
    );
    check(
      "'unresolved' scope never warns on topic (there is no mechanical target to compare against)",
      topicScopeMismatchWarning({ kind: "unresolved" }, "anything at all") === null,
    );
  }
}

// ---------------------------------------------------------------------------
// 1c. SYMMETRIC TIE-BREAK is now MECHANICALLY enforced (final review item).
//
// Rule 6's determinism ("member must be the earliest, in schema.ts's own enum order, of the
// co-equally-fitting set") was previously prose only — an annotator ERROR (not discretion; the
// design removed the discretion on purpose) passed validation silently. The conflated-pair shape is
// schema-wide (hvacSystemEquipmentType's shared-ducts heat-pump and ground-source variants have the
// identical structure), and only 1 of 14 transcripts is annotated, so this needed to be closed
// before the fan-out, not caught in reconciliation after it. `arguable.symmetric: true` makes it
// checkable without a hand-listed table of which members conflate — the "set" is just
// `{member} ∪ acceptableAlternatives`, exactly what the annotator wrote on THIS leaf.
// ---------------------------------------------------------------------------
heading("1c. SYMMETRIC TIE-BREAK enforcement (arguable.symmetric) — the item this fix closes");
{
  const { gt, transcript } = loadWorkedExample();
  const clone = () => JSON.parse(JSON.stringify(gt));

  check(
    "the worked example's furnace leaf is marked symmetric: true",
    gt.leaves["hvac.hvacSystemEquipmentType"].arguable.symmetric === true,
  );

  {
    // THE mutation that fails without the check: swap which member sits in `member` vs
    // `acceptableAlternatives`, keeping `symmetric: true`. Before this fix, this validated clean —
    // an annotator who wrote the pair in the wrong order would never find out.
    const bad = clone();
    const leaf = bad.leaves["hvac.hvacSystemEquipmentType"];
    const original = leaf.member;
    leaf.member = leaf.arguable.acceptableAlternatives[0]; // "Furnace / Central AC (shared ducts)" — index 16
    leaf.arguable.acceptableAlternatives = [original]; // "Furnace with standalone ducts" — index 2, now demoted
    const res = validateGroundTruth(bad, transcript);
    console.log(`   swapped order: ok=${res.ok} errors=${JSON.stringify(res.errors)}`);
    check(
      "swapping which conflated member sits in `member` (now NOT the earliest) is REJECTED",
      !res.ok &&
        res.errors.some(
          (e) => e.includes("hvac.hvacSystemEquipmentType") && e.includes("NOT the earliest"),
        ),
    );
  }
  {
    // The correct order (the real worked example, unmodified) must still pass — the check does not
    // merely fire on any symmetric pair, only on the wrong order.
    const res = validateGroundTruth(clone(), transcript);
    check("the worked example's ACTUAL (correct) order still validates clean", res.ok);
  }
  {
    // symmetric: true requires an enum leaf with a real `member` — not noFittingMember, and not a
    // number/string leaf, since schema order has no meaning there.
    const bad = clone();
    bad.leaves["attic.atticInsulation"].arguable = {
      symmetric: true,
      note: "nonsensical: atticInsulation is a NUMBER leaf, not an enum",
    };
    const res = validateGroundTruth(bad, transcript);
    check(
      "arguable.symmetric on a NUMBER leaf is rejected (schema order has no meaning there)",
      !res.ok && res.errors.some((e) => e.includes("attic.atticInsulation")),
    );
  }
  {
    const bad = clone();
    bad.leaves["hvac.hvacSystemEquipmentType"].arguable.acceptableAlternatives = []; // nothing to be symmetric WITH
    const res = validateGroundTruth(bad, transcript);
    check(
      "arguable.symmetric with an empty acceptableAlternatives is rejected",
      !res.ok && res.errors.some((e) => e.includes("non-empty acceptableAlternatives")),
    );
  }
  {
    const bad = clone();
    bad.leaves["hvac.hvacSystemEquipmentType"].arguable.symmetric = "yes"; // not a boolean
    const res = validateGroundTruth(bad, transcript);
    check(
      "a non-boolean arguable.symmetric is rejected",
      !res.ok && res.errors.some((e) => e.includes("symmetric") && e.includes("boolean")),
    );
  }
  {
    // symmetric: false (or absent) must NEVER fire, even on an order that would fail if checked —
    // this is the guard against the check firing on the genuinely different, asymmetric "lesser but
    // tolerated alternative" pattern, where schema order carries no meaning at all.
    const bad = clone();
    const leaf = bad.leaves["hvac.hvacSystemEquipmentType"];
    const original = leaf.member;
    leaf.member = leaf.arguable.acceptableAlternatives[0];
    leaf.arguable.acceptableAlternatives = [original];
    leaf.arguable.symmetric = false; // explicitly NOT claiming symmetry
    const res = validateGroundTruth(bad, transcript);
    check(
      "the same 'wrong order' is NOT rejected when symmetric is false — it is a different (asymmetric) claim",
      res.ok,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. GROUND-TRUTH VALIDATOR
// ---------------------------------------------------------------------------
heading("1. GROUND-TRUTH VALIDATOR (ground-truth.mjs)");
{
  const { gt, transcript } = loadWorkedExample();
  check("the worked example is detected as new format", isNewFormat(gt));
  const { ok, errors } = validateGroundTruth(gt, transcript);
  console.log(`   worked example: ok=${ok} errors=${errors.length}`);
  check(
    "the worked example validates clean (leaves + disclaimers + resolved 51-leaf map, spans checked against the real transcript)",
    ok && errors.length === 0,
  );

  const oldFormat = JSON.parse(readFileSync(join(GT_DIR, "01-attic-r-value-shell.json"), "utf8"));
  check(
    "an old-format file (no `leaves` key) is NOT detected as new format",
    !isNewFormat(oldFormat),
  );

  // Mutate a clone of the worked example to break specific rules, one at a time.
  const clone = () => JSON.parse(JSON.stringify(gt));

  {
    // A leaf NOT covered by any disclaimer, removed from the explicit `leaves` map, is NOT an
    // error — it resolves to "unmentioned". This is the whole point of moving disclaimers out of
    // annotator judgment: the annotator only writes what they can address specifically.
    const sparse = clone();
    delete sparse.leaves["attic.atticInsulationType"]; // not covered by any of the 3 disclaimers
    const res = validateGroundTruth(sparse, transcript);
    check(
      "removing an explicit, disclaimer-uncovered leaf entry is VALID (defaults to unmentioned)",
      res.ok,
    );
  }
  {
    const bad = clone();
    bad.leaves["hvac.hvacHeatingEnergySource"].member = "Some Fuel Nobody Publishes";
    const res = validateGroundTruth(bad, transcript);
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
    const res = validateGroundTruth(bad, transcript);
    check(
      "a non-numeric value on a number leaf is caught",
      !res.ok && res.errors.some((e) => e.includes("basedata.yearBuilt")),
    );
  }
  {
    const bad = clone();
    bad.leaves["hvac.hvacUpgradeAction"] = { status: "unmentioned", sourceSpan: "should be null" };
    const res = validateGroundTruth(bad, transcript);
    check(
      "a non-null sourceSpan on an unmentioned leaf is caught",
      !res.ok && res.errors.some((e) => e.includes("hvac.hvacUpgradeAction")),
    );
  }
  {
    const bad = clone();
    bad.leaves["hvac.hvacUpgradeAction"] = { status: "asserted", sourceSpan: "x" }; // neither member nor noFittingMember
    const res = validateGroundTruth(bad, transcript);
    check("asserted enum leaf missing both member and noFittingMember is caught", !res.ok);
  }
  {
    const bad = clone();
    bad.leaves["basedata.yearBuilt"] = {
      status: "asserted",
      sourceSpan: "this text is not in the transcript at all",
      value: 1962,
    };
    const res = validateGroundTruth(bad, transcript);
    check(
      "a leaf sourceSpan that is not a verbatim substring of the transcript is caught",
      !res.ok && res.errors.some((e) => e.includes("basedata.yearBuilt") && e.includes("verbatim")),
    );
  }
  {
    const bad = clone();
    bad.disclaimers[0].span = "this text is also not in the transcript";
    const res = validateGroundTruth(bad, transcript);
    check(
      "a disclaimer span that is not a verbatim substring of the transcript is caught",
      !res.ok && res.errors.some((e) => e.includes("disclaimers[0]") && e.includes("verbatim")),
    );
  }
  {
    const bad = clone();
    bad.disclaimers.push({
      span: "no water heater",
      topic: "duplicate dhw disclaimer",
      scope: { kind: "group", group: "dhw" },
    });
    const res = validateGroundTruth(bad, transcript);
    check(
      "two disclaimers whose scopes overlap are caught",
      !res.ok && res.errors.some((e) => e.includes("overlapping")),
    );
  }
  {
    const bad = clone();
    bad.disclaimers.push({
      span: "no water heater",
      topic: "x",
      scope: { kind: "group", group: "not-a-real-group" },
    });
    const res = validateGroundTruth(bad, transcript);
    check(
      "an unrecognized disclaimer scope group is caught",
      !res.ok && res.errors.some((e) => e.includes("not-a-real-group")),
    );
  }
  {
    const bad = clone();
    bad.disclaimers.push({
      span: "no water heater",
      topic: "x",
      scope: { kind: "namedSet", set: "notARealSet" },
    });
    const res = validateGroundTruth(bad, transcript);
    check(
      "an unrecognized disclaimer named set is caught",
      !res.ok && res.errors.some((e) => e.includes("notARealSet")),
    );
  }
  {
    const bad = clone();
    bad.disclaimers.push({ span: "", topic: "x", scope: { kind: "unresolved" } });
    const res = validateGroundTruth(bad, transcript);
    check(
      "a disclaimer with no span is caught",
      !res.ok && res.errors.some((e) => e.includes("non-empty verbatim span")),
    );
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

heading(
  "4b. EMPTY-SPAN gate (IMPORTANT 8a) — grounds for nothing must not score as grounded in everything",
);
{
  // `"".includes("")` is trivially true for ANY transcript, so a model emitting `sourceSpan: ""`
  // used to sail through `spanIsVerbatim` as "verbatim" — the near-miss fallback in `classifySpan`
  // had the identical hazard on its own `.includes()` calls, so both needed the guard, not one.
  check(
    "spanIsVerbatim rejects an empty span outright, regardless of the transcript",
    spanIsVerbatim("", "literally any transcript text at all") === false,
  );
  check(
    "classifySpan reports an empty span as fabricated, never verbatim or near-miss",
    classifySpan("", "literally any transcript text at all").status === "fabricated",
  );
  const after = run((m) => {
    m.hvac.hvacHeatingEnergySource.sourceSpan = "";
  });
  console.log(
    `   empty span in a real run: spanFabricated=${after.counts.spanFabricated} spanVerbatim=${after.counts.spanVerbatim}`,
  );
  check(
    "a model emitting an empty sourceSpan is counted as fabricated, not verbatim, in a real scored run",
    after.counts.spanFabricated === 1,
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
  console.log(
    `   wrong-in-slug: wrong=${wrongVocabRun.counts.wrong} vocabApi=${wrongVocabRun.counts.vocabApi} vocabSlug=${wrongVocabRun.counts.vocabSlug}`,
  );
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
  // CRITICAL FIX (fix-round-2): vocabApi/vocabSlug were incremented whenever `compareValue` found
  // ANY real member for the raw value — correct or not — because that check ran before the
  // correctness check, not gated on it. A wrong-but-real slug-spelled value (GT "Natural Gas", model
  // "fuel_oil") therefore contributed to `vocabSlug` and the CLI printed it under "vocabulary mix on
  // CORRECT matches", which is exactly backwards for the one measurement this format exists to make.
  // Isolated on a SYNTHETIC single-leaf fixture (rather than the worked example, whose other ~15
  // correct leaves would swamp a delta-of-one signal) so the count is unambiguous: this leaf's wrong
  // answer must contribute to neither counter, full stop.
  const isolatedGt = emptyGroundTruth({
    "hvac.hvacHeatingEnergySource": {
      status: "asserted",
      sourceSpan: "it's a furnace, a gas furnace",
      member: "Natural Gas",
    },
  });
  const isolatedTranscript = "it's a furnace, a gas furnace";
  const isolatedModel = buildPerfectModel(isolatedGt);
  isolatedModel.hvac.hvacHeatingEnergySource.value = "fuel_oil"; // wrong, slug-spelled
  const isolated = scoreTranscript("synthetic", isolatedGt, isolatedTranscript, isolatedModel);
  console.log(
    `   isolated wrong-in-slug: wrong=${isolated.counts.wrong} vocabApi=${isolated.counts.vocabApi} vocabSlug=${isolated.counts.vocabSlug}`,
  );
  check(
    "on an isolated fixture, a WRONG value is excluded from BOTH vocabulary-mix counters",
    isolated.counts.wrong === 1 &&
      isolated.counts.vocabApi === 0 &&
      isolated.counts.vocabSlug === 0,
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
// 7a-7c use a SYNTHETIC ground truth with NO disclaimers, specifically so a health-test leaf is
// genuinely "unmentioned" (true silence) to mutate against. In the worked example itself, every one
// of the 13 health-test leaves is now either explicitly asserted (ambientCarbonMonoxide) or covered
// by the "No tests" disclaimer (asserted "Not Tested") — a direct, intended consequence of moving
// disclaimer scope out of annotator judgment: this corpus genuinely has no leftover silent health
// leaf once "No tests" is honored uniformly. That is not a gap in coverage; it is what "the disclaimer
// covers everything a blanket statement plausibly reaches" is supposed to produce.
heading("7a. HALLUCINATED-HEALTH-PASS gate (synthetic: a truly silent health test)");
{
  const gt = emptyGroundTruth();
  const transcript = "nothing about asbestos is ever said";
  const before = scoreTranscript("synthetic", gt, transcript, buildPerfectModel(gt));
  const afterModel = buildPerfectModel(gt);
  afterModel.health.healthAsbestos = { value: "Passed", confidence: 0.9, sourceSpan: transcript };
  const after = scoreTranscript("synthetic", gt, transcript, afterModel);
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
heading("7b. SILENT -> 'Not Tested' is a SOFT overreach, not a hard hallucination (synthetic)");
{
  const gt = emptyGroundTruth();
  const transcript = "nothing about radon is ever said";
  const model = buildPerfectModel(gt);
  model.health.healthRadon = { value: "Not Tested", confidence: 0.9, sourceSpan: transcript };
  const after = scoreTranscript("synthetic", gt, transcript, model);
  console.log(
    `   hSilentNotTested=${after.counts.hSilentNotTested}   hHallucinatedProblem=${after.counts.hHallucinatedProblem}`,
  );
  check(
    "asserting 'Not Tested' on a never-discussed test is soft, NOT hallucinatedProblem",
    after.counts.hSilentNotTested === 1 && after.counts.hHallucinatedProblem === 0,
  );
}
heading(
  "7c. CONTRAST — 'Failed' on the same silent test IS a hard hallucinatedProblem (synthetic)",
);
{
  const gt = emptyGroundTruth();
  const transcript = "nothing about radon is ever said";
  const model = buildPerfectModel(gt);
  model.health.healthRadon = { value: "Failed", confidence: 0.9, sourceSpan: transcript };
  const after = scoreTranscript("synthetic", gt, transcript, model);
  console.log(
    `   hHallucinatedProblem=${after.counts.hHallucinatedProblem}   hSilentNotTested=${after.counts.hSilentNotTested}`,
  );
  check(
    "inventing a Failed result is a hard hallucinatedProblem",
    after.counts.hHallucinatedProblem === 1 && after.counts.hSilentNotTested === 0,
  );
}

heading(
  "7d. hGtPassed denominator gate (IMPORTANT 8b) — must never be smaller than its own numerator",
);
{
  // A previous version incremented `hGtPassed` only inside the both-non-null branch, so a MISSED
  // "Passed" leaf (model emits null) bumped `hCleanDropped` (the numerator, in the miss branch)
  // without ever bumping `hGtPassed` (the denominator) — "N of GT-passed dropped" could report a
  // numerator larger than its own denominator. `hGtPassed` must now be counted once, unconditionally
  // on GT alone, before any branch on what the model emitted.
  const gt = emptyGroundTruth({
    "health.healthMoldMoisture": {
      status: "asserted",
      sourceSpan: "mold and moisture, clean, no issues",
      member: "Passed",
    },
  });
  const transcript = "mold and moisture, clean, no issues";
  const missedModel = buildPerfectModel(gt);
  missedModel.health.healthMoldMoisture.value = null;
  missedModel.health.healthMoldMoisture.sourceSpan = null;
  const missed = scoreTranscript("synthetic", gt, transcript, missedModel);
  console.log(
    `   missed a GT-Passed leaf: hCleanDropped=${missed.counts.hCleanDropped} hGtPassed=${missed.counts.hGtPassed}`,
  );
  check(
    "missing a GT-Passed leaf counts BOTH hCleanDropped (numerator) and hGtPassed (denominator) — " +
      "the denominator is never smaller than the numerator it's supposed to bound",
    missed.counts.hCleanDropped === 1 && missed.counts.hGtPassed === 1,
  );
  const correctModel = buildPerfectModel(gt);
  const correct = scoreTranscript("synthetic", gt, transcript, correctModel);
  check(
    "a correctly-kept GT-Passed leaf ALSO counts hGtPassed (so a mix of runs sums consistently)",
    correct.counts.hGtPassedCorrect === 1 && correct.counts.hGtPassed === 1,
  );
}

// ---------------------------------------------------------------------------
// 8. SANCTIONED (schema-forced choice) gate (arguable.acceptableAlternatives, GT non-null)
// ---------------------------------------------------------------------------
heading(
  "8. SANCTIONED gate — the worked example's own arguable.acceptableAlternatives, GT non-null",
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
    `   sanctioned: wrong=${after.counts.wrong} enumSanctioned=${after.counts.enumSanctioned} hallucinationSoft=${after.counts.hallucinationSoft}`,
  );
  console.log(`   unsanctioned: wrong=${hardWrong.counts.wrong}`);
  check(
    "before is clean",
    before.counts.wrong === 0 &&
      before.counts.enumSanctioned === 0 &&
      before.counts.hallucinationSoft === 0,
  );
  // fix-round-2 (IMPORTANT 9): this is GT NON-NULL — nothing was hallucinated, the schema forced an
  // arbitrary pick and the model landed on the other lobe of the SAME forced choice. It must land in
  // its OWN counter (`enumSanctioned`), never in `hallucinationSoft` (that bucket is reserved for a
  // GT-NULL leaf where a real, if tolerated, overreach happened) and must not be reported under the
  // HALLUCINATION section.
  check(
    "the sanctioned alternative is NOT counted as wrong, and IS counted in enumSanctioned (NOT hallucinationSoft)",
    after.counts.wrong === 0 &&
      after.counts.enumSanctioned === 1 &&
      after.counts.hallucinationSoft === 0,
  );
  check(
    "the sanctioned alternative does not ADD to vocabApi/vocabSlug (it is not a match against GT's own member) " +
      "— vocabApi drops by exactly the one true match this leaf itself no longer contributes",
    after.counts.vocabApi === before.counts.vocabApi - 1 &&
      after.counts.vocabSlug === before.counts.vocabSlug,
  );
  check(
    "an unsanctioned wrong member on the SAME leaf is still hard-wrong",
    hardWrong.counts.wrong === 1 &&
      hardWrong.counts.enumSanctioned === 0 &&
      hardWrong.counts.hallucinationSoft === 0,
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
  console.log(
    `   missing file: status=${miss.status} gtNonNull=${miss.counts.gtNonNull} miss=${miss.counts.miss} ` +
      `hMiss=${miss.counts.hMiss} hMissExcused=${miss.counts.hMissExcused} hallucinationHard=${miss.counts.hallucinationHard}`,
  );
  check("a missing result is status=unscored, not a crash", miss.status === "unscored");
  check("its GT-side denominators survive (whole-transcript miss)", miss.counts.gtNonNull > 0);
  // CRITICAL FIX (fix-round-2): a missing/malformed result must be scored EXACTLY as if the
  // extractor had emitted an empty object — every GT-non-null leaf becomes a counted miss (or an
  // excused miss where arguable.acceptableMiss says so), never a silent zero. Before this fix,
  // `scoreTranscript` returned immediately after computing the GT-side denominators, so a missing
  // result contributed miss=0/hMiss=0 no matter how many values GT actually asserted — meaning an
  // extractor that returns NOTHING scored strictly better than one that tried and got some answers
  // wrong. The worked example asserts 4 generic leaves (3 enum + 1 number, none excused) and 13
  // health leaves (12 via the "No tests" disclaimer + 1 explicit, 1 of the 13 excused by its own
  // arguable.acceptableMiss) — a missing result must show ALL of that as real misses.
  check(
    "a missing result counts every GT-asserted GENERIC leaf as a real miss, not a silent zero",
    miss.counts.miss === 4 && miss.counts.missExcused === 0 && miss.counts.enumMiss === 3,
  );
  check(
    "a missing result counts every GT-asserted HEALTH leaf as a real miss (minus its own excused one)",
    miss.counts.hMiss === 12 && miss.counts.hMissExcused === 1,
  );
  check(
    "a missing result hallucinates NOTHING (there is no output to invent from)",
    miss.counts.hallucinationHard === 0 && miss.counts.hallucinationSoft === 0,
  );
  check(
    "an extractor that TRIES and gets things wrong now scores WORSE than one returning nothing",
    (() => {
      const tried = run((m) => {
        m.hvac.hvacHeatingEnergySource.value = "Fuel Oil"; // wrong, on top of everything else correct
      });
      // "worse" = strictly more penalized signal than the missing-result case on the SAME leaf set:
      // the missing case has miss=4 and wrong=0; a run that emits a wrong answer for one leaf and
      // leaves everything else correct has miss=0 but wrong=1 — neither dominates the other in raw
      // counts, so what must hold is the property CRITICAL 1 is actually about: the missing case is
      // no longer a free pass (miss > 0), which the pre-fix behavior violated outright (miss === 0).
      return miss.counts.miss > 0 && tried.counts.wrong === 1;
    })(),
  );

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
