#!/usr/bin/env node
/**
 * Scorer for the Snugg Pro extraction spike.
 *
 *   node spikes/extraction-snuggpro/score.mjs [resultsDir]   # default: results/codex
 *
 * Reads ground-truth/NN-slug.json + transcripts/NN-slug.txt + <resultsDir>/NN-slug.json
 * and reports, per transcript and aggregate, the metrics the README defines. The schema is
 * NOT the old spike's schema: every leaf is a { value, confidence, sourceSpan } envelope,
 * `healthSafety` is a nested 11-test matrix, and there are split axes, depth/age bands, and
 * an R-value holding-pen. The metric logic here is new; only the file's shape follows the old
 * scorer.
 *
 * Metrics (README "Score metrics"):
 *   1. hallucination rate   — non-null emitted where GT is null, over the 23 top-level fields (headline)
 *   2. miss rate            — null emitted where GT has a value
 *   3. axis-split           — equipment vs fuel split, silent-fuel-drop and fused cases
 *   4. enum-mapping         — exact member match; `other` is WRONG when GT is a real member
 *   5. band-mapping         — depth/age band, boundary bucket, and forbidden R-value->band conversion
 *   6. health-matrix state  — per test; hallucinated-pass and clean->null called out
 *   7. sourceSpan validity  — verbatim substring of the transcript
 *   8. confidence separation — mean confidence, correct vs wrong (uncalibrated; numbers only)
 *
 * Robustness: a missing/unparseable/malformed result is a whole-transcript miss; the run keeps
 * going. Missing keys are treated as null; extra keys are reported. Never crashes.
 *
 * Partial credit: the per-field `notes` in ground-truth flag genuinely-arguable calls. Those are
 * encoded below (TOP_PARTIAL / MISS_EXCUSED / HEALTH_PARTIAL / RETRACTED), each quoting the note
 * that authorises it. A sanctioned alternative is NOT a hard hallucination.
 *
 * Node 24 built-ins only. Spike artifact; nothing imports it in production. score.test.mjs imports
 * the exported scoring functions to drive mutation tests against synthetic fixtures.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Schema shape (mirrors schema.ts; kept standalone like the old scorer)
// ---------------------------------------------------------------------------

/** The 23 scalar/enum top-level fields, in schema order. `healthSafety` is separate. */
export const TOP_FIELDS = [
  "heatingEquipmentType",
  "heatingFuel",
  "heatingManufacturer",
  "heatingModelNumber",
  "heatingModelYear",
  "heatingOutputCapacityBtuh",
  "coolingEquipmentType",
  "ductLocation",
  "ductSealing",
  "ductInsulation",
  "ductLeakageCfm25",
  "atticInsulationDepthIn",
  "atticInsulationType",
  "atticInsulationSpokenRValue",
  "wallInsulated",
  "wallConstruction",
  "blowerDoorCfm50",
  "windowGlazing",
  "windowFrame",
  "dhwFuel",
  "dhwSystemType",
  "dhwAgeBand",
  "combustionVentType",
];

/** The 11 named health & safety tests, in schema order. */
export const HEALTH_TESTS = [
  "ambientCo",
  "venting",
  "naturalConditionSpillage",
  "worstCaseDepressurization",
  "worstCaseSpillage",
  "draftPressure",
  "gasLeak",
  "moldMoisture",
  "asbestos",
  "lead",
  "electrical",
];

const ENVELOPE_KEYS = ["value", "confidence", "sourceSpan"];

/** Enum members from schema.ts. Bands are handled separately (see BANDS). */
export const ENUMS = {
  heatingEquipmentType: [
    "boiler",
    "furnace_central_ac",
    "central_heat_pump",
    "electric_resistance",
    "direct_heater",
    "stove_or_insert",
    "other",
  ],
  heatingFuel: [
    "electricity",
    "natural_gas",
    "propane",
    "fuel_oil",
    "pellets",
    "wood",
    "solar",
    "other",
  ],
  coolingEquipmentType: [
    "central_ac_standalone_ducts",
    "room_ac",
    "central_heat_pump",
    "evaporative_cooler_direct",
    "evaporative_cooler_ducted",
    "none",
    "other",
  ],
  ductLocation: [
    "attic_unconditioned",
    "basement_unconditioned",
    "crawlspace_unconditioned",
    "other",
  ],
  ductSealing: ["very_leaky", "somewhat_leaky", "well_sealed", "very_tight", "other"],
  ductInsulation: [
    "none",
    "duct_board_1_5in",
    "fiberglass_1_25in",
    "fiberglass_2in",
    "fiberglass_2_5in",
    "other",
  ],
  atticInsulationType: ["cellulose", "spray_foam", "fiberglass", "none", "other"],
  wallInsulated: ["yes", "poorly", "no", "other"],
  wallConstruction: ["concrete_block", "full_brick", "frame_2x6", "log", "straw_bale", "other"],
  windowGlazing: ["single_pane", "double_pane", "other"],
  windowFrame: ["metal", "vinyl", "wood_or_metal_clad", "other"],
  dhwFuel: ["electricity", "natural_gas", "fuel_oil", "propane", "solar", "other"],
  dhwSystemType: [
    "storage",
    "instantaneous",
    "heat_pump_water_heater",
    "space_heating_boiler_with_tank",
    "other",
  ],
  combustionVentType: [
    "induced_draft",
    "power_vented_at_unit",
    "power_vented_at_exterior",
    "direct_vented",
    "other",
  ],
};

/** Ordered band members; adjacency (|i-j| === 1) is a boundary error, not a flat wrong. */
export const BANDS = {
  atticInsulationDepthIn: ["0", "1-3", "4-6", "7-9", "10-12", "13-15", "16+"],
  dhwAgeBand: ["0-5", "6-10", "11-15", "16-20", "21-25", "26-30", "31-35", "36+"],
};

const STRING_FIELDS = new Set(["heatingManufacturer", "heatingModelNumber"]);
const NUMBER_FIELDS = new Set([
  "heatingModelYear",
  "heatingOutputCapacityBtuh",
  "ductLeakageCfm25",
  "blowerDoorCfm50",
  "atticInsulationSpokenRValue",
]);

/** number | string | band | enum — drives the comparison path. */
export function fieldKind(field) {
  if (field in BANDS) return "band";
  if (NUMBER_FIELDS.has(field)) return "number";
  if (STRING_FIELDS.has(field)) return "string";
  if (field in ENUMS) return "enum";
  return "enum"; // unreachable for known fields
}

// ---------------------------------------------------------------------------
// Partial-credit tables — each quotes the ground-truth note that authorises it
// ---------------------------------------------------------------------------

/**
 * For GT-null top-level fields: model values that are a SANCTIONED mild alternative
 * (a defensible non-null the note refuses to call a hard hallucination). Everything
 * else non-null on a GT-null slot is a hard hallucination.
 */
export const TOP_PARTIAL = {
  "01-attic-r-value-shell": {
    wallConstruction: {
      soft: ["frame_2x6", "other"],
      note: "brick-veneer != full_brick; frame_2x6/other are mild, full_brick is a WRONG member",
    },
  },
  "03-quick-exterior-short": {
    windowGlazing: {
      soft: ["double_pane"],
      note: "leans double pane but declines to commit; double_pane is wrong-but-grounded, not invented",
    },
  },
  "06-homeowner-crosstalk": {
    combustionVentType: {
      soft: ["other"],
      note: "natural draft is not one of the 4 members; other is defensible, a named member is wrong",
    },
  },
  "07-combustion-safety": {
    combustionVentType: {
      soft: ["other"],
      note: "shared B-vent is atmospheric; other is defensible, a named member is wrong",
    },
  },
  "12-wrong-field-old-unit": {
    combustionVentType: {
      soft: ["other", "direct_vented"],
      note: "condensing implies sealed but no vent token was spoken; direct_vented is a mild grounded-inference",
    },
  },
  "13-enum-paraphrase": {
    coolingEquipmentType: {
      soft: ["other"],
      note: "shared-duct AC is captured by furnace_central_ac; other is mild, central_ac_standalone_ducts is a WRONG member",
    },
  },
};

/** GT non-null but the note calls a model `null` an ACCEPTABLE miss (excluded from miss numerator). */
export const MISS_EXCUSED = {
  "03-quick-exterior-short": {
    wallConstruction: {
      note: 'frame_2x6 from "looks like a two-by-six frame"; null is a defensible miss, not a hallucination',
    },
  },
};

/** Retracted values (last-value-wins): a model emitting these is WRONG, tagged `retracted`. */
export const RETRACTED = {
  "11-ambiguous-attic": {
    heatingEquipmentType: ["boiler"],
    atticInsulationSpokenRValue: [11],
  },
};

/** Health-matrix per-slot overrides. Only where a note carves out a special reading. */
export const HEALTH_PARTIAL = {
  "07-combustion-safety": {
    worstCaseDepressurization: {
      softPass: true,
      note: "-50 Pa was the METHOD for the spillage test; reading it as a passed depressurization is a mild reading, not a hallucinated pass (failed/warning are wrong)",
    },
  },
};

// ---------------------------------------------------------------------------
// Small helpers (number parsing / normalization adapted from the old scorer)
// ---------------------------------------------------------------------------

const pct = (n, d) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const fixed3 = (n) => (n === null || n === undefined ? "  n/a" : n.toFixed(3));
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);
const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Enum/string token fold: "Gas Furnace" and "gas-furnace" both become "gas_furnace". */
export const normToken = (s) =>
  String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/** Alphanumeric-only fold for free strings: "TUD-100" and "TUD100" both become "tud100". */
const normStr = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/** Loose text normalization for near-miss span detection. */
const normText = (s) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

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
    /\b(cfm ?50|cfm ?25|ach ?50|cfm|ach|pa|percent|years?|yrs?|ppm|btu\/?h?|btu)\b/g,
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

// ---------------------------------------------------------------------------
// Value comparison (both non-null)
// ---------------------------------------------------------------------------

/**
 * Compare a GT value and a model value for a field, given both are non-null.
 * Returns { verdict: 'correct'|'wrong', tag, detail }.
 *   tag ∈ 'match' | 'wrong-member' | 'other-dump' | 'invalid-enum' | 'boundary' | 'retracted' | 'number' | 'string'
 */
export function compareValue(slug, field, gtValue, modelValue) {
  const kind = fieldKind(field);
  const retracted = (RETRACTED[slug]?.[field] ?? []).map((x) =>
    typeof x === "string" ? normToken(x) : x,
  );

  if (kind === "number") {
    const a = parseNumberish(gtValue);
    const b = parseNumberish(modelValue);
    if (b === null)
      return {
        verdict: "wrong",
        tag: "number",
        detail: `unparseable ${JSON.stringify(modelValue)}`,
      };
    if (a !== null && numbersNear(a, b))
      return { verdict: "correct", tag: "number", detail: "numeric match" };
    if (retracted.some((r) => typeof r === "number" && numbersNear(r, b))) {
      return {
        verdict: "wrong",
        tag: "retracted",
        detail: `retracted value ${b} (last-value-wins)`,
      };
    }
    return { verdict: "wrong", tag: "number", detail: `expected ${a}, got ${b}` };
  }

  if (kind === "string") {
    const a = normStr(gtValue);
    const b = normStr(modelValue);
    if (a === b || (a.length > 2 && b.length > 2 && (a.includes(b) || b.includes(a)))) {
      return { verdict: "correct", tag: "string", detail: "string match" };
    }
    return {
      verdict: "wrong",
      tag: "string",
      detail: `expected ${JSON.stringify(gtValue)}, got ${JSON.stringify(modelValue)}`,
    };
  }

  if (kind === "band") {
    const members = BANDS[field].map(normToken);
    const a = normToken(gtValue);
    const b = normToken(modelValue);
    if (a === b) return { verdict: "correct", tag: "match", detail: "band match" };
    const ai = members.indexOf(a);
    const bi = members.indexOf(b);
    if (ai !== -1 && bi !== -1 && Math.abs(ai - bi) === 1) {
      return {
        verdict: "wrong",
        tag: "boundary",
        detail: `off-by-one band: expected ${gtValue}, got ${modelValue}`,
      };
    }
    return {
      verdict: "wrong",
      tag: bi === -1 ? "invalid-band" : "wrong-member",
      detail: `expected ${gtValue}, got ${modelValue}`,
    };
  }

  // enum
  const members = ENUMS[field] ?? [];
  const a = normToken(gtValue);
  const b = normToken(modelValue);
  if (a === b) return { verdict: "correct", tag: "match", detail: "enum match" };
  if (retracted.includes(b))
    return {
      verdict: "wrong",
      tag: "retracted",
      detail: `retracted value "${modelValue}" (last-value-wins)`,
    };
  if (b === "other")
    return {
      verdict: "wrong",
      tag: "other-dump",
      detail: `dumped to other; expected "${gtValue}"`,
    };
  if (!members.includes(b))
    return {
      verdict: "wrong",
      tag: "invalid-enum",
      detail: `"${modelValue}" is not a member of ${field}`,
    };
  return {
    verdict: "wrong",
    tag: "wrong-member",
    detail: `expected "${gtValue}", got "${modelValue}"`,
  };
}

// ---------------------------------------------------------------------------
// sourceSpan classification
// ---------------------------------------------------------------------------

/** Verbatim per README §7: transcript.includes(span), normalising only trailing whitespace. */
export function spanIsVerbatim(span, transcript) {
  if (typeof span !== "string") return false;
  if (transcript.includes(span)) return true;
  return transcript.includes(span.replace(/\s+$/, ""));
}

/** Classify a non-verbatim span as near-miss (paraphrase/cleaned/joined) vs wholly fabricated. */
export function classifySpan(span, transcript) {
  if (spanIsVerbatim(span, transcript)) return { status: "verbatim", detail: "exact substring" };
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
// Result loading (robust to fences / prose / malformed)
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

/** Read a leaf envelope defensively. Returns { value, confidence, span, envErrors }. */
function readLeaf(cell, label) {
  const envErrors = [];
  if (cell === undefined)
    return { value: null, confidence: null, span: null, missing: true, envErrors };
  if (cell === null || typeof cell !== "object" || Array.isArray(cell)) {
    envErrors.push(`${label}: not a {value,confidence,sourceSpan} object`);
    return { value: null, confidence: null, span: null, envErrors };
  }
  const keys = Object.keys(cell);
  for (const k of ENVELOPE_KEYS) if (!keys.includes(k)) envErrors.push(`${label}: missing "${k}"`);
  for (const k of keys)
    if (!ENVELOPE_KEYS.includes(k)) envErrors.push(`${label}: extra key "${k}"`);
  const value = cell.value ?? null;
  let confidence = typeof cell.confidence === "number" ? cell.confidence : null;
  if (cell.confidence !== undefined && confidence === null)
    envErrors.push(`${label}: confidence is not a number`);
  const span = typeof cell.sourceSpan === "string" ? cell.sourceSpan : null;
  if (cell.sourceSpan !== undefined && cell.sourceSpan !== null && span === null) {
    envErrors.push(`${label}: sourceSpan is not a string or null`);
  }
  return { value, confidence, span, envErrors };
}

// ---------------------------------------------------------------------------
// Core scoring for one transcript
// ---------------------------------------------------------------------------

/** Fresh, zeroed counts structure. */
function emptyCounts() {
  return {
    // top-level null/non-null
    gtNull: 0,
    gtNonNull: 0,
    correctNull: 0,
    hallucinationHard: 0,
    hallucinationSoft: 0,
    miss: 0,
    missExcused: 0,
    bothNonNull: 0,
    correct: 0,
    wrong: 0,
    rvalueConversion: 0,
    // enum slice
    enumGtMember: 0,
    enumCorrect: 0,
    enumWrongMember: 0,
    enumOtherDump: 0,
    enumInvalid: 0,
    enumMiss: 0,
    // band slice
    bandGt: 0,
    bandCorrect: 0,
    bandBoundary: 0,
    bandWrong: 0,
    bandMiss: 0,
    // spans
    spanChecked: 0,
    spanVerbatim: 0,
    spanNearMiss: 0,
    spanFabricated: 0,
    spanMissing: 0,
    // health
    hGtNull: 0,
    hCorrectNull: 0,
    hSilentNotTested: 0,
    hHallucinatedPass: 0,
    hHallucinatedProblem: 0,
    hSoftPass: 0,
    hGtState: 0,
    hCorrectState: 0,
    hWrongState: 0,
    hMiss: 0,
    hSoftMiss: 0,
    hCleanDropped: 0,
    hGtPassed: 0,
    hGtPassedCorrect: 0,
    hGtPassedDropped: 0,
  };
}

/**
 * Score one transcript.
 * @param slug         transcript slug
 * @param gt           the parsed ground-truth object ({ fields: {...}, notes })
 * @param transcript   raw transcript text
 * @param model        parsed model output object, or null when missing/malformed
 * @param loadProblem  optional string describing why model is null
 */
export function scoreTranscript(slug, gt, transcript, model, loadProblem = null) {
  const r = {
    slug,
    status: model ? "scored" : "unscored",
    problem: loadProblem,
    counts: emptyCounts(),
    conformance: { missingKeys: [], extraKeys: [], envelopeErrors: [] },
    hallucinations: [],
    softAlternatives: [],
    misses: [],
    excused: [],
    wrong: [],
    badSpans: [],
    axis: null,
    health: [],
    confidences: { correct: [], wrong: [], correctNull: [], hallucinated: [] },
  };
  const gf = gt.fields;

  // GT-side counts always available (even for unscored, so denominators are honest).
  for (const f of TOP_FIELDS) {
    if (gf[f].value === null) r.counts.gtNull++;
    else r.counts.gtNonNull++;
  }
  for (const t of HEALTH_TESTS) {
    if (gf.healthSafety[t].value === null) r.counts.hGtNull++;
    else r.counts.hGtState++;
  }

  if (!model) return r; // whole-transcript miss handled at aggregate

  r.conformance.missingKeys = [...TOP_FIELDS, "healthSafety"].filter((k) => !(k in model));
  r.conformance.extraKeys = Object.keys(model).filter(
    (k) => !TOP_FIELDS.includes(k) && k !== "healthSafety",
  );

  const rvalueOnly =
    gf.atticInsulationDepthIn.value === null && gf.atticInsulationSpokenRValue.value !== null;

  // ---- top-level fields ----
  for (const f of TOP_FIELDS) {
    const gtValue = gf[f].value;
    const leaf = readLeaf(model[f], f);
    r.conformance.envelopeErrors.push(...leaf.envErrors);
    const { value: mv, confidence, span } = leaf;

    const kind = fieldKind(f);
    const partial = TOP_PARTIAL[slug]?.[f];

    // null / non-null agreement
    if (gtValue === null && mv === null) {
      r.counts.correctNull++;
      if (confidence !== null) r.confidences.correctNull.push(confidence);
    } else if (gtValue === null && mv !== null) {
      const softSet = (partial?.soft ?? []).map(normToken);
      const isSoft = softSet.includes(normToken(mv));
      const isRvalueConv = f === "atticInsulationDepthIn" && rvalueOnly;
      if (isRvalueConv) r.counts.rvalueConversion++;
      if (isSoft) {
        r.counts.hallucinationSoft++;
        r.softAlternatives.push({ field: f, value: mv, confidence, note: partial.note });
      } else {
        r.counts.hallucinationHard++;
        r.hallucinations.push({
          field: f,
          value: mv,
          confidence,
          sourceSpan: span,
          rvalueConversion: isRvalueConv,
          note: gt.notes?.[f] ?? null,
        });
        if (confidence !== null) r.confidences.hallucinated.push(confidence);
      }
    } else if (gtValue !== null && mv === null) {
      const excused = MISS_EXCUSED[slug]?.[f];
      if (excused) {
        r.counts.missExcused++;
        r.excused.push({ field: f, expected: gtValue, note: excused.note });
      } else {
        r.counts.miss++;
        r.misses.push({ field: f, expected: gtValue, span });
        if (kind === "enum") r.counts.enumMiss++;
        if (kind === "band") r.counts.bandMiss++;
      }
    } else {
      // both non-null
      r.counts.bothNonNull++;
      const cmp = compareValue(slug, f, gtValue, mv);
      const ok = cmp.verdict === "correct";
      if (ok) {
        r.counts.correct++;
        if (confidence !== null) r.confidences.correct.push(confidence);
      } else {
        r.counts.wrong++;
        r.wrong.push({
          field: f,
          expected: gtValue,
          got: mv,
          tag: cmp.tag,
          detail: cmp.detail,
          confidence,
        });
        if (confidence !== null) r.confidences.wrong.push(confidence);
      }
      // enum slice
      if (kind === "enum") {
        r.counts.enumGtMember++;
        if (ok) r.counts.enumCorrect++;
        else if (cmp.tag === "other-dump") r.counts.enumOtherDump++;
        else if (cmp.tag === "wrong-member" || cmp.tag === "retracted") r.counts.enumWrongMember++;
        else r.counts.enumInvalid++;
      }
      // band slice
      if (kind === "band") {
        r.counts.bandGt++;
        if (ok) r.counts.bandCorrect++;
        else if (cmp.tag === "boundary") r.counts.bandBoundary++;
        else r.counts.bandWrong++;
      }
    }

    // span validity for any non-null span (report non-null-value spans as the headline)
    if (span !== null) {
      const c = classifySpan(span, transcript);
      if (mv !== null) {
        r.counts.spanChecked++;
        if (c.status === "verbatim") r.counts.spanVerbatim++;
        else {
          if (c.status === "near-miss") r.counts.spanNearMiss++;
          else r.counts.spanFabricated++;
          r.badSpans.push({ field: f, value: mv, span, status: c.status, detail: c.detail });
        }
      } else if (c.status === "fabricated") {
        // fabricated quote on an explicit-decline null — still a provenance defect
        r.badSpans.push({
          field: f,
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
        field: f,
        value: mv,
        span: null,
        status: "missing",
        detail: "non-null value with no sourceSpan",
      });
    }
  }

  // ---- health matrix ----
  const hleaf = readLeaf(model.healthSafety, "healthSafety");
  const hobj =
    hleaf.value === undefined ||
    typeof model.healthSafety !== "object" ||
    model.healthSafety === null ||
    Array.isArray(model.healthSafety)
      ? {}
      : model.healthSafety;
  if (
    model.healthSafety !== undefined &&
    (typeof model.healthSafety !== "object" ||
      model.healthSafety === null ||
      Array.isArray(model.healthSafety))
  ) {
    r.conformance.envelopeErrors.push("healthSafety: not a nested object of test envelopes");
  }
  const hMissingKeys = HEALTH_TESTS.filter((t) => !(t in hobj));
  const hExtraKeys = Object.keys(hobj).filter((k) => !HEALTH_TESTS.includes(k));
  if (hMissingKeys.length)
    r.conformance.envelopeErrors.push(`healthSafety missing tests: ${hMissingKeys.join(", ")}`);
  if (hExtraKeys.length)
    r.conformance.envelopeErrors.push(`healthSafety extra tests: ${hExtraKeys.join(", ")}`);

  for (const t of HEALTH_TESTS) {
    const gtVal = gf.healthSafety[t].value;
    const leaf = readLeaf(hobj[t], `healthSafety.${t}`);
    r.conformance.envelopeErrors.push(...leaf.envErrors);
    const mv = leaf.value;
    const span = leaf.span;
    const partial = HEALTH_PARTIAL[slug]?.[t];

    let cat;
    if (gtVal === null) {
      if (mv === null) cat = "correctNull";
      else if (mv === "not_tested") cat = "silentNotTested";
      else if (mv === "passed") cat = partial?.softPass ? "softPass" : "hallucinatedPass";
      else cat = "hallucinatedProblem"; // failed/warning invented
    } else {
      if (mv === null)
        cat = gtVal === "not_tested" ? "softMiss" : gtVal === "passed" ? "cleanDropped" : "miss";
      else if (mv === gtVal) cat = "correctState";
      else if (mv === "passed")
        cat = "hallucinatedPass"; // asserted pass where truth isn't passed
      else cat = "wrongState";
    }

    switch (cat) {
      case "correctNull":
        r.counts.hCorrectNull++;
        break;
      case "silentNotTested":
        r.counts.hSilentNotTested++;
        break;
      case "hallucinatedPass":
        r.counts.hHallucinatedPass++;
        break;
      case "hallucinatedProblem":
        r.counts.hHallucinatedProblem++;
        break;
      case "softPass":
        r.counts.hSoftPass++;
        break;
      case "correctState":
        r.counts.hCorrectState++;
        break;
      case "wrongState":
        r.counts.hWrongState++;
        break;
      case "miss":
        r.counts.hMiss++;
        break;
      case "softMiss":
        r.counts.hSoftMiss++;
        break;
      case "cleanDropped":
        r.counts.hCleanDropped++;
        break;
    }
    if (gtVal === "passed") {
      r.counts.hGtPassed++;
      if (cat === "correctState") r.counts.hGtPassedCorrect++;
      if (cat === "cleanDropped") r.counts.hGtPassedDropped++;
    }
    if (
      ["hallucinatedPass", "hallucinatedProblem", "wrongState", "miss", "cleanDropped"].includes(
        cat,
      )
    ) {
      r.health.push({ test: t, gt: gtVal, got: mv, category: cat });
    }

    // span validity for health leaves too
    if (span !== null) {
      const c = classifySpan(span, transcript);
      if (mv !== null) {
        r.counts.spanChecked++;
        if (c.status === "verbatim") r.counts.spanVerbatim++;
        else {
          if (c.status === "near-miss") r.counts.spanNearMiss++;
          else r.counts.spanFabricated++;
          r.badSpans.push({
            field: `healthSafety.${t}`,
            value: mv,
            span,
            status: c.status,
            detail: c.detail,
          });
        }
      } else if (c.status === "fabricated") {
        r.badSpans.push({
          field: `healthSafety.${t}`,
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
        field: `healthSafety.${t}`,
        value: mv,
        span: null,
        status: "missing",
        detail: "non-null state with no sourceSpan",
      });
    }

    // confidence buckets for health (correct state vs wrong)
    if (leaf.confidence !== null) {
      if (cat === "correctState") r.confidences.correct.push(leaf.confidence);
      else if (cat === "correctNull") r.confidences.correctNull.push(leaf.confidence);
      else if (cat === "hallucinatedPass" || cat === "hallucinatedProblem")
        r.confidences.hallucinated.push(leaf.confidence);
      else if (cat === "wrongState") r.confidences.wrong.push(leaf.confidence);
    }
  }

  // ---- axis-split (heating equipment vs fuel) ----
  r.axis = scoreAxis(slug, gf, model);

  return r;
}

/** Axis-split confusion for the heating equipment/fuel pair on system-stated transcripts. */
function scoreAxis(slug, gf, model) {
  const eqGt = gf.heatingEquipmentType.value;
  if (eqGt === null) return null; // no heating system stated
  const fuelGt = gf.heatingFuel.value;
  const eqLeaf = readLeaf(model.heatingEquipmentType, "heatingEquipmentType");
  const fuelLeaf = readLeaf(model.heatingFuel, "heatingFuel");
  const eqM = eqLeaf.value;
  const fuelM = fuelLeaf.value;

  const eqCorrect =
    eqM !== null && compareValue(slug, "heatingEquipmentType", eqGt, eqM).verdict === "correct";
  const fuelCorrect =
    fuelGt !== null &&
    fuelM !== null &&
    compareValue(slug, "heatingFuel", fuelGt, fuelM).verdict === "correct";

  let category;
  if (fuelGt === null) {
    // silent-drop transcript (08): the correct behaviour is fuel null.
    if (fuelM === null) category = eqCorrect ? "silentDropRespected" : "silentDropEqWrong";
    else category = "fuelInvented"; // model invented a fuel that was never stated
  } else if (eqCorrect && fuelCorrect) {
    category = "bothCorrect";
  } else if (eqCorrect && fuelM === null) {
    category = "fuelDropped"; // THE predicted #1 failure
  } else if (eqCorrect && !fuelCorrect) {
    category = "fuelWrongMember";
  } else if (!eqCorrect && normToken(String(eqM)) === "other") {
    category = "axisConfused"; // fuel likely folded into an `other` equipment token
  } else {
    category = "eqWrongMember";
  }
  return { slug, eqGt, fuelGt, eqM, fuelM, eqCorrect, fuelCorrect, category };
}

// ---------------------------------------------------------------------------
// Test helper: build a "perfect" model output by copying GT and adding confidence.
// ---------------------------------------------------------------------------

export function buildPerfectModel(gt, confidence = 0.9) {
  const out = {};
  for (const f of TOP_FIELDS) {
    const { value, sourceSpan } = gt.fields[f];
    out[f] = { value, confidence, sourceSpan: sourceSpan ?? null };
  }
  out.healthSafety = {};
  for (const t of HEALTH_TESTS) {
    const { value, sourceSpan } = gt.fields.healthSafety[t];
    out.healthSafety[t] = { value, confidence, sourceSpan: sourceSpan ?? null };
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

  const axisRows = scored.map((r) => r.axis).filter(Boolean);
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
    .sort();

  const reports = [];
  for (const slug of slugs) {
    const gt = JSON.parse(readFileSync(join(GT_DIR, `${slug}.json`), "utf8"));
    const transcript = readFileSync(join(TRANSCRIPT_DIR, `${slug}.txt`), "utf8");
    const loaded = loadResult(resultsDir, slug);
    reports.push(scoreTranscript(slug, gt, transcript, loaded.data, loaded.problem));
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
    `coverage    : ${scored.length}/${reports.length} transcripts scored` +
      (unscored.length
        ? `  (${unscored.length} missing/malformed — counted as whole-transcript miss)`
        : ""),
  );
  if (unscored.length) {
    console.log(
      "!! PARTIAL RUN — miss-side numbers include the unscored transcripts' stated values.",
    );
  }

  // 1. HALLUCINATION
  console.log("");
  line();
  console.log(
    "1. HALLUCINATION — non-null emitted where GT is null (23 top-level fields)  [HEADLINE]",
  );
  line();
  console.log(
    `   hard hallucination rate : ${padL(pct(totals.hallucinationHard, totals.gtNull), 7)}` +
      `  (${totals.hallucinationHard}/${totals.gtNull} GT-null slots)`,
  );
  console.log(
    `   sanctioned alternatives : ${totals.hallucinationSoft}` +
      `  (defensible non-nulls the notes refuse to call hard hallucinations)`,
  );
  console.log(
    `   R-value -> band inventions: ${totals.rvalueConversion}` +
      `  (forbidden R->depth conversion; a band invented from a spoken R-value)`,
  );
  console.log(
    "   !! Read against the miss rate below — an all-null output scores 0% here and is useless.",
  );

  // 2. MISS
  console.log("");
  line();
  console.log("2. MISS — null emitted where GT has a value (23 top-level fields)");
  line();
  const missDen = totals.gtNonNull - totals.missExcused;
  console.log(
    `   miss rate : ${padL(pct(totals.miss, missDen), 7)}` +
      `  (${totals.miss}/${missDen} stated values left null; ${totals.missExcused} excused by notes)`,
  );
  console.log(
    `   accuracy on both-non-null : ${padL(pct(totals.correct, totals.correct + totals.wrong), 7)}` +
      `  (${totals.correct}/${totals.correct + totals.wrong} correct)`,
  );

  // 3. AXIS-SPLIT
  console.log("");
  line();
  console.log("3. AXIS-SPLIT — heating equipment vs fuel (system-stated transcripts)");
  line();
  const fusedRows = axisRows.filter((a) => a.fuelGt !== null);
  const bothCorrect = axisTally.bothCorrect ?? 0;
  console.log(
    `   both-correct rate : ${padL(pct(bothCorrect, fusedRows.length), 7)}` +
      `  (${bothCorrect}/${fusedRows.length} stated equipment+fuel split onto both axes)`,
  );
  console.log(
    `   fuel DROPPED (equip right, fuel null when stated) : ${axisTally.fuelDropped ?? 0}   <- the #1 predicted failure`,
  );
  console.log(
    `   fuel INVENTED on the silent-drop transcript       : ${axisTally.fuelInvented ?? 0}   <- fuel emitted where none stated (08)`,
  );
  console.log(
    `   axis-confused / eq-wrong / fuel-wrong-member      : ${axisTally.axisConfused ?? 0} / ${axisTally.eqWrongMember ?? 0} / ${axisTally.fuelWrongMember ?? 0}`,
  );
  console.log(
    `   silent-drop respected (08 fuel left null)         : ${axisTally.silentDropRespected ?? 0}`,
  );

  // 4. ENUM-MAPPING
  console.log("");
  line();
  console.log("4. ENUM-MAPPING — GT is a specific member (other = WRONG)");
  line();
  console.log(
    `   member accuracy : ${padL(pct(totals.enumCorrect, totals.enumGtMember), 7)}` +
      `  (${totals.enumCorrect}/${totals.enumGtMember} correct; on model-emitted enums)`,
  );
  console.log(
    `   wrong-member ${totals.enumWrongMember}   other-dump ${totals.enumOtherDump}   ` +
      `invalid ${totals.enumInvalid}   dropped-to-null ${totals.enumMiss}`,
  );

  // 5. BAND-MAPPING
  console.log("");
  line();
  console.log("5. BAND-MAPPING — depth/age band from a stated number");
  line();
  console.log(
    `   band accuracy : ${padL(pct(totals.bandCorrect, totals.bandGt), 7)}` +
      `  (${totals.bandCorrect}/${totals.bandGt} correct band)`,
  );
  console.log(
    `   boundary (off-by-one bucket) ${totals.bandBoundary}   flat-wrong ${totals.bandWrong}   dropped-to-null ${totals.bandMiss}`,
  );
  console.log(`   R-value -> band inventions (forbidden conversion) : ${totals.rvalueConversion}`);

  // 6. HEALTH MATRIX
  console.log("");
  line();
  console.log("6. HEALTH-MATRIX STATE — 11 tests x transcripts");
  line();
  const hCorrect = totals.hCorrectNull + totals.hCorrectState;
  const hWrong =
    totals.hHallucinatedPass +
    totals.hHallucinatedProblem +
    totals.hCleanDropped +
    totals.hMiss +
    totals.hWrongState;
  const hSoft = totals.hSilentNotTested + totals.hSoftMiss + totals.hSoftPass;
  console.log(
    `   state accuracy : ${padL(pct(hCorrect, hCorrect + hWrong), 7)}` +
      `  (${hCorrect} correct / ${hWrong} wrong; ${hSoft} soft/acceptable excluded)`,
  );
  console.log(
    `   >> HALLUCINATED PASS (passed where truth is not passed) : ${totals.hHallucinatedPass}   <- the crux`,
  );
  console.log(
    `   >> CLEAN DROPPED TO NULL (passed lost)                  : ${totals.hCleanDropped}  of ${totals.hGtPassed} clean results`,
  );
  console.log(
    `      clean correctly kept as passed : ${totals.hGtPassedCorrect}/${totals.hGtPassed}`,
  );
  console.log(
    `      hallucinated problem (failed/warning invented) ${totals.hHallucinatedProblem}   wrong-state ${totals.hWrongState}   miss ${totals.hMiss}`,
  );
  console.log(
    `      soft: silence->not_tested ${totals.hSilentNotTested}   skip->null ${totals.hSoftMiss}   mild-pass ${totals.hSoftPass}`,
  );

  // 7. SOURCESPAN
  console.log("");
  line();
  console.log("7. SOURCESPAN VALIDITY — verbatim substring of the transcript");
  line();
  console.log(
    `   verbatim rate : ${padL(pct(totals.spanVerbatim, totals.spanChecked), 7)}` +
      `  (${totals.spanVerbatim}/${totals.spanChecked} non-null values)`,
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
      !r.conformance.missingKeys.length &&
      !r.conformance.extraKeys.length &&
      !r.conformance.envelopeErrors.length,
  );
  console.log("");
  console.log(
    `   schema conformance : ${conformant.length}/${scored.length} outputs had exactly the keys and clean envelopes`,
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
    if (r.axis?.category === "fuelDropped") flags.push("FUELDROP");
    if (
      r.conformance.missingKeys.length ||
      r.conformance.extraKeys.length ||
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

  // detail sections
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
      `  ${pad(h.slug, 26)}${pad(h.field, 26)}= ${JSON.stringify(h.value)}  [conf ${h.confidence ?? "?"}]` +
      (h.rvalueConversion ? "  <R->band CONVERSION>" : "") +
      `\n      span: ${h.sourceSpan === null ? "(none)" : JSON.stringify(h.sourceSpan)}` +
      (h.note ? `\n      gt note: ${h.note}` : ""),
  );
  section(
    "SANCTIONED ALTERNATIVES — non-null the notes allow (NOT hard hallucinations)",
    scored.flatMap((r) => r.softAlternatives.map((s) => ({ ...s, slug: r.slug }))),
    (s) => `  ${pad(s.slug, 26)}${pad(s.field, 26)}= ${JSON.stringify(s.value)}  — ${s.note}`,
  );
  section(
    "AXIS-SPLIT rows",
    axisRows,
    (a) =>
      `  ${pad(a.slug, 26)}[${a.category}]  eq ${JSON.stringify(a.eqM)}/${JSON.stringify(a.eqGt)}  fuel ${JSON.stringify(a.fuelM)}/${JSON.stringify(a.fuelGt)}`,
  );
  section(
    "HEALTH deviations",
    scored.flatMap((r) => r.health.map((h) => ({ ...h, slug: r.slug }))),
    (h) =>
      `  ${pad(h.slug, 26)}${pad(h.test, 26)}[${h.category}] gt ${JSON.stringify(h.gt)} got ${JSON.stringify(h.got)}`,
  );
  section(
    "WRONG VALUES — both non-null, semantically different",
    scored.flatMap((r) => r.wrong.map((w) => ({ ...w, slug: r.slug }))),
    (w) =>
      `  ${pad(w.slug, 26)}${pad(w.field, 26)}[${w.tag}] ${w.detail}  [conf ${w.confidence ?? "?"}]`,
  );
  section(
    "MISSES — null where GT has a value",
    scored.flatMap((r) => r.misses.map((m) => ({ ...m, slug: r.slug }))),
    (m) => `  ${pad(m.slug, 26)}${pad(m.field, 26)}expected ${JSON.stringify(m.expected)}`,
  );
  section(
    "INVALID sourceSpans — not a verbatim substring",
    scored.flatMap((r) => r.badSpans.map((b) => ({ ...b, slug: r.slug }))),
    (b) =>
      `  ${pad(b.slug, 26)}${pad(b.field, 26)}[${b.status}] ${b.detail}\n` +
      `      value: ${JSON.stringify(b.value)}   span: ${JSON.stringify(b.span)}`,
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

  // machine-readable
  const outPath = join(HERE, "results", `${dirName}-score.json`);
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: dirName,
        resultsDir,
        coverage: {
          total: reports.length,
          scored: scored.length,
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

// Run as CLI only when invoked directly (so score.test.mjs can import cleanly).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
