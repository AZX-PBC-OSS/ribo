/**
 * The Snugg Pro energy-audit capture field set — the *bounded* pilot fields,
 * built against the REAL Snugg Pro data model documented in
 * docs/implementation/12-snuggpro-data-model.md.
 *
 * TWO SHAPES LIVE HERE, and telling them apart is the whole point of this file
 * (design `r1.5-field-shape-contracts-design.md` §2.1–§2.3):
 *
 *   - `snuggValuesSchema` — the WRITABLE PATCH. What a review produces and what
 *     `write` sends to Snugg Pro. Hand-written, and the source of truth: every
 *     other shape here is derived from it. Every leaf is
 *     `X.nullable().optional()`, and both halves are load-bearing —
 *       * `.nullable()` because a `null` is a real, WRITTEN value: Snugg Pro's
 *         `Not Tested` state (see `HealthTestState` below). "Write this field
 *         as empty" is a different instruction from "leave this field alone".
 *       * `.optional()` because a REJECTED field must be absent from the patch
 *         entirely. `resolveReview` omits a rejected leaf, and a patch is what
 *         makes that well-defined: rejecting one leaf of 34 must still write
 *         the other 33, not fail the whole write.
 *
 *   - `snuggExtractionSchema` — what the MODEL is asked to produce. NOT
 *     hand-written: `enveloped()` derives it from the patch, stripping the
 *     `.optional()`/`.nullable()` that make the patch a patch and wrapping each
 *     leaf in `ribo-core`'s provenance envelope. The result is closed and fully
 *     required at every level, because `provenance.ts`'s anti-hallucination rule
 *     needs the model to emit an explicit `null` rather than omit a key.
 *
 * The two therefore differ in optionality BY CONSTRUCTION, and that is the
 * design rather than a leak. The derivation is pinned byte-for-byte by
 * `extraction-shape.test.ts` against a frozen JSON Schema fixture: the split
 * changed the types, not what is sent to the model.
 *
 * This is the production port of `spikes/extraction-snuggpro/schema.ts`, kept
 * structurally FAITHFUL to that spike on purpose: the spike's committed corpus +
 * ground-truth are the regression gate the extractor (Phase 4 Task 3) is judged
 * against, so any structural drift here silently breaks that gate. The enum
 * members, the field set and the nested health matrix are byte-faithful to the
 * spike; the envelope is now `ribo-core`'s `extractedSchema`, applied by
 * `enveloped()`, rather than a local copy of it.
 *
 * The schema puts the four Snugg Pro hazards IN, on purpose:
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
 * Contract, restated from docs 03 + 05 so it travels with the file. Note which
 * schema each rule is about — three of the four are properties of the DERIVED
 * extraction schema, which is exactly why it is derived rather than typed out:
 *
 *   1. In the EXTRACTION schema every field is `nullable` + REQUIRED, never
 *      `.optional()`. The model must explicitly emit `null` for "not mentioned"
 *      rather than silently omitting the key — the anti-hallucination rule
 *      enforced at the schema level. `enveloped()` is what guarantees it: the
 *      patch's optionality is stripped, not carried through.
 *   2. In the EXTRACTION schema every field is wrapped in a provenance envelope:
 *      `{ value, confidence, sourceSpan }` — `ribo-core`'s `extractedSchema`,
 *      which documents why `sourceSpan` is nullable independently of `value` and
 *      why `confidence` is a bare `z.number()`. Both matter here concretely: an
 *      auditor who says "no ducts, it's hydronic" or "I couldn't get to the
 *      attic" produces a `null` value WITH a verbatim span, and a `.min()`/
 *      `.max()` on `confidence` would emit the `minimum`/`maximum` keywords
 *      strict structured-output mode rejects (clamped in `normalization.ts`).
 *   3. The EXTRACTION schema is strict-structured-output compatible: no
 *      `.optional()` anywhere, no unions of objects, no numeric/string constraint
 *      keywords (`minimum` / `maximum` / `pattern` are rejected by strict mode),
 *      all object shapes closed and all properties required. Nested objects (the
 *      health matrix) obey the same rules. The PATCH is deliberately the opposite
 *      — open and optional at every level — and never reaches the model.
 *   4. Extract what was SAID; normalize in code. The enums below are the Snugg
 *      target vocabulary the LLM maps ONTO — but unit coercion, spoken-number ->
 *      int, and band bucketing given a number are a deterministic TypeScript pass
 *      that runs after extraction (see `normalization.ts`).
 */

import { enveloped } from "@azx/ribo-core";
import type { Enveloped } from "@azx/ribo-core";
import { z } from "zod";

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
 * deterministic pass / auditor to resolve). See prompt.md + normalization.ts.
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
 * A test the auditor NEVER MENTIONS is `null` (the envelope's "absent"), NOT
 * `not_tested`. Distinguishing "explicitly skipped" from "never came up" is
 * information the review card wants; the deterministic write layer renders BOTH as
 * Snugg's `Not Tested` state (Snugg has no null), but the extraction keeps them
 * apart. This is why the patch leaf is `.nullable()` and not merely `.optional()`:
 * a `null` here is an instruction to WRITE `Not Tested`, while an absent key means
 * "the reviewer rejected this — do not touch it in Snugg Pro at all". See
 * normalization.ts for why the passed/not_tested split is a hypothesis the corpus
 * tests.
 */
export const HealthTestState = z.enum(["passed", "failed", "warning", "not_tested"]);

/**
 * The 11 named tests, verbatim set from doc 12 §4 / row 24 — the PATCH shape: a
 * plain 4-state value per test, each `.nullable().optional()` like every other
 * leaf.
 *
 * It is one nested object on the field set, not eleven top-level fields, and
 * `enveloped()` RECURSES into it rather than wrapping it whole — so the derived
 * extraction schema carries eleven independent provenance envelopes, one per test,
 * and the review card can show the auditor the exact quote that set each state
 * ("CO was clean" is the span behind `ambientCo: passed`). One envelope over the
 * whole matrix would make the eleven tests un-reviewable individually, which is
 * the point of field-level review.
 *
 * NAME KEPT ON PURPOSE, though its meaning moved. Before the R1.5 patch/extraction
 * split this exported the ENVELOPED matrix; it now exports the PATCH one, while its
 * two siblings were renamed for exactly that kind of change (`SnuggFieldsSchema` ->
 * `snuggValuesSchema` + `snuggExtractionSchema`). The asymmetry is deliberate: those
 * two are the top-level field SHAPES a consumer chooses between, and the rename is
 * what forces that choice to be made consciously, whereas this is a component of the
 * patch with no extraction-side counterpart to be confused with — `enveloped()`
 * derives the matrix's extraction form inline and never exports it, so there is no
 * second `HealthSafetyMatrix` for this one to be mistaken for. Recorded here so a
 * later task does not rediscover it as a surprise; renaming it remains free
 * (pre-1.0, no external consumers) if a second adapter ever makes it ambiguous.
 */
export const HealthSafetyMatrix = z
  .object({
    ambientCo: HealthTestState.nullable().optional(),
    venting: HealthTestState.nullable().optional(),
    naturalConditionSpillage: HealthTestState.nullable().optional(),
    worstCaseDepressurization: HealthTestState.nullable().optional(),
    worstCaseSpillage: HealthTestState.nullable().optional(),
    draftPressure: HealthTestState.nullable().optional(),
    gasLeak: HealthTestState.nullable().optional(),
    moldMoisture: HealthTestState.nullable().optional(),
    asbestos: HealthTestState.nullable().optional(),
    lead: HealthTestState.nullable().optional(),
    electrical: HealthTestState.nullable().optional(),
  })
  .strict();

// --- The bounded field set, as a writable patch -----------------------------
// 23 scalar/enum top-level fields + the health matrix (11 named test states).
// Every leaf is `X.nullable().optional()` and every object is `.strict()`; see
// the file header for why both halves of that are load-bearing.

export const snuggValuesSchema = z
  .object({
    // --- Heating (HAZARD 1: fuel split onto its own axis) --------------------
    /** The EQUIPMENT axis only. "Oil boiler" -> `boiler`. Fuel goes in `heatingFuel`. */
    heatingEquipmentType: HeatingEquipmentType.nullable().optional(),

    /**
     * The FUEL axis, independent of equipment. "Oil boiler" -> `fuel_oil`; "gas
     * pack" -> `natural_gas` (+ equipment `furnace_central_ac`). Never fold this
     * into the equipment name.
     */
    heatingFuel: HeatingFuel.nullable().optional(),

    // --- Heating efficiency inputs (HAZARD 4: capture make/model/BTU, NOT AFUE) -
    /** Heating unit manufacturer as stated, e.g. "Carrier", "Weil-McLain". */
    heatingManufacturer: z.string().nullable().optional(),

    /** Heating unit model number / model name as stated. */
    heatingModelNumber: z.string().nullable().optional(),

    /** Heating unit model YEAR (the unit's year), e.g. 2011. Not the home's age. */
    heatingModelYear: z.number().nullable().optional(),

    /**
     * Rated heating output capacity in BTU/h, e.g. "eighty thousand BTU" -> 80000.
     * This is a real capture field; AFUE is NOT — do not record a spoken efficiency
     * ("ninety-two percent furnace") anywhere. There is deliberately no AFUE slot.
     */
    heatingOutputCapacityBtuh: z.number().nullable().optional(),

    // --- Cooling -------------------------------------------------------------
    /** Cooling equipment type. A heat pump used for both is `central_heat_pump`. */
    coolingEquipmentType: CoolingEquipmentType.nullable().optional(),

    // --- Ductwork ------------------------------------------------------------
    /** Where the ducts run. */
    ductLocation: DuctLocation.nullable().optional(),

    /** Qualitative duct tightness. "Pretty leaky" -> `very_leaky` / `somewhat_leaky`. */
    ductSealing: DuctSealing.nullable().optional(),

    /** Duct insulation, the Snugg material/thickness member. */
    ductInsulation: DuctInsulation.nullable().optional(),

    /** Duct leakage in CFM at 25 Pa (duct blaster). Not blower-door CFM50. */
    ductLeakageCfm25: z.number().nullable().optional(),

    // --- Attic (HAZARD 2: depth band + material, NOT R-value) ----------------
    /**
     * Attic insulation DEPTH BAND in inches. Set ONLY when the auditor states a
     * depth/thickness ("about six inches" -> `4-6`). When the auditor states an
     * R-value and no depth, leave this `null` and record the R-value in
     * `atticInsulationSpokenRValue` — the R->depth conversion is a reviewed
     * deterministic step, not an LLM guess. See prompt.md.
     */
    atticInsulationDepthIn: AtticInsulationDepthBand.nullable().optional(),

    /** Attic insulation material. */
    atticInsulationType: AtticInsulationType.nullable().optional(),

    /**
     * The spoken R-value, verbatim as a number, when the auditor gives one for the
     * attic ("R-38" -> 38). This is NOT a Snugg write target — it is a holding pen
     * so a real utterance is not lost while `atticInsulationDepthIn` stays honest.
     * The deterministic pass (or the auditor) resolves it into a depth band.
     */
    atticInsulationSpokenRValue: z.number().nullable().optional(),

    // --- Walls ---------------------------------------------------------------
    /** 3-state, not boolean. "Thin / some but not much" -> `poorly`. */
    wallInsulated: WallInsulated.nullable().optional(),

    /** Wall construction type. */
    wallConstruction: WallConstruction.nullable().optional(),

    // --- Air leakage ---------------------------------------------------------
    /**
     * Blower-door result in CFM at 50 Pa. Do NOT derive from ACH50, and do NOT put
     * an ACH50 or CFM25 reading here — those are different references.
     */
    blowerDoorCfm50: z.number().nullable().optional(),

    // --- Windows -------------------------------------------------------------
    /** Predominant glazing. Snugg has no triple-pane box; a triple is `other`. */
    windowGlazing: WindowGlazing.nullable().optional(),

    /** Window frame material. "Clad" -> `wood_or_metal_clad`. */
    windowFrame: WindowFrame.nullable().optional(),

    // --- Domestic hot water --------------------------------------------------
    /** DHW fuel — its own axis, same as heating. "Gas water heater" -> `natural_gas`. */
    dhwFuel: DhwFuel.nullable().optional(),

    /** DHW system type. "Tankless" -> `instantaneous`; "indirect off the boiler" ->
     * `space_heating_boiler_with_tank`. */
    dhwSystemType: DhwSystemType.nullable().optional(),

    /** DHW age BAND. "About twelve years" -> `11-15`. Banded, like the attic depth. */
    dhwAgeBand: DhwAgeBand.nullable().optional(),

    // --- Combustion appliance zone ------------------------------------------
    /** Vent system type. "Power-vented water heater" -> `power_vented_at_unit`. */
    combustionVentType: CombustionVentType.nullable().optional(),

    // --- Health & safety (HAZARD 3: fixed 4-state matrix) --------------------
    /**
     * The 11-test matrix. Each named test is passed / failed / warning /
     * not_tested, or `null` when the test never came up. "CO was clean" sets
     * `ambientCo = passed`; silence on asbestos is `asbestos = null`. This
     * replaces the old single free-text `safetyIssue`, which could hold neither a
     * matrix nor a clean result.
     *
     * `.optional()` on the object itself, like every other leaf: a review in which
     * every health test was rejected writes no health matrix at all rather than an
     * empty one.
     */
    healthSafety: HealthSafetyMatrix.optional(),
  })
  .strict();

/**
 * The writable patch: what a review produces and what `write` sends to Snugg Pro.
 * Inferred from {@link snuggValuesSchema}, never hand-declared — zod is the source
 * of truth. Every key is optional (absent = rejected, do not touch) and every
 * value nullable (present `null` = write it empty).
 */
export type SnuggValues = z.infer<typeof snuggValuesSchema>;

/**
 * What the MODEL is asked to produce, derived from the patch — never hand-written.
 * `enveloped()` strips the patch's `.optional()`/`.nullable()`, wraps each leaf in
 * `ribo-core`'s provenance envelope, recurses into the health matrix rather than
 * swallowing it into one envelope, and closes every object with every key
 * required. See the file header, and `extraction-shape.test.ts` for the frozen
 * JSON Schema this derivation must keep producing.
 */
export const snuggExtractionSchema = enveloped(snuggValuesSchema);

/**
 * The extraction shape as a type: every leaf of {@link SnuggValues} carried with
 * its provenance. Expressed through `ribo-core`'s `Enveloped<V>` — the same type
 * `ToolAdapter.extractionSchema` is declared against — rather than
 * `z.infer<typeof snuggExtractionSchema>`, so the adapter, the extractor and this
 * package all name the extraction shape identically. `enveloped.test.ts` pins the
 * two as mutually assignable, so this cannot drift from what `enveloped()` really
 * returns.
 */
export type SnuggExtraction = Enveloped<SnuggValues>;
