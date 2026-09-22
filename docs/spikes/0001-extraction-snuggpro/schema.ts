/**
 * Extraction schema for the Snugg Pro energy-audit capture model — the *bounded*
 * pilot field set, built against the REAL Snugg Pro data model documented in
 * docs/implementation/12-snuggpro-data-model.md, not an invented schema.
 *
 * An earlier, throwaway extraction attempt scored well against a
 * convenient schema; doc 12 proved that schema is structurally wrong on real Snugg
 * Pro data in four specific ways, and that "just pass the schema" skips the actual
 * work — a normalization layer mapping spoken form -> Snugg enum / depth band /
 * split axis. This schema puts those four hazards back IN, on purpose:
 *
 *   1. FUEL IS A SEPARATE AXIS. `heatingEquipmentType` (Boiler / Furnace / Heat
 *      Pump / ...) and `heatingFuel` (Natural Gas / Fuel Oil / ...) are two fields.
 *      "Oil boiler" decomposes into { boiler, fuel_oil }. The two axes are never
 *      fused into one `oil_boiler` token — doing so is the exact error doc 12 §1
 *      calls out in the old `HeatingSystemType` enum.
 *   2. ATTIC INSULATION IS A DEPTH BAND, not an R-value number. Snugg stores an
 *      inches bucket ("10-12") plus a material. The auditor SAYS "R-38"; there is
 *      no R-value write target. `atticInsulationDepthIn` is a band enum.
 *   3. HEALTH & SAFETY IS A FIXED 4-STATE MATRIX, not free text. ~11 named tests,
 *      each passed / failed / warning / not_tested. "CO was clean" is `passed`;
 *      a test never mentioned is `null` (see the note on `healthSafety`).
 *   4. EFFICIENCY (AFUE / SEER / HSPF) IS NOT A CAPTURE FIELD. The field sheet
 *      records make / model / model-year / BTU output; efficiency is DERIVED by
 *      lookup, not typed. So there is no `heatingAfue` slot. We capture what is
 *      actually captured: manufacturer, model #, model year, output capacity.
 *
 * This file is a spike artifact, not production code. It is deliberately standalone
 * (no import from @azx/ribo-core) so it can be handed to any extractor as-is, the
 * way the old spike's schema was.
 *
 * Contract, restated from docs 03 + 05 so it travels with the file:
 *
 *   1. Every field is `nullable` + REQUIRED. Never `.optional()`. The model must
 *      explicitly emit `null` for "not mentioned" rather than silently omitting the
 *      key. The anti-hallucination rule enforced at the schema level.
 *   2. Every field is wrapped in a provenance envelope: `{ value, confidence,
 *      sourceSpan }`.
 *   3. Strict-structured-output compatible: no top-level `.optional()`, no unions
 *      of objects, no numeric/string constraint keywords (`minimum` / `maximum` /
 *      `pattern` are rejected by strict mode), all object shapes closed and all
 *      properties required. Nested objects (the health matrix) obey the same rules.
 *   4. Extract what was SAID; normalize in code. The enums below are the Snugg
 *      target vocabulary the LLM maps ONTO — but unit coercion, spoken-number ->
 *      int, and band bucketing given a number are a deterministic TypeScript pass
 *      that runs after extraction (see normalization.md).
 */

import { z } from "zod";

/**
 * Provenance envelope. `sourceSpan` must be a VERBATIM substring of the transcript
 * — it is what the review card shows the auditor as justification.
 *
 * `sourceSpan` is nullable independently of `value`: a field can legitimately have
 * `value: null` with a non-null `sourceSpan` when the auditor explicitly declined
 * to state it, or explicitly reported that something was not done or does not exist
 * ("no ducts, it's hydronic", "I couldn't get to the attic").
 *
 * `confidence` is a bare `z.number()` on purpose. 0..1 is the intent, but `.min()`
 * / `.max()` emit JSON Schema `minimum` / `maximum`, which strict structured-output
 * mode does not accept. Range-clamp in normalization.
 */
const Extracted = <T extends z.ZodTypeAny>(value: T) =>
  z
    .object({
      /** null = not stated in the transcript. Never a guess, never an inference. */
      value: value.nullable(),
      /** 0..1. Drives review-card flagging. Clamped during normalization. */
      confidence: z.number(),
      /** Verbatim transcript quote justifying `value`, or null. */
      sourceSpan: z.string().nullable(),
    })
    .strict();

// --- Enumerations -----------------------------------------------------------
// Values are the Snugg Pro field-sheet vocabulary from doc 12, snake_cased. They
// are the TARGET the LLM maps a spoken phrase onto — no auditor says
// "furnace_central_ac_shared_ducts" out loud. `other` exists so a real but
// unlisted answer is captured, not forced to `null` or to the nearest wrong member.

/**
 * HAZARD 1a — heating equipment, the EQUIPMENT axis only. Fuel lives in
 * `HeatingFuel`, a separate field. "Oil boiler" -> equipment `boiler`. Doc 12 §2.
 */
export const HeatingEquipmentType = z.enum([
  "boiler",
  "furnace_central_ac", // "Furnace / Central AC (shared ducts)"
  "central_heat_pump", // "Central Heat Pump (shared ducts)"
  "electric_resistance",
  "direct_heater",
  "stove_or_insert",
  "other",
]);

/**
 * HAZARD 1b — the FUEL axis, a field of its own (doc 12 §1/§2). Never merged into
 * the equipment name. "Oil boiler" -> fuel `fuel_oil`; "the propane furnace" ->
 * fuel `propane` + equipment `furnace_central_ac`.
 */
export const HeatingFuel = z.enum([
  "electricity",
  "natural_gas",
  "propane",
  "fuel_oil",
  "pellets",
  "wood",
  "solar",
  "other",
]);

export const CoolingEquipmentType = z.enum([
  "central_ac_standalone_ducts", // "Central AC with standalone ducts"
  "room_ac",
  "central_heat_pump", // shared with heating when it is a heat pump
  "evaporative_cooler_direct",
  "evaporative_cooler_ducted",
  "none",
  "other",
]);

export const DuctLocation = z.enum([
  "attic_unconditioned",
  "basement_unconditioned",
  "crawlspace_unconditioned",
  "other",
]);

/**
 * Snugg labels these by leakage %: "30% - Very leaky" ... "3% - Very tight". The
 * auditor says "pretty leaky" / "well sealed"; the LLM maps to the qualitative
 * member, code can attach the % later. The stored token is qualitative, not a
 * number the auditor spoke.
 */
export const DuctSealing = z.enum([
  "very_leaky", // 30%
  "somewhat_leaky", // 15%
  "well_sealed", // 6%
  "very_tight", // 3%
  "other",
]);

export const DuctInsulation = z.enum([
  "none",
  "duct_board_1_5in",
  "fiberglass_1_25in",
  "fiberglass_2in",
  "fiberglass_2_5in",
  "other",
]);

/**
 * HAZARD 2a — attic insulation as a DEPTH BAND in inches, not an R-value. Snugg's
 * options verbatim (doc 12 §3, row 12). The auditor almost always says an R-value
 * ("R-38"); mapping R-value -> a depth band is climate/material-dependent and
 * lossy, so it is NOT the LLM's job. Capture the band ONLY when the auditor states
 * a depth/thickness; when they state an R-value and no depth, this stays `null`
 * (and the spoken R-value is kept in `atticInsulationSpokenRValue` for the
 * deterministic pass / auditor to resolve). See prompt.md + normalization.md.
 */
export const AtticInsulationDepthBand = z.enum(["0", "1-3", "4-6", "7-9", "10-12", "13-15", "16+"]);

/** HAZARD 2b — the material, a separate enum from the depth (doc 12 row 13). */
export const AtticInsulationType = z.enum([
  "cellulose",
  "spray_foam",
  "fiberglass",
  "none",
  "other",
]);

/** 3-state, NOT a boolean (doc 12 row 14). "Some but thin" -> `poorly`. */
export const WallInsulated = z.enum(["yes", "poorly", "no", "other"]);

export const WallConstruction = z.enum([
  "concrete_block",
  "full_brick",
  "frame_2x6",
  "log",
  "straw_bale",
  "other",
]);

export const WindowGlazing = z.enum(["single_pane", "double_pane", "other"]);

export const WindowFrame = z.enum(["metal", "vinyl", "wood_or_metal_clad", "other"]);

export const DhwFuel = z.enum([
  "electricity",
  "natural_gas",
  "fuel_oil",
  "propane",
  "solar",
  "other",
]);

export const DhwSystemType = z.enum([
  "storage",
  "instantaneous", // tankless
  "heat_pump_water_heater",
  "space_heating_boiler_with_tank", // indirect
  "other",
]);

/** A banded age, like the attic depth — "about twelve years" -> "11-15" (doc 12 §4). */
export const DhwAgeBand = z.enum([
  "0-5",
  "6-10",
  "11-15",
  "16-20",
  "21-25",
  "26-30",
  "31-35",
  "36+",
]);

export const CombustionVentType = z.enum([
  "induced_draft",
  "power_vented_at_unit",
  "power_vented_at_exterior",
  "direct_vented",
  "other",
]);

/**
 * HAZARD 3 — the health & safety matrix state. A FIXED enum, not free text. Every
 * one of the ~11 named tests takes exactly one of these (doc 12 §4, row 24).
 *
 *   passed      — the test was run and came back clean/fine/no issues.
 *   failed      — the test was run and found a real problem.
 *   warning     — the test was run and the result is borderline / a caution.
 *   not_tested  — the auditor explicitly said the test was skipped / deferred /
 *                 could not be done.
 *
 * A test the auditor NEVER MENTIONS is `value: null` (the envelope's "absent"),
 * NOT `not_tested`. Distinguishing "explicitly skipped" from "never came up" is
 * information the review card wants; the deterministic write layer renders BOTH as
 * Snugg's `Not Tested` state (Snugg has no null), but the extraction keeps them
 * apart. See normalization.md for why this split is a hypothesis the corpus tests.
 */
export const HealthTestState = z.enum(["passed", "failed", "warning", "not_tested"]);

/**
 * The 11 named tests, verbatim set from doc 12 §4 / row 24. Each is its own
 * provenance envelope so the review card can show the auditor the exact quote that
 * set the state — "CO was clean" is the span behind `ambientCo: passed`.
 *
 * Closed object, every key required, per strict mode. This is one nested field on
 * the top-level schema, not eleven top-level fields.
 */
export const HealthSafetyMatrix = z
  .object({
    ambientCo: Extracted(HealthTestState),
    venting: Extracted(HealthTestState),
    naturalConditionSpillage: Extracted(HealthTestState),
    worstCaseDepressurization: Extracted(HealthTestState),
    worstCaseSpillage: Extracted(HealthTestState),
    draftPressure: Extracted(HealthTestState),
    gasLeak: Extracted(HealthTestState),
    moldMoisture: Extracted(HealthTestState),
    asbestos: Extracted(HealthTestState),
    lead: Extracted(HealthTestState),
    electrical: Extracted(HealthTestState),
  })
  .strict();

// --- The bounded field set --------------------------------------------------
// 23 scalar/enum top-level fields + the health matrix (11 named test states).

export const SnuggFieldsSchema = z
  .object({
    // --- Heating (HAZARD 1: fuel split onto its own axis) --------------------
    /** The EQUIPMENT axis only. "Oil boiler" -> `boiler`. Fuel goes in `heatingFuel`. */
    heatingEquipmentType: Extracted(HeatingEquipmentType),

    /**
     * The FUEL axis, independent of equipment. "Oil boiler" -> `fuel_oil`; "gas
     * pack" -> `natural_gas` (+ equipment `furnace_central_ac`). Never fold this
     * into the equipment name.
     */
    heatingFuel: Extracted(HeatingFuel),

    // --- Heating efficiency inputs (HAZARD 4: capture make/model/BTU, NOT AFUE) -
    /** Heating unit manufacturer as stated, e.g. "Carrier", "Weil-McLain". */
    heatingManufacturer: Extracted(z.string()),

    /** Heating unit model number / model name as stated. */
    heatingModelNumber: Extracted(z.string()),

    /** Heating unit model YEAR (the unit's year), e.g. 2011. Not the home's age. */
    heatingModelYear: Extracted(z.number()),

    /**
     * Rated heating output capacity in BTU/h, e.g. "eighty thousand BTU" -> 80000.
     * This is a real capture field; AFUE is NOT — do not record a spoken efficiency
     * ("ninety-two percent furnace") anywhere. There is deliberately no AFUE slot.
     */
    heatingOutputCapacityBtuh: Extracted(z.number()),

    // --- Cooling -------------------------------------------------------------
    /** Cooling equipment type. A heat pump used for both is `central_heat_pump`. */
    coolingEquipmentType: Extracted(CoolingEquipmentType),

    // --- Ductwork ------------------------------------------------------------
    /** Where the ducts run. */
    ductLocation: Extracted(DuctLocation),

    /** Qualitative duct tightness. "Pretty leaky" -> `very_leaky` / `somewhat_leaky`. */
    ductSealing: Extracted(DuctSealing),

    /** Duct insulation, the Snugg material/thickness member. */
    ductInsulation: Extracted(DuctInsulation),

    /** Duct leakage in CFM at 25 Pa (duct blaster). Not blower-door CFM50. */
    ductLeakageCfm25: Extracted(z.number()),

    // --- Attic (HAZARD 2: depth band + material, NOT R-value) ----------------
    /**
     * Attic insulation DEPTH BAND in inches. Set ONLY when the auditor states a
     * depth/thickness ("about six inches" -> `4-6`). When the auditor states an
     * R-value and no depth, leave this `null` and record the R-value in
     * `atticInsulationSpokenRValue` — the R->depth conversion is a reviewed
     * deterministic step, not an LLM guess. See prompt.md.
     */
    atticInsulationDepthIn: Extracted(AtticInsulationDepthBand),

    /** Attic insulation material. */
    atticInsulationType: Extracted(AtticInsulationType),

    /**
     * The spoken R-value, verbatim as a number, when the auditor gives one for the
     * attic ("R-38" -> 38). This is NOT a Snugg write target — it is a holding pen
     * so a real utterance is not lost while `atticInsulationDepthIn` stays honest.
     * The deterministic pass (or the auditor) resolves it into a depth band.
     */
    atticInsulationSpokenRValue: Extracted(z.number()),

    // --- Walls ---------------------------------------------------------------
    /** 3-state, not boolean. "Thin / some but not much" -> `poorly`. */
    wallInsulated: Extracted(WallInsulated),

    /** Wall construction type. */
    wallConstruction: Extracted(WallConstruction),

    // --- Air leakage ---------------------------------------------------------
    /**
     * Blower-door result in CFM at 50 Pa. Do NOT derive from ACH50, and do NOT put
     * an ACH50 or CFM25 reading here — those are different references.
     */
    blowerDoorCfm50: Extracted(z.number()),

    // --- Windows -------------------------------------------------------------
    /** Predominant glazing. Snugg has no triple-pane box; a triple is `other`. */
    windowGlazing: Extracted(WindowGlazing),

    /** Window frame material. "Clad" -> `wood_or_metal_clad`. */
    windowFrame: Extracted(WindowFrame),

    // --- Domestic hot water --------------------------------------------------
    /** DHW fuel — its own axis, same as heating. "Gas water heater" -> `natural_gas`. */
    dhwFuel: Extracted(DhwFuel),

    /** DHW system type. "Tankless" -> `instantaneous`; "indirect off the boiler" ->
     * `space_heating_boiler_with_tank`. */
    dhwSystemType: Extracted(DhwSystemType),

    /** DHW age BAND. "About twelve years" -> `11-15`. Banded, like the attic depth. */
    dhwAgeBand: Extracted(DhwAgeBand),

    // --- Combustion appliance zone ------------------------------------------
    /** Vent system type. "Power-vented water heater" -> `power_vented_at_unit`. */
    combustionVentType: Extracted(CombustionVentType),

    // --- Health & safety (HAZARD 3: fixed 4-state matrix) --------------------
    /**
     * The 11-test matrix. Each named test is passed / failed / warning /
     * not_tested, or `null` when the test never came up. "CO was clean" sets
     * `ambientCo.value = passed`; silence on asbestos is `asbestos.value = null`.
     * This replaces the old single free-text `safetyIssue`, which could hold
     * neither a matrix nor a clean result.
     */
    healthSafety: HealthSafetyMatrix,
  })
  .strict();

export type SnuggFields = z.infer<typeof SnuggFieldsSchema>;
