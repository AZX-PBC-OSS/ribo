#!/usr/bin/env node
/**
 * Scorer for the Snugg Pro extraction spike — rebuilt against the vocabulary-neutral ground-truth
 * format (`ground-truth-format.md`) and the REAL, spec-derived 51-leaf / 7-group schema
 * (`packages/ribo-adapter-snuggpro/src/schema.ts`), not the old spike's dead 23-field copy of it.
 *
 *   node spikes/extraction-snuggpro/score.mjs [resultsDir]   # default: results/codex
 *
 * Reads ground-truth/NN-slug.json + transcripts/NN-slug.txt + <resultsDir>/NN-slug.json and
 * reports, per transcript and aggregate, the same measures the spike has always reported —
 * hallucination, miss, axis-split, enum-mapping, band-mapping, health-matrix state, sourceSpan
 * validity, confidence separation — plus two new ones: the VOCABULARY MIX of a run's TRUE-correct
 * enum matches (API literal strings vs the derived snake_case alternative — never a wrong or merely
 * sanctioned one, see the fix-round-2 note below), which is the whole reason this format exists —
 * see ground-truth-format.md's rationale — and ENUM-SANCTIONED, a GT-non-null count for the case
 * where the schema itself forces an arbitrary pick between equally-fitting members and a run lands
 * on the other lobe (see "sanctioned" below); this is NOT a hallucination and is reported under
 * enum-mapping, not under the hallucination section.
 *
 * A ground-truth file with no "leaves" key is the OLD (pre-rebuild) format. All 14 corpus
 * transcripts have been re-annotated into the new format; the `isNewFormat` check remains as a
 * safety guard so a stale old-format file is reported as PENDING RE-ANNOTATION rather than
 * crashing the run.
 *
 * Robustness: a missing/unparseable/malformed result is scored EXACTLY as if the extractor had
 * emitted an empty object — every GT-non-null leaf becomes a real, counted miss (never a silent
 * zero denominator; see the fix-round-2 note below), and the run keeps going. Missing keys are
 * treated as null; extra keys are reported. Never crashes — including on a malformed ground-truth
 * file, whose validator is wrapped so a defect degrades one transcript's result, not the whole run.
 *
 * FIX-ROUND-2 (two independent reviews caught real defects; both fixes are load-bearing, not
 * cosmetic — see score.test.mjs's ROBUSTNESS and EITHER-VOCABULARY gates for the mutations proving
 * each):
 *   1. A missing/malformed result used to return immediately after computing GT-side denominators,
 *      so it contributed miss=0 regardless of how much GT actually asserted — an extractor
 *      returning NOTHING scored strictly better than one that tried and got some answers wrong.
 *      Fixed by scoring a null model as `{}` through the exact same per-leaf loop a real result
 *      uses, rather than special-casing it away.
 *   2. `vocabApi`/`vocabSlug` used to increment whenever `compareValue` found ANY real member for a
 *      raw value, before checking whether that member was actually GT's own — so a wrong-but-real
 *      slug-spelled value counted as a "CORRECT match" in the slug column. Fixed by gating strictly
 *      on `cmp.verdict === "correct"`.
 *
 * Node 24 built-ins only, plus the two sibling spike modules (schema-leaves.mjs, ground-truth.mjs)
 * — nothing here hand-lists a leaf path or an enum member; both come from introspecting the real,
 * built adapter schema. Two small tables ARE still hand-kept, and are called out where they live
 * (BAND_LEAVES, AXIS_PAIRS): "this enum's members form an ordered band" and "these two leaves are
 * one thing's two axes" are not visible in a zod enum's shape, so they cannot be derived — but they
 * are two short, named tables, not a 233-entry parallel enum list.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GROUPS,
  HEALTH_TEST_PATHS,
  LEAF_BY_PATH,
  LEAF_PATHS,
  resolveEnumMember,
} from "./schema-leaves.mjs";
import { isNewFormat, resolveGroundTruth, validateGroundTruth } from "./ground-truth.mjs";

export { HEALTH_TEST_PATHS };

// ---------------------------------------------------------------------------
// Domain knowledge NOT visible in a zod enum's shape, kept as two short,
// named, hand-written tables (not a parallel copy of the 233 members — see
// the file header). Everything else below is derived from LEAVES.
// ---------------------------------------------------------------------------

/** Leaves whose enum members form an ORDERED band, where an adjacent-member mismatch is a
 * boundary error rather than a flat wrong. "Don't Know" (present on the attic depth band) is not
 * part of the ordering and is excluded by `bandOrder` below, not by this list. */
const BAND_LEAVES = new Set(["attic.atticInsulationDepth", "dhw.dhwAge"]);

/** Equipment/fuel leaf pairs describing one real system's two independent axes (schema.ts's
 * HAZARD 1). Splitting these onto two fields is the extraction design's single highest-value rule. */
const AXIS_PAIRS = [
  { equipment: "hvac.hvacSystemEquipmentType", fuel: "hvac.hvacHeatingEnergySource" },
  { equipment: "dhw.dhwType2", fuel: "dhw.dhwFuel2" },
];

const HEALTH_TEST_SET = new Set(HEALTH_TEST_PATHS);

/**
 * Transcripts that must NOT be graded, and why.
 *
 * `02-oil-boiler-basement` is **byte-for-byte identical** to the few-shot example
 * transcript in `packages/ribo-adapter-snuggpro/src/examples.ts` — 1094 characters, the
 * same 1094. So the model is shown that transcript's exact answer in the prompt and then
 * scored on producing it. Grading it measures copying, and it silently inflated every
 * published figure that included it (docs/implementation/18).
 *
 * Excluded rather than deleted: the transcript is a perfectly good few-shot example and a
 * useful sanity check. It is simply not evidence.
 */
export const CONTAMINATED_SLUGS = new Map([
  [
    "02-oil-boiler-basement",
    "identical to the few-shot example in examples.ts — grading it measures copying",
  ],
]);

/** Every leaf EXCEPT the 13 health-matrix tests — these get the generic hallucination/miss/enum/
 * band treatment; the 13 get their own section (hallucinated-pass is the crux there, not a generic
 * "wrong enum"). Derived, not hand-counted: 51 - 13 = 38. */
export const GENERIC_LEAF_PATHS = LEAF_PATHS.filter((p) => !HEALTH_TEST_SET.has(p));

/** Ordered band members for a band leaf, excluding "Don't Know" (uncertainty, not a position). */
function bandOrder(path) {
  return LEAF_BY_PATH.get(path).options.filter((o) => o !== "Don't Know");
}

// ---------------------------------------------------------------------------
// Small value-comparison helpers (numbers / free strings; enums go through
// resolveEnumMember in schema-leaves.mjs, not here)
// ---------------------------------------------------------------------------

const pct = (n, d) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const fixed3 = (n) => (n === null || n === undefined ? "  n/a" : n.toFixed(3));
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

const normStr = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const NUM_WORDS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function wordsToInt(tokens) {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const t of tokens) {
    if (t === "and") continue;
    if (t in NUM_WORDS) {
      current += NUM_WORDS[t];
      seen = true;
    } else if (t === "hundred") {
      current = (current || 1) * 100;
      seen = true;
    } else if (t === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + current : null;
}

/** Parse a model value into a number. Accepts numbers, decorated numerals, and spoken forms. */
export function parseNumberish(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  let s = v.toLowerCase().trim();
  s = s.replace(/^r-?\s*/, "");
  s = s.replace(/[,%]/g, "");
  s = s.replace(
    /\b(cfm ?50|cfm ?25|ach ?50|cfm|ach|pa|percent|years?|yrs?|ppm|gal(lons?)?|btu\/?h?|btu)\b/g,
    "",
  );
  s = s.trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const [head] = s.split(/\bpoint\b/);
  const tokens = head.split(/[\s-]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  let whole = wordsToInt(tokens);
  if (whole === null && tokens.length === 2) {
    const a = NUM_WORDS[tokens[0]];
    const b = NUM_WORDS[tokens[1]];
    if (a !== undefined && b !== undefined && a >= 10 && b >= 10) whole = a * 100 + b;
  }
  return whole;
}

const numbersNear = (x, y) =>
  Math.abs(x - y) <= Math.max(1e-9, 1e-6 * Math.max(Math.abs(x), Math.abs(y)));

/** Loose text normalization for near-miss span detection. */
const normText = (s) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

/** Verbatim per prompt.md rule 3: transcript.includes(span), normalising only trailing whitespace.
 * An EMPTY span is never verbatim — `"".includes("")` is trivially true for every transcript, so a
 * model emitting `sourceSpan: ""` (grounds for nothing) must not score as grounded in everything. */
export function spanIsVerbatim(span, transcript) {
  if (typeof span !== "string" || span.length === 0) return false;
  if (transcript.includes(span)) return true;
  return transcript.includes(span.replace(/\s+$/, ""));
}

/** Classify a non-verbatim span as near-miss (paraphrase/cleaned/joined) vs wholly fabricated. */
export function classifySpan(span, transcript) {
  if (spanIsVerbatim(span, transcript)) return { status: "verbatim", detail: "exact substring" };
  // An empty span must fall straight through to "fabricated": every one of the near-miss checks
  // below is a variant of `haystack.includes(needle)`, which `"".includes("")` (and every fold of
  // it) trivially satisfies for ANY transcript — the same hazard `spanIsVerbatim` above guards
  // against, but the near-miss path has its own independent `.includes()` calls that need the same
  // guard, not a shared one.
  if (typeof span !== "string" || span.length === 0) {
    return { status: "fabricated", detail: "empty span — grounds for nothing" };
  }
  const nt = normText(transcript);
  const ns = normText(span);
  if (nt.includes(ns))
    return { status: "near-miss", detail: "differs only in case/whitespace/quotes" };
  const strip = (s) =>
    s
      .replace(/[^a-z0-9 ]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  if (strip(nt).includes(strip(ns)))
    return { status: "near-miss", detail: "differs only in punctuation" };
  const words = ns.split(" ").filter(Boolean);
  for (let w = Math.min(6, words.length); w >= 4; w--) {
    for (let i = 0; i + w <= words.length; i++) {
      if (nt.includes(words.slice(i, i + w).join(" "))) {
        return {
          status: "near-miss",
          detail: `only a ${w}-word fragment matches (paraphrase or join)`,
        };
      }
    }
  }
  return { status: "fabricated", detail: "no substantial fragment found in the transcript" };
}

// ---------------------------------------------------------------------------
// Ground-truth leaf -> canonical comparison target
// ---------------------------------------------------------------------------

/**
 * Normalize one leaf's ground truth into what scoring needs, regardless of kind:
 * whether it is null (unmentioned OR declared_absent — both score as "no value"), and the
 * canonical target when it is not.
 */
function gtCanonical(path, leafTruth) {
  const spec = LEAF_BY_PATH.get(path);
  if (!leafTruth || leafTruth.status !== "asserted") {
    return { isNull: true, kind: spec.kind };
  }
  if (spec.kind === "enum") {
    return {
      isNull: false,
      kind: "enum",
      member: leafTruth.member ?? null,
      noFittingMember: leafTruth.noFittingMember ?? null,
    };
  }
  return { isNull: false, kind: spec.kind, value: leafTruth.value };
}

/** `arguable`/`retracted` live on the leaf truth regardless of status; pull them out uniformly. */
function gtExtras(leafTruth) {
  return { arguable: leafTruth?.arguable ?? null, retracted: leafTruth?.retracted ?? [] };
}

/** Does `rawModelValue` match one of the leaf's sanctioned soft alternatives? */
function matchesAlternative(path, kind, rawModelValue, alternatives) {
  if (!alternatives || alternatives.length === 0) return false;
  if (kind === "enum") {
    const resolved = resolveEnumMember(path, rawModelValue);
    return resolved.member !== null && alternatives.includes(resolved.member);
  }
  if (kind === "number") {
    const n = parseNumberish(rawModelValue);
    return n !== null && alternatives.some((a) => typeof a === "number" && numbersNear(a, n));
  }
  return alternatives.some(
    (a) => typeof a === "string" && normStr(a) === normStr(String(rawModelValue)),
  );
}

/** Does `rawModelValue` match one of the leaf's RETRACTED (withdrawn, last-value-wins-losing) values? */
function matchesRetracted(path, kind, rawModelValue, retracted) {
  if (!retracted || retracted.length === 0) return false;
  if (kind === "enum") {
    const resolved = resolveEnumMember(path, rawModelValue);
    return resolved.member !== null && retracted.some((r) => r.value === resolved.member);
  }
  if (kind === "number") {
    const n = parseNumberish(rawModelValue);
    return (
      n !== null && retracted.some((r) => typeof r.value === "number" && numbersNear(r.value, n))
    );
  }
  return retracted.some(
    (r) => typeof r.value === "string" && normStr(r.value) === normStr(String(rawModelValue)),
  );
}

/**
 * Compare a GT canonical value and a model's raw leaf value, given GT is non-null.
 * Returns { verdict: 'correct'|'wrong', tag, detail, vocabulary? }.
 */
function compareValue(path, gt, rawModelValue) {
  if (gt.kind === "number") {
    const a = gt.value;
    const b = parseNumberish(rawModelValue);
    if (b === null)
      return {
        verdict: "wrong",
        tag: "unparseable",
        detail: `unparseable ${JSON.stringify(rawModelValue)}`,
      };
    if (numbersNear(a, b)) return { verdict: "correct", tag: "match", detail: "numeric match" };
    return { verdict: "wrong", tag: "number", detail: `expected ${a}, got ${b}` };
  }
  if (gt.kind === "string") {
    const a = normStr(gt.value);
    const b = normStr(String(rawModelValue));
    if (a === b || (a.length > 2 && b.length > 2 && (a.includes(b) || b.includes(a)))) {
      return { verdict: "correct", tag: "match", detail: "string match" };
    }
    return {
      verdict: "wrong",
      tag: "string",
      detail: `expected ${JSON.stringify(gt.value)}, got ${JSON.stringify(rawModelValue)}`,
    };
  }
  // enum
  if (gt.noFittingMember) {
    // No schema member is correct; there is nothing to be "correct" against.
    const resolved = resolveEnumMember(path, rawModelValue);
    return resolved.member === null
      ? {
          verdict: "wrong",
          tag: "invalid-enum",
          detail: `"${rawModelValue}" is not a member of this leaf`,
        }
      : {
          verdict: "unscorable",
          tag: "no-fitting-member",
          vocabulary: resolved.vocabulary,
          detail: `landed on "${resolved.member}"; GT has no fitting member to grade against`,
        };
  }
  const resolved = resolveEnumMember(path, rawModelValue);
  if (resolved.member === null) {
    return {
      verdict: "wrong",
      tag: "invalid-enum",
      detail: `"${rawModelValue}" matches neither vocabulary for this leaf`,
    };
  }
  if (resolved.member === gt.member) {
    return { verdict: "correct", tag: "match", vocabulary: resolved.vocabulary };
  }
  if (BAND_LEAVES.has(path)) {
    const order = bandOrder(path);
    const ai = order.indexOf(gt.member);
    const bi = order.indexOf(resolved.member);
    if (ai !== -1 && bi !== -1 && Math.abs(ai - bi) === 1) {
      return {
        verdict: "wrong",
        tag: "boundary",
        vocabulary: resolved.vocabulary,
        detail: `off-by-one band: expected ${gt.member}, got ${resolved.member}`,
      };
    }
  }
  return {
    verdict: "wrong",
    tag: "wrong-member",
    vocabulary: resolved.vocabulary,
    detail: `expected "${gt.member}", got "${resolved.member}"`,
  };
}

// ---------------------------------------------------------------------------
// Result loading (robust to fences / prose / malformed) — unchanged from the
// old scorer; the failure modes it guards against are about the MODEL's
// output hygiene, not the schema shape.
// ---------------------------------------------------------------------------

export function extractJson(raw) {
  const text = String(raw).trim();
  if (text === "") return { error: "file is empty" };
  try {
    return { data: JSON.parse(text), repaired: null };
  } catch {
    /* fall through */
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return { data: JSON.parse(fence[1]), repaired: "stripped markdown fence" };
    } catch {
      /* keep trying */
    }
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return {
        data: JSON.parse(text.slice(first, last + 1)),
        repaired: "stripped surrounding prose",
      };
    } catch {
      /* give up */
    }
  }
  return { error: "not parseable as JSON" };
}

export function loadResult(dir, slug) {
  const path = join(dir, `${slug}.json`);
  if (!existsSync(path)) return { data: null, problem: "result file absent" };
  const raw = readFileSync(path, "utf8");
  const out = extractJson(raw);
  if (out.error) return { data: null, problem: `${out.error} (${raw.length} bytes)` };
  if (out.data === null || typeof out.data !== "object" || Array.isArray(out.data)) {
    return { data: null, problem: "top level is not an object" };
  }
  return { data: out.data, repaired: out.repaired ?? null, problem: null };
}

/** Navigate a dotted leaf path into the nested model output and read its envelope defensively. */
function readLeaf(model, path) {
  const parts = path.split(".");
  const groupKey = parts[0];
  const leafKey = parts[1];
  const envErrors = [];
  const group = model?.[groupKey];
  if (group === undefined)
    return { value: null, confidence: null, span: null, missing: true, envErrors };
  if (typeof group !== "object" || group === null || Array.isArray(group)) {
    envErrors.push(`${groupKey}: not an object`);
    return { value: null, confidence: null, span: null, envErrors };
  }
  const cell = group[leafKey];
  if (cell === undefined)
    return { value: null, confidence: null, span: null, missing: true, envErrors };
  if (cell === null || typeof cell !== "object" || Array.isArray(cell)) {
    envErrors.push(`${path}: not a {value,confidence,sourceSpan} object`);
    return { value: null, confidence: null, span: null, envErrors };
  }
  const ENVELOPE_KEYS = ["value", "confidence", "sourceSpan"];
  const keys = Object.keys(cell);
  for (const k of ENVELOPE_KEYS) if (!keys.includes(k)) envErrors.push(`${path}: missing "${k}"`);
  for (const k of keys) if (!ENVELOPE_KEYS.includes(k)) envErrors.push(`${path}: extra key "${k}"`);
  const value = cell.value ?? null;
  let confidence = typeof cell.confidence === "number" ? cell.confidence : null;
  if (cell.confidence !== undefined && confidence === null)
    envErrors.push(`${path}: confidence is not a number`);
  const span = typeof cell.sourceSpan === "string" ? cell.sourceSpan : null;
  if (cell.sourceSpan !== undefined && cell.sourceSpan !== null && span === null) {
    envErrors.push(`${path}: sourceSpan is not a string or null`);
  }
  return { value, confidence, span, envErrors };
}

// ---------------------------------------------------------------------------
// Core scoring for one transcript
// ---------------------------------------------------------------------------

function emptyCounts() {
  return {
    gtNull: 0,
    gtNonNull: 0,
    correctNull: 0,
    hallucinationHard: 0,
    hallucinationSoft: 0,
    unscorable: 0,
    miss: 0,
    missExcused: 0,
    bothNonNull: 0,
    correct: 0,
    wrong: 0,
    rvalueConversion: 0,
    enumGtMember: 0,
    enumCorrect: 0,
    enumWrongMember: 0,
    enumInvalid: 0,
    enumMiss: 0,
    enumSanctioned: 0,
    vocabApi: 0,
    vocabSlug: 0,
    bandGt: 0,
    bandCorrect: 0,
    bandBoundary: 0,
    bandWrong: 0,
    bandMiss: 0,
    spanChecked: 0,
    spanVerbatim: 0,
    spanNearMiss: 0,
    spanFabricated: 0,
    spanMissing: 0,
    hGtNull: 0,
    hCorrectNull: 0,
    hHallucinatedPass: 0,
    hHallucinatedProblem: 0,
    hSilentNotTested: 0,
    hGtState: 0,
    hCorrectState: 0,
    hWrongState: 0,
    hMiss: 0,
    hMissExcused: 0,
    hCleanDropped: 0,
    hGtPassed: 0,
    hGtPassedCorrect: 0,
  };
}

/**
 * Score one transcript against its new-format ground truth.
 * @param slug transcript slug
 * @param rawGt the parsed, VALIDATED new-format ground-truth object — RAW, i.e. `leaves` may be
 *   sparse and `disclaimers` unresolved; this function resolves it (see `ground-truth.mjs`'s
 *   `resolveGroundTruth`) before scoring anything, so a scope-policy change re-scores every
 *   transcript without anyone touching a ground-truth file.
 * @param transcript raw transcript text
 * @param model parsed model output object, or null when missing/malformed
 * @param loadProblem optional string describing why model is null
 */
export function scoreTranscript(slug, rawGt, transcript, model, loadProblem = null) {
  const gt = resolveGroundTruth(rawGt);
  const r = {
    slug,
    status: model ? "scored" : "unscored",
    problem: loadProblem,
    counts: emptyCounts(),
    conformance: {
      missingGroups: [],
      extraGroups: [],
      missingLeaves: [],
      extraLeaves: [],
      envelopeErrors: [],
    },
    hallucinations: [],
    softAlternatives: [],
    sanctionedRows: [],
    misses: [],
    excused: [],
    wrong: [],
    unscorableRows: [],
    badSpans: [],
    axis: [],
    health: [],
    confidences: { correct: [], wrong: [], correctNull: [], hallucinated: [] },
  };

  // GT-side counts always available (even for unscored, so denominators are honest).
  for (const path of GENERIC_LEAF_PATHS) {
    if (gtCanonical(path, gt.leaves[path]).isNull) r.counts.gtNull++;
    else r.counts.gtNonNull++;
  }
  for (const path of HEALTH_TEST_PATHS) {
    if (gtCanonical(path, gt.leaves[path]).isNull) r.counts.hGtNull++;
    else r.counts.hGtState++;
  }

  // A missing/unparseable result is NOT "nothing to score" — it is scored EXACTLY as if the
  // extractor had emitted an empty object: every leaf reads as absent via `readLeaf`'s existing
  // `model?.[groupKey]` handling, which correctly turns every GT-non-null leaf into a counted miss
  // (or hMiss/enumMiss/bandMiss, and an excused miss where `arguable.acceptableMiss` says so) rather
  // than a silent zero. `status` stays "unscored" (excluded from axis/confidence aggregation and
  // shown as "NOT SCORED" per-transcript, since there is genuinely no real output to characterize
  // beyond "missed everything"), but `counts` — which `aggregate()` sums over EVERY report,
  // regardless of status — now honestly reflects that an extractor returning nothing is exactly as
  // good as one that returns all-nulls, never better. This is the fix for the specific property:
  // before it, a missing result scored miss=0 on every leaf, so "return nothing" beat "try and get
  // some wrong" — see score.test.mjs's ROBUSTNESS gate for the mutation that proves it.
  const modelOrEmpty = model ?? {};

  // ---- conformance: groups, then leaves within present groups ----
  r.conformance.missingGroups = GROUPS.filter((g) => !(g in modelOrEmpty));
  r.conformance.extraGroups = Object.keys(modelOrEmpty).filter((g) => !GROUPS.includes(g));
  for (const group of GROUPS) {
    const groupLeaves = LEAF_PATHS.filter((p) => p.startsWith(`${group}.`));
    const localKeys = groupLeaves.map((p) => p.slice(group.length + 1));
    const groupObj = modelOrEmpty[group];
    if (groupObj === undefined || typeof groupObj !== "object" || groupObj === null) continue;
    for (const k of localKeys)
      if (!(k in groupObj)) r.conformance.missingLeaves.push(`${group}.${k}`);
    for (const k of Object.keys(groupObj))
      if (!localKeys.includes(k)) r.conformance.extraLeaves.push(`${group}.${k}`);
  }

  const rvalueOnly =
    gtCanonical("attic.atticInsulationDepth", gt.leaves["attic.atticInsulationDepth"]).isNull &&
    !gtCanonical("attic.atticInsulation", gt.leaves["attic.atticInsulation"]).isNull;

  const scoreOneLeaf = (path, { isHealth }) => {
    const leafTruth = gt.leaves[path];
    const gtc = gtCanonical(path, leafTruth);
    const { arguable, retracted } = gtExtras(leafTruth);
    const leaf = readLeaf(modelOrEmpty, path);
    r.conformance.envelopeErrors.push(...leaf.envErrors);
    const { value: mv, confidence, span } = leaf;
    const isSanctioned = (raw) =>
      matchesAlternative(path, gtc.kind, raw, arguable?.acceptableAlternatives);

    // Counted ONCE here, unconditionally on GT alone — never inside a branch keyed on what the
    // model emitted. The denominator for "N of GT-passed dropped/kept" must count every GT-passed
    // leaf regardless of whether the model missed it, got it wrong, or got it right; counting it
    // only in the both-non-null branch (as a previous version did) meant a MISSED "Passed" bumped
    // the numerator (hCleanDropped, in the miss branch below) without ever bumping this
    // denominator — the denominator could end up smaller than the numerator it's supposed to bound.
    if (isHealth && gtc.member === "Passed") r.counts.hGtPassed++;

    if (gtc.isNull && mv === null) {
      r.counts.correctNull++;
      if (isHealth) r.counts.hCorrectNull++;
      if (confidence !== null) r.confidences.correctNull.push(confidence);
    } else if (gtc.isNull && mv !== null) {
      // GT null, model asserted something: a hallucination, unless the leaf's own `arguable`
      // sanctions this exact value, OR (health only) the value is the matrix's own mild
      // "explicitly not tested" member asserted on total silence — a real overreach, but a much
      // smaller one than inventing a Passed/Failed/Warning result (mirrors the old scorer's
      // `silentNotTested` bucket).
      const isRvalueConv = path === "attic.atticInsulationDepth" && rvalueOnly;
      if (isRvalueConv) r.counts.rvalueConversion++;
      if (isSanctioned(mv)) {
        r.counts.hallucinationSoft++;
        r.softAlternatives.push({ field: path, value: mv, confidence, note: arguable.note });
      } else if (isHealth && resolveEnumMember(path, mv).member === "Not Tested") {
        r.counts.hSilentNotTested++;
      } else if (isHealth) {
        const resolved = resolveEnumMember(path, mv);
        const category = resolved.member === "Passed" ? "hallucinatedPass" : "hallucinatedProblem";
        r.counts[category === "hallucinatedPass" ? "hHallucinatedPass" : "hHallucinatedProblem"]++;
        r.health.push({ test: path, gt: null, got: resolved.member ?? mv, category });
      } else {
        r.counts.hallucinationHard++;
        r.hallucinations.push({
          field: path,
          value: mv,
          confidence,
          sourceSpan: span,
          rvalueConversion: isRvalueConv,
        });
        if (confidence !== null) r.confidences.hallucinated.push(confidence);
      }
    } else if (!gtc.isNull && mv === null) {
      const excused = arguable?.acceptableMiss === true;
      if (excused) {
        if (isHealth) r.counts.hMissExcused++;
        else r.counts.missExcused++;
        r.excused.push({ field: path, note: arguable.note });
      } else if (isHealth) {
        r.counts.hMiss++;
        const wasPassed = gtc.member === "Passed";
        if (wasPassed) r.counts.hCleanDropped++;
        r.health.push({
          test: path,
          gt: gtc.member,
          got: null,
          category: wasPassed ? "cleanDropped" : "miss",
        });
      } else {
        r.counts.miss++;
        r.misses.push({
          field: path,
          expected: gtc.kind === "enum" ? gtc.member : gtc.value,
          span,
        });
        if (gtc.kind === "enum") r.counts.enumMiss++;
        if (BAND_LEAVES.has(path)) r.counts.bandMiss++;
      }
    } else {
      // both non-null
      r.counts.bothNonNull++;
      const cmp = compareValue(path, gtc, mv);
      const sanctioned = cmp.verdict !== "correct" && isSanctioned(mv);
      if (cmp.verdict === "unscorable" && !sanctioned) {
        r.counts.unscorable++;
        r.unscorableRows.push({ field: path, got: mv, detail: cmp.detail });
      } else {
        const ok = cmp.verdict === "correct" || sanctioned;
        // Vocabulary attribution is ONLY meaningful for a TRUE match against GT's own canonical
        // member — gated strictly on cmp.verdict === "correct", never on `ok` (which also folds in
        // `sanctioned`). Getting this gate wrong is exactly how a wrong answer ends up counted as a
        // "CORRECT match": cmp.vocabulary is set by compareValue whenever the raw value resolves to
        // ANY real member, correct or not, so counting on `ok`/`sanctioned` or on "vocabulary is
        // non-null" rather than on the verdict itself corrupts the one measurement this whole format
        // exists to make possible. See score.test.mjs's EITHER-VOCABULARY gate for the mutation that
        // proves a wrong slug-spelled value is excluded.
        if (cmp.verdict === "correct") {
          if (cmp.vocabulary === "api") r.counts.vocabApi++;
          else if (cmp.vocabulary === "slug") r.counts.vocabSlug++;
        }

        if (sanctioned) {
          // GT is NON-NULL here (this whole branch is "both non-null") — nothing was hallucinated;
          // the schema itself forced an arbitrary pick between two (or more) equally-fitting
          // members (the worked example's furnace/cooling axis is the standing case) and the model
          // landed on the OTHER lobe of that same forced choice. This is categorically different
          // from the GT-null "sanctioned" branch above (a real soft hallucination, tolerated) and
          // must not share its counter/bucket or its HALLUCINATION-section reporting — see
          // IMPORTANT 9 in the fix-round-2 review. Reported under ENUM-MAPPING instead.
          r.counts.enumSanctioned++;
          r.sanctionedRows.push({ field: path, value: mv, confidence, note: arguable.note });
        } else if (isHealth) {
          if (ok) {
            r.counts.hCorrectState++;
            if (gtc.member === "Passed") r.counts.hGtPassedCorrect++;
          } else {
            const resolved = resolveEnumMember(path, mv);
            const category = resolved.member === "Passed" ? "hallucinatedPass" : "wrongState";
            r.counts[category === "hallucinatedPass" ? "hHallucinatedPass" : "hWrongState"]++;
            r.health.push({ test: path, gt: gtc.member, got: resolved.member ?? mv, category });
          }
        } else {
          if (ok) {
            r.counts.correct++;
            if (confidence !== null) r.confidences.correct.push(confidence);
          } else {
            const isRetracted = matchesRetracted(path, gtc.kind, mv, retracted);
            r.counts.wrong++;
            r.wrong.push({
              field: path,
              expected: gtc.kind === "enum" ? gtc.member : gtc.value,
              got: mv,
              tag: isRetracted ? "retracted" : cmp.tag,
              detail: cmp.detail,
              confidence,
            });
            if (confidence !== null) r.confidences.wrong.push(confidence);
          }
          if (gtc.kind === "enum") {
            r.counts.enumGtMember++;
            if (ok) r.counts.enumCorrect++;
            else if (cmp.tag === "invalid-enum") r.counts.enumInvalid++;
            else if (cmp.tag !== "boundary") r.counts.enumWrongMember++;
          }
          if (BAND_LEAVES.has(path)) {
            r.counts.bandGt++;
            if (ok) r.counts.bandCorrect++;
            else if (cmp.tag === "boundary") r.counts.bandBoundary++;
            else r.counts.bandWrong++;
          }
        }
      }
    }

    // span validity for any non-null model value, or a fabricated span on a null decline
    if (span !== null) {
      const c = classifySpan(span, transcript);
      if (mv !== null) {
        r.counts.spanChecked++;
        if (c.status === "verbatim") r.counts.spanVerbatim++;
        else {
          if (c.status === "near-miss") r.counts.spanNearMiss++;
          else r.counts.spanFabricated++;
          r.badSpans.push({ field: path, value: mv, span, status: c.status, detail: c.detail });
        }
      } else if (c.status === "fabricated") {
        r.badSpans.push({
          field: path,
          value: null,
          span,
          status: "fabricated-decline",
          detail: c.detail,
        });
      }
    } else if (mv !== null) {
      r.counts.spanChecked++;
      r.counts.spanMissing++;
      r.badSpans.push({
        field: path,
        value: mv,
        span: null,
        status: "missing",
        detail: "non-null value with no sourceSpan",
      });
    }
  };

  for (const path of GENERIC_LEAF_PATHS) scoreOneLeaf(path, { isHealth: false });
  for (const path of HEALTH_TEST_PATHS) scoreOneLeaf(path, { isHealth: true });

  // ---- axis-split (equipment vs fuel, per AXIS_PAIRS) ----
  for (const pair of AXIS_PAIRS) r.axis.push(scoreAxis(pair, gt, modelOrEmpty));

  return r;
}

/** Axis-split confusion for one equipment/fuel pair. */
function scoreAxis(pair, gt, model) {
  const eqGt = gtCanonical(pair.equipment, gt.leaves[pair.equipment]);
  if (eqGt.isNull) return null; // no system stated on this axis pair
  const fuelGt = gtCanonical(pair.fuel, gt.leaves[pair.fuel]);
  const eqLeaf = readLeaf(model, pair.equipment);
  const fuelLeaf = readLeaf(model, pair.fuel);

  // "correct" here means "the ordinary comparison says correct, OR the leaf's own `arguable`
  // sanctions this exact value" — the SAME rule scoreOneLeaf applies, so a leaf whose equipment
  // member is a symmetric noFittingMember (see the worked example) is not falsely reported as
  // axis-wrong just because compareValue alone can never call it "correct".
  const eqArguable = gtExtras(gt.leaves[pair.equipment]).arguable;
  const eqCmp = eqLeaf.value !== null ? compareValue(pair.equipment, eqGt, eqLeaf.value) : null;
  const eqCorrect =
    eqCmp?.verdict === "correct" ||
    (eqCmp !== null &&
      eqCmp.verdict !== "correct" &&
      matchesAlternative(
        pair.equipment,
        eqGt.kind,
        eqLeaf.value,
        eqArguable?.acceptableAlternatives,
      ));
  const fuelArguable = gtExtras(gt.leaves[pair.fuel]).arguable;
  const fuelCmp =
    !fuelGt.isNull && fuelLeaf.value !== null
      ? compareValue(pair.fuel, fuelGt, fuelLeaf.value)
      : null;
  const fuelCorrect =
    fuelCmp?.verdict === "correct" ||
    (fuelCmp !== null &&
      fuelCmp.verdict !== "correct" &&
      matchesAlternative(
        pair.fuel,
        fuelGt.kind,
        fuelLeaf.value,
        fuelArguable?.acceptableAlternatives,
      ));

  let category;
  if (fuelGt.isNull) {
    category =
      fuelLeaf.value === null
        ? eqCorrect
          ? "silentDropRespected"
          : "silentDropEqWrong"
        : "fuelInvented";
  } else if (eqCorrect && fuelCorrect) {
    category = "bothCorrect";
  } else if (eqCorrect && fuelLeaf.value === null) {
    category = "fuelDropped";
  } else if (eqCorrect && !fuelCorrect) {
    category = "fuelWrongMember";
  } else {
    category = "eqWrongMember";
  }
  return {
    pair: `${pair.equipment} / ${pair.fuel}`,
    eqGt: eqGt.member,
    fuelGt: fuelGt.isNull ? null : fuelGt.member,
    eqM: eqLeaf.value,
    fuelM: fuelLeaf.value,
    eqCorrect,
    fuelCorrect,
    category,
  };
}

// ---------------------------------------------------------------------------
// Test helper: build a "perfect" model output by copying GT canonical values
// into the nested envelope shape (with confidence), so a copy scores clean.
// ---------------------------------------------------------------------------

export function buildPerfectModel(rawGt, confidence = 0.9) {
  const gt = resolveGroundTruth(rawGt);
  const out = {};
  for (const group of GROUPS) out[group] = {};
  for (const path of LEAF_PATHS) {
    const [group, leafKey] = path.split(".");
    const leafTruth = gt.leaves[path];
    const gtc = gtCanonical(path, leafTruth);
    // A `noFittingMember` leaf has no single canonical value to copy — score a "perfect" run as
    // emitting the first sanctioned alternative, since that is what "scores clean" means for a
    // leaf the ground truth itself says has no one right answer (see the worked example).
    const value = gtc.isNull
      ? null
      : gtc.kind !== "enum"
        ? gtc.value
        : (gtc.member ?? gtExtras(leafTruth).arguable?.acceptableAlternatives?.[0] ?? null);
    const sourceSpan = leafTruth?.sourceSpan ?? null;
    out[group][leafKey] = { value, confidence, sourceSpan };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregate(reports) {
  const scored = reports.filter((r) => r.status === "scored");
  const keys = Object.keys(emptyCounts());
  const totals = Object.fromEntries(
    keys.map((k) => [k, reports.reduce((a, r) => a + r.counts[k], 0)]),
  );

  const axisRows = scored.flatMap((r) => r.axis).filter(Boolean);
  const axisTally = {};
  for (const a of axisRows) axisTally[a.category] = (axisTally[a.category] ?? 0) + 1;

  const conf = {
    correct: scored.flatMap((r) => r.confidences.correct),
    wrong: scored.flatMap((r) => r.confidences.wrong),
    correctNull: scored.flatMap((r) => r.confidences.correctNull),
    hallucinated: scored.flatMap((r) => r.confidences.hallucinated),
  };

  return { scored, totals, axisRows, axisTally, conf };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const HERE = import.meta.dirname;
  const GT_DIR = join(HERE, "ground-truth");
  const TRANSCRIPT_DIR = join(HERE, "transcripts");
  const resultsDir = resolve(process.argv[2] ?? join(HERE, "results", "codex"));
  const dirName = basename(resultsDir);

  if (!existsSync(resultsDir)) {
    console.error(`score.mjs: results directory not found: ${resultsDir}`);
    process.exit(1);
  }

  const slugs = readdirSync(GT_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .filter((slug) => {
      if (!CONTAMINATED_SLUGS.has(slug)) return true;
      console.warn(`   excluded from grading: ${slug} — ${CONTAMINATED_SLUGS.get(slug)}`);
      return false;
    })
    .sort();

  const reports = [];
  const pending = [];
  const warningsBySlug = [];
  for (const slug of slugs) {
    const raw = JSON.parse(readFileSync(join(GT_DIR, `${slug}.json`), "utf8"));
    if (!isNewFormat(raw)) {
      pending.push({ slug, reason: 'old format (no "leaves" key) — not yet re-annotated' });
      continue;
    }
    const transcript = readFileSync(join(TRANSCRIPT_DIR, `${slug}.txt`), "utf8");
    let validation;
    try {
      validation = validateGroundTruth(raw, transcript);
    } catch (err) {
      // validateGroundTruth is documented never to throw; if it somehow does (a defect in the
      // validator itself, not in this one file), that must degrade to "this transcript could not
      // be validated" rather than crashing the whole batch and hiding every other transcript's
      // result behind it.
      pending.push({ slug, reason: `ground-truth validator THREW: ${err.message}` });
      continue;
    }
    const { ok, errors, warnings } = validation;
    if (warnings?.length) warningsBySlug.push({ slug, warnings });
    if (!ok) {
      pending.push({
        slug,
        reason: `new-format ground truth is INVALID: ${errors[0]} (+${errors.length - 1} more)`,
      });
      continue;
    }
    const loaded = loadResult(resultsDir, slug);
    reports.push(scoreTranscript(slug, raw, transcript, loaded.data, loaded.problem));
  }

  const { scored, totals, axisRows, axisTally, conf } = aggregate(reports);
  const unscored = reports.filter((r) => r.status !== "scored");
  const line = (c = "-") => console.log(c.repeat(82));

  console.log("");
  line("=");
  console.log(`SNUGG PRO EXTRACTION SPIKE — ${dirName}`);
  line("=");
  console.log(`results dir : ${resultsDir}`);
  console.log(
    `coverage    : ${scored.length}/${slugs.length} corpus transcripts scored` +
      (pending.length ? `  (${pending.length} pending re-annotation)` : "") +
      (unscored.length
        ? `  (${unscored.length} missing/malformed results — counted as whole-transcript miss)`
        : ""),
  );
  if (pending.length) {
    console.log("");
    console.log("PENDING RE-ANNOTATION (ground truth not yet in the new format — not scored):");
    for (const p of pending) console.log(`  ${p.slug}: ${p.reason}`);
  }
  if (warningsBySlug.length) {
    console.log("");
    console.log("VALIDATION WARNINGS (do not block scoring; worth a human's attention):");
    for (const { slug, warnings } of warningsBySlug) {
      for (const w of warnings) console.log(`  ${slug}: ${w}`);
    }
  }
  if (reports.length === 0) {
    console.log("\nNothing to score yet.\n");
    return;
  }

  // 1. HALLUCINATION
  console.log("");
  line();
  console.log(
    `1. HALLUCINATION — non-null emitted where GT is null (${GENERIC_LEAF_PATHS.length} generic leaves)  [HEADLINE]`,
  );
  line();
  console.log(
    `   hard hallucination rate : ${padL(pct(totals.hallucinationHard, totals.gtNull), 7)}  (${totals.hallucinationHard}/${totals.gtNull} GT-null slots)`,
  );
  console.log(
    `   sanctioned alternatives : ${totals.hallucinationSoft}  (defensible non-nulls the leaf's own \`arguable\` sanctions)`,
  );
  console.log(
    `   R-value -> band inventions: ${totals.rvalueConversion}  (forbidden R->depth-band conversion)`,
  );
  console.log(
    "   !! Read against the miss rate below — an all-null output scores 0% here and is useless.",
  );

  // 2. MISS
  console.log("");
  line();
  console.log(
    `2. MISS — null emitted where GT has a value (${GENERIC_LEAF_PATHS.length} generic leaves)`,
  );
  line();
  const missDen = totals.gtNonNull - totals.missExcused;
  console.log(
    `   miss rate : ${padL(pct(totals.miss, missDen), 7)}  (${totals.miss}/${missDen} stated values left null; ${totals.missExcused} excused)`,
  );
  // The COMBINED figure, printed here so the partial one above cannot be quoted as the
  // whole. `gtNonNull` iterates GENERIC_LEAF_PATHS only, so the rate above excludes all
  // 13 health tests by construction — which is correct for that section and was
  // misleading the moment it was lifted out of it. doc 18 reported "miss rate 1.5%" from
  // this number while a materially larger share of stated HEALTH states had been dropped,
  // because those live in `hMiss` and are counted in section 5.
  const allMissDen =
    totals.gtNonNull - totals.missExcused + (totals.hGtState - totals.hMissExcused);
  const allMiss = totals.miss + totals.hMiss;
  console.log(
    `   miss rate, ALL 51 leaves : ${padL(pct(allMiss, allMissDen), 7)}  (${allMiss}/${allMissDen}) <- quote THIS one`,
  );
  console.log(
    `   accuracy on both-non-null : ${padL(pct(totals.correct, totals.correct + totals.wrong), 7)}  (${totals.correct}/${totals.correct + totals.wrong} correct)`,
  );
  if (totals.unscorable)
    console.log(
      `   unscorable (GT has no fitting member, model landed off-list) : ${totals.unscorable} — excluded from the accuracy above`,
    );

  // 3. AXIS-SPLIT
  console.log("");
  line();
  console.log("3. AXIS-SPLIT — equipment vs fuel, per axis pair (hvac, dhw)");
  line();
  const fusedRows = axisRows.filter((a) => a.fuelGt !== null);
  const bothCorrect = axisTally.bothCorrect ?? 0;
  console.log(
    `   both-correct rate : ${padL(pct(bothCorrect, fusedRows.length), 7)}  (${bothCorrect}/${fusedRows.length} stated equipment+fuel split onto both axes)`,
  );
  console.log(
    `   fuel DROPPED (equip right, fuel null when stated) : ${axisTally.fuelDropped ?? 0}   <- the #1 predicted failure`,
  );
  console.log(
    `   fuel INVENTED where none stated                   : ${axisTally.fuelInvented ?? 0}`,
  );
  console.log(
    `   eq-wrong / fuel-wrong-member                      : ${axisTally.eqWrongMember ?? 0} / ${axisTally.fuelWrongMember ?? 0}`,
  );
  console.log(
    `   silent-drop respected                             : ${axisTally.silentDropRespected ?? 0}`,
  );

  // 4. ENUM-MAPPING + VOCABULARY MIX
  console.log("");
  line();
  console.log("4. ENUM-MAPPING — GT is a specific member");
  line();
  console.log(
    `   member accuracy : ${padL(pct(totals.enumCorrect, totals.enumGtMember), 7)}  (${totals.enumCorrect}/${totals.enumGtMember} correct; on model-emitted enums)`,
  );
  console.log(
    `   wrong-member ${totals.enumWrongMember}   invalid (matches neither vocabulary) ${totals.enumInvalid}   dropped-to-null ${totals.enumMiss}`,
  );
  console.log(
    `   sanctioned (schema forced an arbitrary pick; model chose the other lobe) : ${totals.enumSanctioned}` +
      "   <- NOT a hallucination; GT is non-null and nothing was invented",
  );
  console.log(
    `   vocabulary mix on CORRECT matches ONLY (excludes sanctioned/wrong) : api-literal ${totals.vocabApi}   snake_case-slug ${totals.vocabSlug}` +
      "   <- both score identically; this is what lets one ground truth test either vocabulary",
  );

  // 5. BAND-MAPPING
  console.log("");
  line();
  console.log("5. BAND-MAPPING — depth/age band ([...BAND_LEAVES])");
  line();
  console.log(
    `   band accuracy : ${padL(pct(totals.bandCorrect, totals.bandGt), 7)}  (${totals.bandCorrect}/${totals.bandGt} correct band)`,
  );
  console.log(
    `   boundary (off-by-one bucket) ${totals.bandBoundary}   flat-wrong ${totals.bandWrong}   dropped-to-null ${totals.bandMiss}`,
  );
  console.log(`   R-value -> band inventions (forbidden conversion) : ${totals.rvalueConversion}`);

  // 6. HEALTH MATRIX
  console.log("");
  line();
  console.log(`6. HEALTH-MATRIX STATE — ${HEALTH_TEST_PATHS.length} tests x transcripts`);
  line();
  const hCorrect = totals.hCorrectNull + totals.hCorrectState;
  const hWrong =
    totals.hHallucinatedPass +
    totals.hHallucinatedProblem +
    totals.hCleanDropped +
    totals.hMiss +
    totals.hWrongState;
  console.log(
    `   state accuracy : ${padL(pct(hCorrect, hCorrect + hWrong), 7)}  (${hCorrect} correct / ${hWrong} wrong; ${totals.hMissExcused} excused)`,
  );
  console.log(
    `   >> HALLUCINATED PASS (Passed where truth is not Passed) : ${totals.hHallucinatedPass}   <- the crux`,
  );
  console.log(
    `   >> CLEAN DROPPED TO NULL (Passed lost)                  : ${totals.hCleanDropped}  of ${totals.hGtPassed} clean results`,
  );
  console.log(
    `      clean correctly kept as Passed : ${totals.hGtPassedCorrect}/${totals.hGtPassed}`,
  );
  console.log(
    `      hallucinated problem (Failed/Warning invented) ${totals.hHallucinatedProblem}   wrong-state ${totals.hWrongState}   miss ${totals.hMiss}`,
  );
  console.log(
    `      soft: silence -> "Not Tested" asserted ${totals.hSilentNotTested}   (mild overreach; not counted as a hallucination)`,
  );

  // 7. SOURCESPAN
  console.log("");
  line();
  console.log("7. SOURCESPAN VALIDITY — verbatim substring of the transcript");
  line();
  console.log(
    `   verbatim rate : ${padL(pct(totals.spanVerbatim, totals.spanChecked), 7)}  (${totals.spanVerbatim}/${totals.spanChecked} non-null values)`,
  );
  console.log(
    `   near-miss ${totals.spanNearMiss}   fabricated ${totals.spanFabricated}   missing ${totals.spanMissing}`,
  );

  // 8. CONFIDENCE
  console.log("");
  line();
  console.log("8. CONFIDENCE SEPARATION — uncalibrated; numbers only, no thresholds");
  line();
  const mC = mean(conf.correct);
  const mW = mean(conf.wrong);
  const gap = mC !== null && mW !== null ? mC - mW : null;
  console.log(
    `   mean confidence  correct ${fixed3(mC)}   wrong ${fixed3(mW)}   gap ${gap === null ? "  n/a" : (gap >= 0 ? "+" : "") + gap.toFixed(3)}`,
  );
  console.log(
    `   mean confidence  correct-null ${fixed3(mean(conf.correctNull))}   hallucinated ${fixed3(mean(conf.hallucinated))}`,
  );
  if (gap !== null && Math.abs(gap) < 0.05)
    console.log("   !! gap ~ zero: confidence carries no signal here. Do not flag on it.");

  // schema conformance
  const conformant = scored.filter(
    (r) =>
      !r.conformance.missingGroups.length &&
      !r.conformance.extraGroups.length &&
      !r.conformance.missingLeaves.length &&
      !r.conformance.extraLeaves.length &&
      !r.conformance.envelopeErrors.length,
  );
  console.log("");
  console.log(
    `   schema conformance : ${conformant.length}/${scored.length} outputs had exactly the groups/leaves and clean envelopes`,
  );

  // per-transcript
  console.log("");
  line();
  console.log("PER TRANSCRIPT");
  line();
  console.log(
    `${pad("transcript", 28)}${pad("halluc", 10)}${pad("miss", 10)}${pad("acc", 10)}${pad("hPass", 7)}${pad("span", 8)}flags`,
  );
  for (const r of reports) {
    if (r.status !== "scored") {
      console.log(
        `${pad(r.slug, 28)}${pad("-", 10)}${pad("-", 10)}${pad("-", 10)}${pad("-", 7)}${pad("-", 8)}NOT SCORED (${r.problem})`,
      );
      continue;
    }
    const c = r.counts;
    const md = c.gtNonNull - c.missExcused;
    const ad = c.correct + c.wrong;
    const flags = [];
    if (c.hallucinationHard) flags.push("HALLUC");
    if (c.rvalueConversion) flags.push("RCONV");
    if (c.hHallucinatedPass) flags.push("HPASS");
    if (c.spanFabricated || c.spanMissing) flags.push("SPAN");
    if (r.axis.some((a) => a?.category === "fuelDropped")) flags.push("FUELDROP");
    if (
      r.conformance.missingGroups.length ||
      r.conformance.extraGroups.length ||
      r.conformance.missingLeaves.length ||
      r.conformance.extraLeaves.length ||
      r.conformance.envelopeErrors.length
    )
      flags.push("SCHEMA");
    console.log(
      pad(r.slug, 28) +
        pad(`${pct(c.hallucinationHard, c.gtNull)}`, 10) +
        pad(`${pct(c.miss, md)}`, 10) +
        pad(`${pct(c.correct, ad)}`, 10) +
        pad(`${c.hHallucinatedPass}`, 7) +
        pad(`${pct(c.spanVerbatim, c.spanChecked)}`, 8) +
        (flags.length ? flags.join(",") : "ok"),
    );
  }

  const section = (title, rows, render) => {
    console.log("");
    line();
    console.log(`${title} (${rows.length})`);
    line();
    if (!rows.length) return console.log("  none");
    for (const row of rows) console.log(render(row));
  };

  section(
    "HALLUCINATIONS — value emitted where GT is null",
    scored.flatMap((r) => r.hallucinations.map((h) => ({ ...h, slug: r.slug }))),
    (h) =>
      `  ${pad(h.slug, 26)}${pad(h.field, 30)}= ${JSON.stringify(h.value)}  [conf ${h.confidence ?? "?"}]` +
      (h.rvalueConversion ? "  <R->band CONVERSION>" : "") +
      `\n      span: ${h.sourceSpan === null ? "(none)" : JSON.stringify(h.sourceSpan)}`,
  );
  section(
    "SOFT ALTERNATIVES ON GT-NULL — non-null the leaf's own `arguable` allows (NOT hard hallucinations)",
    scored.flatMap((r) => r.softAlternatives.map((s) => ({ ...s, slug: r.slug }))),
    (s) => `  ${pad(s.slug, 26)}${pad(s.field, 30)}= ${JSON.stringify(s.value)}  — ${s.note}`,
  );
  section(
    "SANCTIONED (schema-forced choice) — GT is NON-NULL; the schema forced an arbitrary pick between " +
      "equally-fitting members and the model chose the other lobe. NOT a hallucination — see ENUM-MAPPING.",
    scored.flatMap((r) => r.sanctionedRows.map((s) => ({ ...s, slug: r.slug }))),
    (s) => `  ${pad(s.slug, 26)}${pad(s.field, 30)}= ${JSON.stringify(s.value)}  — ${s.note}`,
  );
  section(
    "AXIS-SPLIT rows",
    axisRows,
    (a) =>
      `  ${pad(a.pair, 46)}[${a.category}]  eq ${JSON.stringify(a.eqM)}/${JSON.stringify(a.eqGt)}  fuel ${JSON.stringify(a.fuelM)}/${JSON.stringify(a.fuelGt)}`,
  );
  section(
    "HEALTH deviations",
    scored.flatMap((r) => r.health.map((h) => ({ ...h, slug: r.slug }))),
    (h) =>
      `  ${pad(h.slug, 26)}${pad(h.test, 34)}[${h.category}] gt ${JSON.stringify(h.gt)} got ${JSON.stringify(h.got)}`,
  );
  section(
    "WRONG VALUES — both non-null, semantically different",
    scored.flatMap((r) => r.wrong.map((w) => ({ ...w, slug: r.slug }))),
    (w) =>
      `  ${pad(w.slug, 26)}${pad(w.field, 30)}[${w.tag}] ${w.detail}  [conf ${w.confidence ?? "?"}]`,
  );
  section(
    "MISSES — null where GT has a value",
    scored.flatMap((r) => r.misses.map((m) => ({ ...m, slug: r.slug }))),
    (m) => `  ${pad(m.slug, 26)}${pad(m.field, 30)}expected ${JSON.stringify(m.expected)}`,
  );
  section(
    "UNSCORABLE — GT has no fitting schema member (report only; excluded from accuracy)",
    scored.flatMap((r) => r.unscorableRows.map((u) => ({ ...u, slug: r.slug }))),
    (u) => `  ${pad(u.slug, 26)}${pad(u.field, 30)}got ${JSON.stringify(u.got)} — ${u.detail}`,
  );
  section(
    "INVALID sourceSpans — not a verbatim substring",
    scored.flatMap((r) => r.badSpans.map((b) => ({ ...b, slug: r.slug }))),
    (b) =>
      `  ${pad(b.slug, 26)}${pad(b.field, 30)}[${b.status}] ${b.detail}\n      value: ${JSON.stringify(b.value)}   span: ${JSON.stringify(b.span)}`,
  );
  section(
    "UNSCORED — missing or malformed result files (counted as whole-transcript miss)",
    unscored,
    (r) => `  ${pad(r.slug, 26)}${r.problem}`,
  );

  console.log("");
  line("=");
  console.log(
    `Headline: ${pct(totals.hallucinationHard, totals.gtNull)} hard hallucination vs ${pct(totals.miss, missDen)} miss; ` +
      `${totals.hHallucinatedPass} hallucinated health passes; ${axisTally.fuelDropped ?? 0} fuel drops. Neither number stands alone.`,
  );
  line("=");

  const outPath = join(HERE, "results", `${dirName}-score.json`);
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: dirName,
        resultsDir,
        coverage: {
          total: slugs.length,
          scored: scored.length,
          pendingReannotation: pending.map((p) => p.slug),
          unscored: unscored.map((r) => ({ slug: r.slug, problem: r.problem })),
        },
        totals,
        axisTally,
        confidence: {
          meanCorrect: mC,
          meanWrong: mW,
          gap,
          meanCorrectNull: mean(conf.correctNull),
          meanHallucinated: mean(conf.hallucinated),
        },
        perTranscript: reports.map((r) => ({
          slug: r.slug,
          status: r.status,
          problem: r.problem,
          counts: r.counts,
          axis: r.axis,
          hallucinations: r.hallucinations,
          health: r.health,
          badSpans: r.badSpans,
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nWrote ${outPath}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
