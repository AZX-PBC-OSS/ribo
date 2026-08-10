/**
 * The Snugg Pro energy-audit capture field set — a bounded, *representative*
 * subset of the real API, built directly from the machine-readable spec
 * (`https://app.snuggpro.com/apidocs/swagger.json`, reconciled field-by-field in
 * docs/implementation/17-snuggpro-field-reconciliation.md).
 *
 * "Representative" is the design goal and it has three concrete parts. Every one
 * of them was false in the previous version of this file, which was built from a
 * printed field sheet (doc 12) before the spec was reachable:
 *
 *   1. **The keys are the wire names.** `hvacSystemEquipmentType`, not
 *      `heatingEquipmentType`. There is no rename table between this schema and
 *      the API, so there is no rename table to get wrong.
 *   2. **The enum members are the wire strings, verbatim** — `"6% - Well sealed"`,
 *      `"Furnace / Central AC (shared ducts)"`, `"Not Tested"`, `'Duct Board 1.5"'`.
 *      Title Case, spaces, slashes, percent signs, inch marks and all. A previous
 *      version stored snake_cased tokens (`well_sealed`, `not_tested`), which made
 *      every enumerated leaf need a lookup table at write time; doc 17 §3 measured
 *      that at ~25 of 27 enumerated leaves. Storing what the API accepts deletes
 *      that layer rather than planning it.
 *   3. **The nesting is the resource layout.** Snugg Pro has no single "audit
 *      data" write; the surface is one singleton (`POST /jobs/{jobId}/basedata`)
 *      plus per-instance component resources (`hvac`, `attic`, `wall`, `window`,
 *      `dhw`, `health`), each its own endpoint. The seven groups below ARE those
 *      endpoints, so `write` dispatches on the group key rather than routing 51
 *      flat fields by hand.
 *
 * The subset is deliberate and stays deliberate. `basedata` alone takes 294 form
 * fields; the honest capture surface after removing `*Improved` retrofit twins and
 * self-described auto-calculated fields is ~163 (doc 17 §Scoping). The 51 leaves
 * here are chosen for *dictation density* — what an auditor actually says walking a
 * house — not for coverage. Which 51 is a question for real fill-rate data, not
 * for judgement; the roadmap parks that as R1.6.
 *
 * ---
 *
 * TWO SHAPES LIVE HERE, and telling them apart is the whole point of this file
 * (design `r1.5-field-shape-contracts-design.md` §2.1–§2.3):
 *
 *   - `snuggValuesSchema` — the WRITABLE PATCH. What a review produces and what
 *     `write` sends to Snugg Pro. Hand-written, and the source of truth: every
 *     other shape here is derived from it. Every leaf is
 *     `X.nullable().optional()`, and both halves are load-bearing —
 *       * `.nullable()` because a `null` is a real, WRITTEN value: Snugg Pro's
 *         `"Not Tested"` state (see `HealthTestState` below). "Write this field
 *         as empty" is a different instruction from "leave this field alone".
 *       * `.optional()` because a REJECTED field must be absent from the patch
 *         entirely. `resolveReview` omits a rejected leaf, and a patch is what
 *         makes that well-defined: rejecting one leaf of 51 must still write
 *         the other 50, not fail the whole write.
 *
 *   - `snuggExtractionSchema` — what the MODEL is asked to produce. NOT
 *     hand-written: `enveloped()` derives it from the patch, stripping the
 *     `.optional()`/`.nullable()` that make the patch a patch and wrapping each
 *     leaf in `ribo-core`'s provenance envelope. The result is closed and fully
 *     required at every level, because `provenance.ts`'s anti-hallucination rule
 *     needs the model to emit an explicit `null` rather than omit a key. The
 *     derivation recurses into the seven groups, so the model produces 51
 *     independent envelopes and review presents 51 dotted leaf paths
 *     (`"hvac.hvacDuctLeakage"`, `"health.healthAmbientCarbonMonoxide"`) — never
 *     one envelope per group, which would make a group un-reviewable field by
 *     field.
 *
 * The two therefore differ in optionality BY CONSTRUCTION, and that is the
 * design rather than a leak. The derivation is pinned byte-for-byte by
 * `extraction-shape.test.ts` against a frozen JSON Schema fixture.
 *
 * ---
 *
 * THE FOUR HAZARDS this field set exists to get right. Three survive from the
 * field-sheet era intact; one was overturned by the spec.
 *
 *   1. FUEL IS A SEPARATE AXIS from equipment. `hvacSystemEquipmentType` (Boiler /
 *      Furnace / Heat Pump / ...) and `hvacHeatingEnergySource` (Natural Gas /
 *      Fuel Oil / ...) are two fields. "Oil boiler" decomposes into
 *      `{ "Boiler", "Fuel Oil" }`. The two axes are never fused into one token.
 *   2. ATTIC INSULATION IS A DEPTH BAND, not an R-value — *and also* an R-value.
 *      `atticInsulationDepth` is an inches bucket ("10-12"); `atticInsulation` is
 *      the total R-value as a number. Both are real, independent write targets.
 *      **This overturns the old design**, which held that R-value had no write
 *      target and parked spoken R-values in a fake `atticInsulationSpokenRValue`
 *      holding pen. The spec has the field (doc 17 row 14); the holding pen is
 *      gone and the R->depth conversion nobody wanted to do is now unnecessary
 *      rather than deferred.
 *   3. HEALTH & SAFETY IS A FIXED 4-STATE MATRIX, not free text. **13** named
 *      tests, each `"Passed"` / `"Failed"` / `"Warning"` / `"Not Tested"`. "CO was
 *      clean" is `"Passed"`; a test never mentioned is `null`.
 *   4. EQUIPMENT EFFICIENCY (AFUE / SEER / HSPF) IS NOT A CAPTURE FIELD. The spec
 *      has `hvacHeatingSystemEfficiency`, but it is derived by lookup from make /
 *      model / year, not dictated — no auditor reads an AFUE off a plate. We
 *      capture the inputs (manufacturer, model, model year, output capacity) and
 *      deliberately have no efficiency slot.
 *
 * ---
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
 *      all object shapes closed and all properties required. The nested groups obey
 *      the same rules. The PATCH is deliberately the opposite — open and optional
 *      at every level — and never reaches the model.
 *   4. Extract what was SAID; normalize in code. The enums below are the Snugg
 *      target vocabulary the LLM maps ONTO — but unit coercion, spoken-number ->
 *      int, and band bucketing given a number are a deterministic TypeScript pass
 *      that runs after extraction (see `normalization.ts`).
 *
 * ---
 *
 * TWO KNOWN DIVERGENCES from the spec, both recorded rather than hidden:
 *
 *   - **Cardinality.** The component resources are per-instance: a job may have
 *     three HVAC systems, four wall assemblies, six window groups, each its own
 *     record with its own uuid. This schema models exactly ONE instance of each,
 *     because a single dictation about "the boiler" has no way to say which of
 *     three boilers it means. Multi-instance capture is a real gap, not an
 *     oversight — see doc 17 §5 on the first-write identity problem — and is
 *     parked in the roadmap. A second system dictated today lands on the same
 *     leaves as the first and the reviewer sees the collision.
 *   - **Numeric year/size fields.** The spec types `yearBuilt`,
 *     `hvacHeatingSystemModelYear` and friends as `string` (they are form inputs).
 *     They are modelled as `z.number()` here because that is what they mean and
 *     what a reviewer should be editing; `write` stringifies. Doc 17 rows 5/12
 *     record the same call.
 */

import { enveloped } from "@azx/ribo-core";
import type { Enveloped } from "@azx/ribo-core";
import { z } from "zod";

// --- Enumerations -----------------------------------------------------------
// Every member below is COPIED VERBATIM from the swagger spec's `enum` array for
// that property. Do not tidy the casing, the spacing, the percent signs or the
// inch marks: these strings are the wire values, and a "cleaned up" member is a
// write that fails at the API. `enum: []` in the spec means Snugg publishes no
// value list for that field, which is called out per-field where it happens.

// == basedata ================================================================

/** `typeOfHome` — `POST /jobs/{jobId}/basedata`. */
export const TypeOfHome = z.enum([
  "Apartment",
  "Condominium",
  "Single Family Detached",
  "Single Family Attached",
  "Single Wide Mobile Home",
  "Double Wide Mobile Home",
  "Don't Know",
]);

/**
 * `blowerDoorTestPerformed` — whether `blowerDoorReading` is a measurement or a
 * guess. Spec description: 'Choose "Tested" if an actual blower door test was
 * performed. Choose "Estimate" if the blower door reading is an estimate.' An
 * auditor distinguishes these out loud ("I'll estimate it at three thousand"),
 * so it is a genuine capture field and not bookkeeping.
 */
export const BlowerDoorTestPerformed = z.enum(["Tested", "Estimate"]);

// == hvac ====================================================================

/**
 * HAZARD 1a — `hvacSystemEquipmentType` (`POST /jobs/{jobId}/hvac`, **required**).
 *
 * ONE field for heating AND cooling equipment. The old schema had two
 * (`heatingEquipmentType` + `coolingEquipmentType`); the spec has one, on a
 * per-system record that may itself be a combined heating+cooling unit — which is
 * why members like `"Furnace / Central AC (shared ducts)"` and
 * `"Central Heat Pump (shared ducts)"` name both halves at once. Splitting them
 * back into two fields would produce two writes where the API expects one record.
 *
 * Fuel is still a separate axis: see `hvacHeatingEnergySource`. "Oil boiler" is
 * `"Boiler"` here and `"Fuel Oil"` there, never one fused token.
 */
export const HvacSystemEquipmentType = z
  .enum([
    "Boiler",
    "Steam Boiler",
    "Furnace with standalone ducts",
    "Electric Resistance",
    "Direct Heater",
    "Stove or Insert",
    "Solar Thermal",
    "Central AC with standalone ducts",
    "Room AC",
    "Evaporative Cooler - Direct",
    "Evaporative Cooler - Ducted",
    "Ductless Heat Pump",
    "Central Heat Pump (shared ducts)",
    "Deep Loop Ground Source Heat Pump (shared ducts)",
    "Open Loop Ground Source Heat Pump (shared ducts)",
    "Shallow Loop Ground Source Heat Pump (shared ducts)",
    "Furnace / Central AC (shared ducts)",
  ])
  .describe(
    'Heating and cooling equipment in one field; fuel is a separate field, so decompose "oil boiler" into "Boiler" here and "Fuel Oil" in hvacHeatingEnergySource — never a fused token.',
  );

/**
 * `hvacUpgradeAction` (`hvac`, **required**) — the second and last required
 * capture field in the whole writable surface.
 *
 * This is an extraction field, not a write-time constant. Doc 15's B2 ranked it
 * blocking and recommended hard-coding it, reasoning that a retrofit decision is
 * made later at a desk. That treats an auditor as a pure observer; recommending
 * retrofits is the job, and they narrate it. "There's an oil boiler here, we
 * should get rid of it" carries `"Remove a system permanently"` as plainly as it
 * carries `"Boiler"` (doc 17, owner correction of 2026-08-06).
 */
export const HvacUpgradeAction = z.enum([
  "Replace with a newer model",
  "Keep an existing system as is",
  "Remove a system permanently",
  "Install a new non-existing system",
]);

/**
 * HAZARD 1b — `hvacHeatingEnergySource` (`hvac`), the FUEL axis.
 *
 * The spec declares this property with `enum: []` — the field is real and named,
 * but Snugg publishes no value list for it. The members below are the verbatim
 * list from `dhwFuel2` on the sibling `dhw` resource, which is the closest
 * published fuel vocabulary in the document; `utilities` and `line-item` carry
 * near-identical lists (doc 17 §2 row 2). **This is the one enum here that is
 * inferred rather than copied**, so it is the one most likely to be corrected by a
 * real write, and the first thing to check if an HVAC write is rejected.
 */
export const HvacHeatingEnergySource = z.enum([
  "Electricity",
  "Natural Gas",
  "Fuel Oil",
  "Propane",
  "Pellets",
  "Wood",
  "Solar",
  "None",
]);

/**
 * `hvacHeatingSystemManufacturer` (`hvac`) — a CLOSED enum in the spec, not free
 * text. The old schema had this as `z.string()`, which would have accepted
 * "Burnham" (a real boiler manufacturer that is genuinely not on Snugg's list) and
 * failed at write. It maps to `"Other"` instead, which is a real answer.
 */
export const HvacHeatingSystemManufacturer = z
  .enum([
    "Unknown",
    "AirEase",
    "Amana",
    "American Standard",
    "Bosch",
    "Bryant",
    "Carrier",
    "Coleman",
    "Comfort Master",
    "Daikin",
    "Day & Night",
    "Fujitsu",
    "General Electric",
    "Goodman",
    "Janitrol",
    "Lennox",
    "LG",
    "Luxaire",
    "Mitsubishi",
    "Navien",
    "New Yorker",
    "Payne",
    "Panasonic",
    "Peerless",
    "Rheem",
    "RUUD",
    "Samsung",
    "Sears Kenmore",
    "Tappan",
    "Trane",
    "Triangle Tube",
    "Utica",
    "York",
    "Other",
  ])
  .describe(
    'Manufacturer from this closed list. Use "Other" when the auditor named a make that is not on it, and "Unknown" only when they did not state one.',
  );

/**
 * `hvacDuctLeakage` (`hvac`) — qualitative duct tightness, labelled by leakage
 * percentage. The auditor says "pretty leaky" / "well sealed"; the model maps to
 * the member. `"Measured (CFM25)"` is the escape hatch that pairs with
 * `hvacDuctLeakageValue`: pick it when the auditor read a duct-blaster number.
 */
export const HvacDuctLeakage = z
  .enum([
    "30% - Very leaky",
    "15% - Somewhat leaky",
    "6% - Well sealed",
    "3% - Very tight",
    "Measured (CFM25)",
  ])
  .describe(
    'Qualitative duct tightness, or "Measured (CFM25)" when a duct-blaster number was read — that number goes in hvacDuctLeakageValue, not here.',
  );

/** `hvacDuctInsulation` (`hvac`). Note the inch marks — they are in the wire value. */
export const HvacDuctInsulation = z.enum([
  "No Insulation",
  'Duct Board 1"',
  'Duct Board 1.5"',
  'Duct Board 2"',
  'Fiberglass 1.25"',
  'Fiberglass 2"',
  'Fiberglass 2.5"',
  "Reflective bubble wrap",
  "Measured (R Value)",
]);

// == attic ===================================================================

/**
 * HAZARD 2a — `atticInsulationDepth` (`POST /jobs/{jobId}/attic`), a depth band in
 * INCHES. One of the two enums whose members were already spec-exact before this
 * rewrite, because a numeric band has no Title Case form.
 *
 * Set this when the auditor states a depth or thickness. When they state an
 * R-value instead, that goes in `atticInsulation` — a real field of its own — and
 * this stays `null`. Neither the model nor the deterministic pass converts between
 * them; the conversion is climate- and material-dependent, and now that both
 * fields exist, nothing needs it.
 */
export const AtticInsulationDepth = z
  .enum(["0", "1-3", "4-6", "7-9", "10-12", "13-15", "16+", "Don't Know"])
  .describe(
    "Depth band in inches, set from a stated depth or thickness and never converted from an R-value — a stated R-value goes in atticInsulation instead, and this stays null.",
  );

/**
 * HAZARD 2b — `atticInsulationType` (`attic`), the material, separate from depth.
 * Snugg merges fiberglass and rockwool into one member and has no "None": an
 * uninsulated attic is `atticInsulationDepth: "0"`, not a material.
 */
export const AtticInsulationType = z
  .enum(["Fiberglass or Rockwool (batts or blown)", "Cellulose", "Spray Foam", "Don't Know"])
  .describe(
    'Insulation material — there is no "None" member; an uninsulated attic is atticInsulationDepth: "0", not a material here.',
  );

/** `atticRoofType` (`attic`). */
export const AtticRoofType = z.enum([
  "Composition Shingles",
  "Concrete Tile",
  "Wood Shakes",
  "Tar and Gravel",
]);

// == wall ====================================================================

/**
 * `wallsInsulated` (`POST /jobs/{jobId}/wall`) — FOUR states, not three and not a
 * boolean. `"Well"` is distinct from a bare `"Yes"`: "insulated, and done
 * properly" versus "there is something in there". "Some but thin" is `"Poorly"`.
 */
export const WallsInsulated = z
  .enum(["Well", "Poorly", "Yes", "No"])
  .describe(
    'Four states, not boolean: "Well" means insulated and done properly, "Poorly" means some but thin, and "Yes" means there is insulation of unknown quality — they are not interchangeable.',
  );

/** `wallExteriorWallSiding` (`wall`). */
export const WallExteriorWallSiding = z.enum([
  "Brick Veneer",
  "Metal/vinyl siding",
  "Shingle/Composition",
  "Stone veneer",
  "Stucco",
  "Wood/Fiber Cement siding",
  "Other",
  "None",
  "Don't Know",
]);

/**
 * `wallCavityInsulationType` (`wall`). The spec's list leads with a literal
 * `null` member; that is the field's empty state and is expressed here by the
 * leaf's `.nullable()`, not by an enum member — a `null` in an enum would emit a
 * mixed-type `enum` array that strict structured-output mode rejects.
 */
export const WallCavityInsulationType = z.enum([
  "Fiberglass or Rockwool Batt",
  "Blown Fiberglass or Rockwool",
  "Cellulose",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Other",
]);

// == window ==================================================================

/**
 * `windowType` (`POST /jobs/{jobId}/window`) — glazing. The spec HAS a triple-pane
 * member, contradicting doc 12's "the form has no triple-pane box", and carries
 * the storm and low-e variants an auditor actually calls out.
 */
export const WindowType = z.enum([
  "Single pane",
  "Single pane + storm",
  "Double pane",
  "Double pane + low e",
  "Triple pane + low e",
  "Don't Know",
]);

/** `windowFrame` (`window`). "Clad" -> `"Wood or metal clad"`. */
export const WindowFrame = z.enum(["Metal", "Vinyl", "Wood or metal clad", "Don't Know"]);

// == dhw =====================================================================

/** `dhwType2` (`POST /jobs/{jobId}/dhw`). "Indirect off the boiler" -> `"Sidearm Tank"`. */
export const DhwType = z
  .enum(["Tank Water Heater", "Tankless Water Heater", "Heat Pump", "Sidearm Tank"])
  .describe(
    'Water heater type — an indirect tank off the boiler is "Sidearm Tank", and fuel is a separate field, so "gas water heater" decomposes into a type here and "Natural Gas" in dhwFuel2.',
  );

/** `dhwFuel2` (`dhw`) — the DHW fuel axis, independent of the DHW type. */
export const DhwFuel = z.enum([
  "Electricity",
  "Natural Gas",
  "Fuel Oil",
  "Propane",
  "Pellets",
  "Wood",
  "Solar",
  "None",
]);

/**
 * `dhwAge` (`dhw`) — a banded age in years. The second of the two enums that were
 * already spec-exact. "About twelve years" -> `"11-15"`.
 */
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

/** `dhwLocation` (`dhw`) — where the tank lives, which drives its standby losses. */
export const DhwLocation = z.enum([
  "Indoors and within heated area",
  "Garage or Unconditioned Space",
  "Outbuilding",
  "Don't Know",
]);

/** `dhwManufacturer` (`dhw`) — closed enum, like the HVAC one. */
export const DhwManufacturer = z
  .enum([
    "Unknown",
    "A.O. Smith",
    "American",
    "Bosch",
    "Bradford White",
    "Bryant",
    "Comfort Maker",
    "GE",
    "LG",
    "Navien",
    "Noritz",
    "Rinnai",
    "Sears",
    "Rheem",
    "State Industries",
    "Stiebel Eltron",
    "Takaji",
    "Triangle Tube",
    "Other",
  ])
  .describe(
    'Manufacturer from this closed list. Use "Other" when the auditor named a make that is not on it, and "Unknown" only when they did not state one.',
  );

// == health ==================================================================

/**
 * HAZARD 3 — the health & safety matrix state (`POST /jobs/{jobId}/health`). A
 * FIXED enum, not free text. Every one of the 13 named tests takes exactly one of
 * these.
 *
 *   "Passed"      — the test was run and came back clean/fine/no issues.
 *   "Failed"      — the test was run and found a real problem.
 *   "Warning"     — the test was run and the result is borderline / a caution.
 *   "Not Tested"  — the auditor explicitly said the test was skipped / deferred /
 *                   could not be done.
 *
 * A test the auditor NEVER MENTIONS is `null` (the envelope's "absent"), NOT
 * `"Not Tested"`. Distinguishing "explicitly skipped" from "never came up" is
 * information the review card wants; the write layer renders BOTH as Snugg's
 * `"Not Tested"` (the API has no null), but the extraction keeps them apart. This
 * is why the patch leaf is `.nullable()` and not merely `.optional()`: a `null`
 * here is an instruction to WRITE `"Not Tested"`, while an absent key means "the
 * reviewer rejected this — do not touch it in Snugg Pro at all".
 */
export const HealthTestState = z
  .enum(["Passed", "Failed", "Warning", "Not Tested"])
  .describe(
    'A clean result is "Passed"; "Not Tested" means the auditor explicitly skipped the test, and a test never mentioned is null — not "Not Tested".',
  );

/**
 * `healthRoofCondition` (`health`) — one of the health endpoint's non-4-state
 * fields, kept because roof condition is something an auditor says out loud from
 * the driveway. Its sibling `healthDrainageSystemCondition` shares this enum.
 */
export const HealthCondition = z.enum(["Good", "Potential Issues", "NA"]);

// --- The seven resource groups ----------------------------------------------
// One group per write endpoint. Each is `.strict()` and each leaf is
// `X.nullable().optional()`; the group itself is `.optional()` so a review that
// rejected every leaf in a group writes no request to that endpoint at all.
//
// `enveloped()` RECURSES into these rather than wrapping each whole, so the
// derived extraction schema carries 51 independent provenance envelopes and the
// review card can show the auditor the exact quote behind each one. One envelope
// per group would make its leaves un-reviewable individually, which is the point
// of field-level review.

/** `POST /jobs/{jobId}/basedata` — the house-level singleton. 7 of its 294 fields. */
export const BasedataFields = z
  .object({
    /** Year of construction. Spec types this `string`; `write` stringifies. */
    yearBuilt: z.number().nullable().optional(),

    /** Heated/cooled floor area in ft². Not the lot, not the footprint. */
    conditionedArea: z
      .number()
      .describe(
        "Heated and cooled floor area in square feet — not the lot size and not the building footprint.",
      )
      .nullable()
      .optional(),

    /** Stories of living area, excluding basement and attic. */
    floorsAboveGrade: z
      .number()
      .describe(
        "Number of stories of living area above grade; do not count the basement or the attic.",
      )
      .nullable()
      .optional(),

    /** Bedroom count (RESNET definition), which drives the DHW and ventilation loads. */
    numberOfBedrooms: z.number().nullable().optional(),

    /** Building type. */
    typeOfHome: TypeOfHome.nullable().optional(),

    /**
     * Blower-door result in CFM at 50 Pa. Do NOT derive this from an ACH50, and do
     * NOT put a duct-blaster CFM25 here — `hvac.hvacDuctLeakageValue` is that field
     * and they are different references entirely.
     */
    blowerDoorReading: z
      .number()
      .describe(
        "Blower-door result in CFM at 50 pascals. Never ACH50, and never CFM25 — those are different measurements with their own fields.",
      )
      .nullable()
      .optional(),

    /** Whether `blowerDoorReading` was measured or estimated. */
    blowerDoorTestPerformed: BlowerDoorTestPerformed.nullable().optional(),
  })
  .strict();

/**
 * `POST /jobs/{jobId}/hvac` — one heating/cooling system. 12 of its 73 fields.
 *
 * The two `required` fields in the whole capture surface are both here; see
 * `adapter.ts`'s `requiredOnCreate`.
 */
export const HvacFields = z
  .object({
    /** REQUIRED by the API. The equipment axis, heating and cooling in one field. */
    hvacSystemEquipmentType: HvacSystemEquipmentType.nullable().optional(),

    /** REQUIRED by the API. What the auditor recommends doing with this system. */
    hvacUpgradeAction: HvacUpgradeAction.nullable().optional(),

    /** The fuel axis. "Oil boiler" -> `"Fuel Oil"` here, `"Boiler"` above. */
    hvacHeatingEnergySource: HvacHeatingEnergySource.nullable().optional(),

    /** Manufacturer, from Snugg's closed list. An unlisted make is `"Other"`. */
    hvacHeatingSystemManufacturer: HvacHeatingSystemManufacturer.nullable().optional(),

    /** Model number / model name as stated, free text in the spec too. */
    hvacHeatingSystemModel: z.string().nullable().optional(),

    /** The UNIT's model year, e.g. 2011 — never the home's year. Stringified at write. */
    hvacHeatingSystemModelYear: z
      .number()
      .describe(
        "The heating unit's model year — never the home's year built, which is a separate field.",
      )
      .nullable()
      .optional(),

    /**
     * Rated heating output in BTU/h: "eighty thousand BTU" -> 80000. This is the
     * capture field; efficiency is not (HAZARD 4). A spoken "ninety-two percent
     * furnace" has no home in this schema and must not be forced into this one.
     */
    hvacHeatingCapacity: z
      .number()
      .describe(
        'Rated heating output in BTU per hour, not efficiency — a spoken "ninety-two percent furnace" has no field here; only a stated BTU number goes in.',
      )
      .nullable()
      .optional(),

    /** Rated cooling output in BTU/h. "Three ton" is 36000 — a conversion `normalization.ts` owns. */
    hvacCoolingCapacity: z
      .number()
      .describe("Rated cooling output in BTU per hour.")
      .nullable()
      .optional(),

    /**
     * Where the ducts run. The spec declares this property with `enum: []` and
     * publishes no value list, so this stays free text rather than inventing one —
     * the extracted phrase reaches review intact and a human picks the dropdown
     * entry. The other unpublished-enum field, `hvacHeatingEnergySource`, borrows a
     * sibling's list because fuel has one; duct location has no sibling to borrow from.
     */
    hvacDuctLocation: z.string().nullable().optional(),

    /** Qualitative duct tightness, or `"Measured (CFM25)"` when a number was read. */
    hvacDuctLeakage: HvacDuctLeakage.nullable().optional(),

    /** Duct leakage in CFM at 25 Pa (duct blaster). Pairs with `"Measured (CFM25)"` above. */
    hvacDuctLeakageValue: z
      .number()
      .describe(
        'Duct leakage in CFM at 25 pascals from a duct blaster — not a blower-door CFM50, and only meaningful when hvacDuctLeakage is "Measured (CFM25)".',
      )
      .nullable()
      .optional(),

    /** Duct insulation, the Snugg material/thickness member. */
    hvacDuctInsulation: HvacDuctInsulation.nullable().optional(),
  })
  .strict();

/** `POST /jobs/{jobId}/attic` — one attic. 5 of its 35 fields. */
export const AtticFields = z
  .object({
    /** Depth BAND in inches. Set from a stated depth, never converted from an R-value. */
    atticInsulationDepth: AtticInsulationDepth.nullable().optional(),

    /** Insulation material. */
    atticInsulationType: AtticInsulationType.nullable().optional(),

    /**
     * Total installed R-value, as a number: "R-38 up top" -> 38. A REAL write
     * target — the field the old design wrongly believed did not exist, which is why
     * this schema has no `atticInsulationSpokenRValue` holding pen any more.
     */
    atticInsulation: z
      .number()
      .describe(
        'Total installed R-value as a number ("R-38" → 38) — never converted into a depth band, which is a separate field.',
      )
      .nullable()
      .optional(),

    /** Whether the attic has a knee wall — a distinct, commonly-uninsulated assembly. */
    atticHasKneeWall: z.enum(["Yes", "No"]).nullable().optional(),

    /** Roof covering. */
    atticRoofType: AtticRoofType.nullable().optional(),
  })
  .strict();

/** `POST /jobs/{jobId}/wall` — one wall assembly. 4 of its 17 fields. */
export const WallFields = z
  .object({
    /** 4-state, not boolean. "Some but thin" -> `"Poorly"`. */
    wallsInsulated: WallsInsulated.nullable().optional(),

    /** Exterior cladding. */
    wallExteriorWallSiding: WallExteriorWallSiding.nullable().optional(),

    /** Cavity insulation R-value as a number. */
    wallCavityInsulation: z
      .number()
      .describe("Cavity insulation R-value as a number; the material is a separate field.")
      .nullable()
      .optional(),

    /** Cavity insulation material. */
    wallCavityInsulationType: WallCavityInsulationType.nullable().optional(),
  })
  .strict();

/** `POST /jobs/{jobId}/window` — one window group. 3 of its 34 fields. */
export const WindowFields = z
  .object({
    /** Glazing, including the storm and low-e variants. */
    windowType: WindowType.nullable().optional(),

    /** Frame material. */
    windowFrame: WindowFrame.nullable().optional(),

    /** Energy Star rated. */
    windowEnergyStar: z.enum(["Yes", "No"]).nullable().optional(),
  })
  .strict();

/** `POST /jobs/{jobId}/dhw` — one water heater. 6 of its 48 fields. */
export const DhwFields = z
  .object({
    /** System type. "Tankless" -> `"Tankless Water Heater"`. */
    dhwType2: DhwType.nullable().optional(),

    /** The DHW fuel axis. "Gas water heater" -> `"Natural Gas"`. */
    dhwFuel2: DhwFuel.nullable().optional(),

    /** Age BAND. "About twelve years" -> `"11-15"`. */
    dhwAge: DhwAgeBand.nullable().optional(),

    /** Where the tank is, which drives standby loss. */
    dhwLocation: DhwLocation.nullable().optional(),

    /** Nominal tank capacity in gallons. A tankless unit has none — leave it `null`. */
    dhwTankSize: z
      .number()
      .describe(
        "Nominal tank capacity in gallons; a tankless water heater has no tank, so leave it null.",
      )
      .nullable()
      .optional(),

    /** Manufacturer, from Snugg's closed list. */
    dhwManufacturer: DhwManufacturer.nullable().optional(),
  })
  .strict();

/**
 * `POST /jobs/{jobId}/health` — HAZARD 3, the full 13-test matrix plus roof
 * condition. 14 of its 17 fields.
 *
 * The old schema had 11 tests: `healthUndilutedFlueCo` and `healthRadon` were
 * missing outright (doc 17 §"the health matrix is 13 tests, not 11"). Undiluted
 * flue CO in particular is one auditors read off a meter and say out loud, so its
 * absence was dropping real dictation on the floor.
 */
export const HealthFields = z
  .object({
    healthAmbientCarbonMonoxide: HealthTestState.nullable().optional(),
    healthNaturalConditionSpillage: HealthTestState.nullable().optional(),
    healthWorstCaseDepressurization: HealthTestState.nullable().optional(),
    healthWorstCaseSpillage: HealthTestState.nullable().optional(),
    healthUndilutedFlueCo: HealthTestState.nullable().optional(),
    healthDraftPressure: HealthTestState.nullable().optional(),
    healthGasLeak: HealthTestState.nullable().optional(),
    healthVenting: HealthTestState.nullable().optional(),
    healthMoldMoisture: HealthTestState.nullable().optional(),
    healthRadon: HealthTestState.nullable().optional(),
    healthAsbestos: HealthTestState.nullable().optional(),
    healthLead: HealthTestState.nullable().optional(),
    healthElectrical: HealthTestState.nullable().optional(),

    /** Not a 4-state test — a condition judgement on its own enum. */
    healthRoofCondition: HealthCondition.nullable().optional(),
  })
  .strict();

// --- The bounded field set, as a writable patch -----------------------------
// 51 leaves across 7 resource groups. Every leaf is `X.nullable().optional()` and
// every object is `.strict()`; see the file header for why both halves of that are
// load-bearing.

export const snuggValuesSchema = z
  .object({
    basedata: BasedataFields.optional(),
    hvac: HvacFields.optional(),
    attic: AtticFields.optional(),
    wall: WallFields.optional(),
    window: WindowFields.optional(),
    dhw: DhwFields.optional(),
    health: HealthFields.optional(),
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
 * `ribo-core`'s provenance envelope, recurses into the seven resource groups rather
 * than swallowing each into one envelope, and closes every object with every key
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
