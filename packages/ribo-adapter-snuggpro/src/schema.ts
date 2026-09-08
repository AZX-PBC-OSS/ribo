/**
 * The Snugg Pro energy-audit capture field set, built directly from the
 * machine-readable spec (`https://app.snuggpro.com/apidocs/swagger.json`,
 * reconciled field-by-field in
 * docs/implementation/17-snuggpro-field-reconciliation.md). The `basedata` group
 * is the FULL honest capture surface of that endpoint (doc 17 §Scoping); the six
 * component groups remain bounded, representative subsets of theirs.
 *
 * "Representative" is the design goal and it has three concrete parts. Every one
 * of them was false in the previous version of this file, which was built from a
 * printed field sheet (doc 12) before the spec was reachable:
 *
 *   1. **The keys are the wire names.** `hvacSystemEquipmentType`, not
 *      `heatingEquipmentType`. There is no rename table between this schema and
 *      the API, so there is no rename table to get wrong.
 *   2. **The enum members are the wire strings, verbatim** — `"6% - Well sealed"`,
 *      `"Furnace / Central AC (shared ducts)"`, `"Not Tested"`, `"Duct Board 1.5 inch"`.
 *      Title Case, spaces, slashes, percent signs and all. A previous
 *      version stored snake_cased tokens (`well_sealed`, `not_tested`), which made
 *      every enumerated leaf need a lookup table at write time; doc 17 §3 measured
 *      that at ~25 of 27 enumerated leaves. Storing what the API accepts deletes
 *      that layer rather than planning it.
 *   3. **The nesting is the resource layout.** Snugg Pro has no single "audit
 *      data" write; the surface is one singleton (`POST /jobs/{jobId}/basedata`)
 *      plus per-instance component resources (`hvac`, `attic`, `wall`, `window`,
 *      `dhw`, `health`), each its own endpoint. The seven groups below ARE those
 *      endpoints, so `write` dispatches on the group key rather than routing 207
 *      flat fields by hand.
 *
 * The `basedata` group is the FULL honest capture surface of doc 17 §Scoping:
 * the endpoint's 294 form fields minus the 122 `*Improved` retrofit twins and
 * the 9 self-described auto-calculated fields — exactly 163 leaves, every one a
 * verbatim wire name with verbatim enum strings. The other six groups remain
 * bounded, *dictation-density* subsets of their own endpoints — what an auditor
 * actually says walking a house — and which leaves they grow next is a question
 * for real fill-rate data, not for judgement.
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
 *         makes that well-defined: rejecting one leaf of 207 must still write
 *         the other 206, not fail the whole write.
 *
 *   - `snuggExtractionSchema` — what the MODEL is asked to produce. NOT
 *     hand-written: `enveloped()` derives it from the patch, stripping the
 *     `.optional()`/`.nullable()` that make the patch a patch and wrapping each
 *     leaf in `ribo-core`'s provenance envelope. The result is closed and fully
 *     required at every level, because `provenance.ts`'s anti-hallucination rule
 *     needs the model to emit an explicit `null` rather than omit a key. The
 *     derivation recurses into the seven groups, so the model produces 207
 *     independent envelopes and review presents 207 dotted leaf paths
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
 * KNOWN DIVERGENCES from the spec, recorded rather than hidden:
 *
 *   - **Numeric year/size/temperature fields.** The spec types `yearBuilt`,
 *     `hvacHeatingSystemModelYear` and friends — including the `basedata`
 *     thermostat setpoints, design temperatures, appliance model years and
 *     `demandKWSavings` — as `string` (they are form inputs). They are modelled
 *     as `z.number()` here because that is what they mean and what a reviewer
 *     should be editing; `write` stringifies. Doc 17 rows 5/12 record the same
 *     call.
 *   - **`hasEv` is an INTEGER enum `[1, 0]` in the spec.** `enveloped()` has no
 *     numeric-enum leaf (zod's `z.enum` is strings-only and a literal union is
 *     not a supported leaf), so it is a `z.number()` and the 1/0 vocabulary
 *     travels in its description instead of its type.
 */

import { enveloped } from "@azx/ribo-core";
import type { Enveloped } from "@azx/ribo-core";
import { z } from "zod";

import { stripOptionalNullable } from "@azx/ribo-core";

import { VENDOR_DESCRIPTIONS } from "./descriptions.generated.js";

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

/** `frontOfBuildingOrientation` — `POST /jobs/{jobId}/basedata`. */
export const FrontOfBuildingOrientation = z.enum([
  "North",
  "North East",
  "East",
  "South East",
  "South",
  "South West",
  "West",
  "North West",
]);

/** `garageSize` — `POST /jobs/{jobId}/basedata`. */
export const GarageSize = z.enum(["1-car", "2-car", "3-car", "4-car", "5-car"]);

/** `basementWallInsulation` — `POST /jobs/{jobId}/basedata`. */
export const BasementWallInsulation = z.enum([
  "None or Bare Walls",
  "Fiberglass blanket",
  "Unfinished frame wall with fiberglass batts",
  "Finished wall without Insulation",
  "Finished wall with Insulation",
  "Don't Know",
]);

/** `crawlspaceInsulation` — `POST /jobs/{jobId}/basedata`. */
export const CrawlspaceInsulation = z.enum([
  "Crawlspace has insulation installed on the exterior wall area",
  "Crawlspace has insulation installed under only the living space floor",
  "Crawlspace is uninsulated",
  "Don't Know",
]);

/** `percentCflsOrLeds` — `POST /jobs/{jobId}/basedata`. */
export const PercentCflsOrLeds = z.enum([
  "0%",
  "1-25%",
  "26-50%",
  "51-75%",
  "76-99%",
  "100%",
  "Don't Know",
]);

/** `crawlspaceType` — `POST /jobs/{jobId}/basedata`. */
export const CrawlspaceType = z.enum([
  "Unvented - Unconditioned Crawl",
  "Vented - Year Round",
  "Vented - Summer Only",
  "Conditioned Crawl",
]);

/** `clothesWasherType` — `POST /jobs/{jobId}/basedata`. */
export const ClothesWasherType = z.enum(["Front Load", "Top Load", "No Clothes Washer"]);

/**
 * `clothesWasherManufacturer` — `POST /jobs/{jobId}/basedata`. The vendor list carries
 * both "Frigidaire" and its own "Fridgidaire" typo — both are verbatim wire members
 * and both stay.
 */
export const ClothesWasherManufacturer = z.enum([
  "Unknown",
  "Amana",
  "Asko",
  "Bosch",
  "Frigidaire",
  "GE",
  "Hotpoint",
  "LG",
  "Maytag",
  "Samsung",
  "Sears",
  "Westinghouse",
  "Whirlpool",
  "Other",
  "Fridgidaire",
]);

/**
 * `windZone` — `POST /jobs/{jobId}/basedata`. The wire members are numeric STRINGS —
 * they stay strings, not numbers.
 */
export const WindZone = z.enum(["1", "2", "3", "4"]);

/** `shielding` — `POST /jobs/{jobId}/basedata`. */
export const Shielding = z.enum(["Well-Shielded", "Normal", "Exposed"]);

/**
 * `dishwasherManufacturer` — `POST /jobs/{jobId}/basedata`. The vendor list carries
 * both "Frigidaire" and its own "Fridgidaire" typo — both are verbatim wire members
 * and both stay.
 */
export const DishwasherManufacturer = z.enum([
  "Unknown",
  "Amana",
  "Asko",
  "Bosch",
  "Frigidaire",
  "GE",
  "Hotpoint",
  "KitchenAid",
  "LG",
  "Maytag",
  "Samsung",
  "Sears",
  "Thermador",
  "Whirlpool",
  "Other",
  "Fridgidaire",
]);

/**
 * `poolPumpType` — `POST /jobs/{jobId}/basedata`. The spec's list leads with a literal
 * `null` member; that is the field's empty state and is expressed by the leaf's
 * `.nullable()`, not by an enum member — the same rule `WallCavityInsulationType`
 * records.
 */
export const PoolPumpType = z.enum(["Single Speed", "Two Speed", "Variable Speed", "No Pool Pump"]);

/**
 * `poolPumpHorsepower` — `POST /jobs/{jobId}/basedata`. The wire members are numeric
 * STRINGS — they stay strings, not numbers.
 */
export const PoolPumpHorsepower = z.enum(["0.5", "0.75", "1", "1.5", "2", "3"]);

/** `basementHeating` — `POST /jobs/{jobId}/basedata`. */
export const BasementHeating = z.enum([
  "Intentional",
  "Intentional w/ continuous circulation",
  "Incidental-Desired (e.g. leaky ducts)",
  "None or Undesired Incidental",
]);

/** `basementCooling` — `POST /jobs/{jobId}/basedata`. */
export const BasementCooling = z.enum([
  "Intentional",
  "Intentional w/ continuous circulation",
  "Incidental-Desired (e.g. leaky ducts)",
  "None or Undesired Incidental",
]);

/** `poolPumpManufacturer` — `POST /jobs/{jobId}/basedata`. */
export const PoolPumpManufacturer = z.enum(["Pentair", "Other"]);

/** `crawlspaceRimJoistTreatment` — `POST /jobs/{jobId}/basedata`. */
export const CrawlspaceRimJoistTreatment = z.enum(["Same as Crawl Wall", "Separately"]);

/** `basementRimJoistTreatment` — `POST /jobs/{jobId}/basedata`. */
export const BasementRimJoistTreatment = z.enum(["Same as Basement Wall", "Separately"]);

/**
 * `ashraeNumberOfBathrooms` — `POST /jobs/{jobId}/basedata`. The wire members are
 * numeric STRINGS — they stay strings, not numbers.
 */
export const AshraeNumberOfBathrooms = z.enum(["1", "2", "3", "4"]);

/** `floorCavityInsulationType` — `POST /jobs/{jobId}/basedata`. */
export const FloorCavityInsulationType = z.enum([
  "Fiberglass or Rockwool Batt",
  "Blown Fiberglass or Rockwool",
  "Cellulose",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Rigid XPS",
  "Rigid EPS",
  "Rigid Polyisocyanurate",
  "Other",
]);

/** `floorContinuousInsulationType` — `POST /jobs/{jobId}/basedata`. */
export const FloorContinuousInsulationType = z.enum([
  "Fiberglass or Rockwool Batt",
  "Blown Fiberglass or Rockwool",
  "Cellulose",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Rigid XPS",
  "Rigid EPS",
  "Rigid Polyisocyanurate",
  "Other",
]);

/** `floorWingInsulationCondition` — `POST /jobs/{jobId}/basedata`. */
export const FloorWingInsulationCondition = z.enum([
  "Perfect",
  "Good",
  "Average",
  "Poor",
  "Critical",
]);

/** `floorBellyInsulationCondition` — `POST /jobs/{jobId}/basedata`. */
export const FloorBellyInsulationCondition = z.enum([
  "Perfect",
  "Good",
  "Average",
  "Poor",
  "Critical",
]);

/**
 * `floorFrameFloorType` — `POST /jobs/{jobId}/basedata`. The spec publishes exactly
 * one member for this list.
 */
export const FloorFrameFloorType = z.enum(["Manufactured Home Belly"]);

/** `floorInsulationLocation` — `POST /jobs/{jobId}/basedata`. */
export const FloorInsulationLocation = z.enum(["Insulation above ducts", "Insulation below ducts"]);

/** `crawlCavityInsulationType` — `POST /jobs/{jobId}/basedata`. */
export const CrawlCavityInsulationType = z.enum([
  "Fiberglass or Rockwool Batt",
  "Blown Fiberglass or Rockwool",
  "Cellulose",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Other",
]);

/** `crawlWallInsulationType` — `POST /jobs/{jobId}/basedata`. */
export const CrawlWallInsulationType = z.enum([
  "Fiberglass Drape",
  "Rigid XPS",
  "Rigid EPS",
  "Rigid Polyisocyanurate",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Other",
]);

/** `crawlspaceRimJoistInsulationType` — `POST /jobs/{jobId}/basedata`. */
export const CrawlspaceRimJoistInsulationType = z.enum([
  "Fiberglass or Rockwool Batt",
  "Blown Fiberglass or Rockwool",
  "Cellulose",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Rigid XPS",
  "Rigid EPS",
  "Rigid Polyisocyanurate",
  "Other",
]);

/**
 * `basementCavityInsulationType` — `POST /jobs/{jobId}/basedata`. The spec's list
 * leads with a literal `null` member; that is the field's empty state and is expressed
 * by the leaf's `.nullable()`, not by an enum member — the same rule
 * `WallCavityInsulationType` records.
 */
export const BasementCavityInsulationType = z.enum([
  "Fiberglass or Rockwool Batt",
  "Blown Fiberglass or Rockwool",
  "Cellulose",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Other",
]);

/** `basementContinuousInsulationType` — `POST /jobs/{jobId}/basedata`. */
export const BasementContinuousInsulationType = z.enum([
  "Fiberglass Drape",
  "Rigid XPS",
  "Rigid EPS",
  "Rigid Polyisocyanurate",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Other",
]);

/** `basementRimJoistInsulationType` — `POST /jobs/{jobId}/basedata`. */
export const BasementRimJoistInsulationType = z.enum([
  "Fiberglass or Rockwool Batt",
  "Blown Fiberglass or Rockwool",
  "Cellulose",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Rigid XPS",
  "Rigid EPS",
  "Rigid Polyisocyanurate",
  "Other",
]);

/** `evCalculationMethod` — `POST /jobs/{jobId}/basedata`. */
export const EvCalculationMethod = z.enum(["Detailed", "Simple"]);

/** `basementCeilingCavityInsulationType` — `POST /jobs/{jobId}/basedata`. */
export const BasementCeilingCavityInsulationType = z.enum([
  "Fiberglass or Rockwool Batt",
  "Blown Fiberglass or Rockwool",
  "Cellulose",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Other",
]);

/**
 * `basementCeilingContinuousInsulationType` — `POST /jobs/{jobId}/basedata`. The
 * spec's list leads with a literal `null` member; that is the field's empty state and
 * is expressed by the leaf's `.nullable()`, not by an enum member — the same rule
 * `WallCavityInsulationType` records.
 */
export const BasementCeilingContinuousInsulationType = z.enum([
  "Fiberglass Drape",
  "Rigid XPS",
  "Rigid EPS",
  "Rigid Polyisocyanurate",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Other",
]);

/** `ventilationType` — `POST /jobs/{jobId}/basedata`. */
export const VentilationType = z.enum([
  "None",
  "Exhaust",
  "Supply",
  "Heat Recovery Ventilator",
  "Energy Recovery Ventilator",
]);

/** `ventilationSchedule` — `POST /jobs/{jobId}/basedata`. */
export const VentilationSchedule = z.enum(["Continuous", "Intermittent"]);

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

/**
 * `hvacDuctInsulation` (`hvac`).
 *
 * The vendor's wire values use double-quote inch marks (`Duct Board 1.5"`). The
 * platform's structured-output route (`POST <base>/_api/llm/chat`) rejects a
 * schema whose enum contains a double-quote character with a generic
 * `400 validation_failed` — verified in isolation against the live route, and
 * bisected from a whole-schema failure down to exactly these six members. So the
 * extraction enum uses quote-free aliases that spell the inch out ("1.5 inch"),
 * and `normalization.ts`'s `DUCT_INSULATION_VENDOR_LITERALS` maps each alias back
 * to the vendor's literal wire string for write-back. The three members below
 * that never carried a quote (`No Insulation`, `Reflective bubble wrap`,
 * `Measured (R Value)`) are unchanged and appear in neither the alias set nor the
 * lookup table — they need no translation.
 */
export const HvacDuctInsulation = z.enum([
  "No Insulation",
  "Duct Board 1 inch",
  "Duct Board 1.5 inch",
  "Duct Board 2 inch",
  "Fiberglass 1.25 inch",
  "Fiberglass 2 inch",
  "Fiberglass 2.5 inch",
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
// derived extraction schema carries 207 independent provenance envelopes and the
// review card can show the auditor the exact quote behind each one. One envelope
// per group would make its leaves un-reviewable individually, which is the point
// of field-level review.

/**
 * `POST /jobs/{jobId}/basedata` — the house-level singleton. 163 of its 294
 * fields: the FULL honest capture surface of doc 17 §Scoping (294 form fields
 * minus the 122 `*Improved` retrofit twins and the 9 self-described
 * auto-calculated fields). This group is no longer a dictation-density subset.
 */
/**
 * Some vendor descriptions are a stringified JS `undefined` — the spec carries
 * one that is literally `"undefined"` and one prefixed `"undefined Field
 * options: ..."`. Strip the artifact so it never reaches the model's prompt;
 * whatever survives the strip ("Field options: 1 → Yes 0 → No") is real vendor
 * text and stays. `descriptions.generated.ts` stays vendor-faithful — the
 * filtering happens here, not in `pnpm snugg:refresh`.
 */
function cleanVendorDescription(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const cleaned = text.replace(/^undefined\s*/i, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Compose the vendor's own description with ours, per leaf.
 *
 * Two different jobs, and the model wants both. The vendor sentence says what the field
 * IS — it is the same text a Snugg Pro user reads in their UI, so it anchors our
 * vocabulary to theirs. Ours says what mistake NOT to make ("never ACH50, never CFM25"),
 * which no vendor description would ever contain because it is specific to extracting
 * from dictated speech.
 *
 * Vendor first: the definition orients the model before the prohibition constrains it.
 *
 * Applied to the whole group at once rather than at 207 call sites — the leaf's own
 * `.describe()` is read back out and appended, so a note written the obvious way is
 * picked up automatically. Leaves the vendor does not describe keep their note alone.
 */
function withVendorDescriptions<T extends z.ZodRawShape>(shape: T): T {
  const described: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(shape) as [string, z.ZodType][]) {
    const vendor = cleanVendorDescription(VENDOR_DESCRIPTIONS[name]);
    // Read through the `.nullable().optional()` wrapper: a leaf's own note is written on
    // the inner type, which is where it has to be to survive `enveloped()`.
    const ours = stripOptionalNullable(field).description;
    const composed = [vendor, ours].filter(Boolean).join(" ");
    described[name] = composed.length > 0 ? field.describe(composed) : field;
  }
  return described as unknown as T;
}

export const BasedataFields = z
  .object(
    withVendorDescriptions({
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

      /** Average interior floor-to-ceiling wall height, in feet. */
      averageWallHeight: z.number().nullable().optional(),

      /** Length of the longest side of the footprint's bounding rectangle, in feet. */
      houseLength: z.number().nullable().optional(),

      /** Width of the shortest side of the footprint's bounding rectangle, in feet. */
      houseWidth: z.number().nullable().optional(),

      /** Number of people living full-time in the home. */
      numberOfOccupants: z.number().nullable().optional(),

      /** Compass direction the length of the house faces. */
      frontOfBuildingOrientation: FrontOfBuildingOrientation.nullable().optional(),

      /** Conditioned living space over an unconditioned garage, cantilever or frame floor. */
      tuckUnderGarage: z.enum(["Yes", "No"]).nullable().optional(),

      /** Garage capacity, in cars. */
      garageSize: GarageSize.nullable().optional(),

      /**
       * Whether a programmable (setback) thermostat is installed — installed-but-unused
       * still counts.
       */
      programmableThermostatInstalled: z.enum(["Yes", "No"]).nullable().optional(),

      /**
       * Heating setpoint in °F most often used when OCCUPIED. Spec types this `string`;
       * `write` stringifies.
       */
      heatingSetpointHigh: z.number().nullable().optional(),

      /** Heating setpoint in °F most often used when unoccupied (the setback). */
      heatingSetpointLow: z.number().nullable().optional(),

      /**
       * Cooling setpoint in °F most often used when UNOCCUPIED — the vendor's own pairing,
       * inverted from heating.
       */
      coolingSetpointHigh: z.number().nullable().optional(),

      /** Cooling setpoint in °F most often used when occupied. */
      coolingSetpointLow: z.number().nullable().optional(),

      /** Thermostat manufacturer — free text in the spec too, not a closed list. */
      thermostatManufacturer: z.string().nullable().optional(),

      /** Thermostat model. */
      thermostatModel: z.string().nullable().optional(),

      /** Thermostat serial number. */
      thermostatSerialNumber: z.string().nullable().optional(),

      /** Count of light bulbs in the home, closets and hidden areas included. */
      totalNumberOfLightBulbs: z.number().nullable().optional(),

      /** Percent of the north wall shared with another unit (assumed adiabatic). */
      sharedWallsNorth: z.number().nullable().optional(),

      /** Percent of conditioned space with another separately-metered unit above. */
      percentOfCeilingsShared: z.number().nullable().optional(),

      /** Percent of conditioned space with another separately-metered unit below. */
      percentOfFloorsShared: z.number().nullable().optional(),

      /**
       * Percent of foundation that is basement — the foundation shares cannot total more
       * than 100.
       */
      foundationBasement: z.number().nullable().optional(),

      /** Average height in feet of the foundation wall exposed above grade. */
      foundationAboveGradeHeight: z.number().nullable().optional(),

      /** Basement wall insulation material/assembly. */
      basementWallInsulation: BasementWallInsulation.nullable().optional(),

      /** Where crawlspace insulation is installed — or that the crawlspace is uninsulated. */
      crawlspaceInsulation: CrawlspaceInsulation.nullable().optional(),

      /** Skylight / roof-window area within conditioned space, in ft². */
      skylightArea: z.number().nullable().optional(),

      /** The UNMODELED baseline airflow at 50 Pa. */
      unmodeledBlowerDoorReading: z
        .number()
        .describe(
          "The unmodeled variant of the blower-door reading — the primary measured result goes in blowerDoorReading, not here.",
        )
        .nullable()
        .optional(),

      /** Equivalent natural air changes per hour. */
      equivalentNach: z
        .number()
        .describe(
          "Natural air changes per hour (NACH) — never ACH50, and never the blower-door CFM50 of blowerDoorReading.",
        )
        .nullable()
        .optional(),

      /**
       * Conditioned air volume — the vendor derives it from area × wall height; a stated
       * value overrides.
       */
      conditionedAirVolume: z.number().nullable().optional(),

      /**
       * Effective leakage area in square inches — the theoretical hole equal to the
       * envelope's leaks.
       */
      effectiveLeakageArea: z.number().nullable().optional(),

      /** Exposed basement wall area eligible for insulation, in ft². */
      modeledBasementWallArea: z.number().nullable().optional(),

      /** Cavity insulation R-value of the framed basement walls. */
      basementCavityInsulation: z.number().nullable().optional(),

      /** Continuous insulation R-value on the basement walls (fiberglass drape or rigid). */
      basementContinuousInsulation: z.number().nullable().optional(),

      /** Total assembly R-value of the basement wall system. */
      basementWallAssemblyRValue: z.number().nullable().optional(),

      /** Cavity insulation R-value of the frame floor. */
      floorCavityInsulation: z.number().nullable().optional(),

      /** Continuous insulation R-value under the frame floor. */
      floorContinuousInsulation: z.number().nullable().optional(),

      /** Total assembly R-value of the frame floor system. */
      floorAssemblyRValue: z.number().nullable().optional(),

      /** Percent of the east wall shared with another unit (assumed adiabatic). */
      sharedWallsEast: z.number().nullable().optional(),

      /** Percent of the south wall shared with another unit (assumed adiabatic). */
      sharedWallsSouth: z.number().nullable().optional(),

      /** Percent of the west wall shared with another unit (assumed adiabatic). */
      sharedWallsWest: z.number().nullable().optional(),

      /** Percent of foundation that is crawlspace. */
      foundationCrawlspace: z.number().nullable().optional(),

      /** Percent of foundation that is slab on grade. */
      foundationSlab: z.number().nullable().optional(),

      /** Percent of foundation that is frame floor. */
      foundationFramefloor: z.number().nullable().optional(),

      /**
       * BANDED share of lamps that are CFL/LED — an exact numeric percentage is
       * percentCflOrLed.
       */
      percentCflsOrLeds: PercentCflsOrLeds.nullable().optional(),

      /** Cavity insulation R-value of the crawlspace ceiling. */
      crawlCavityInsulation: z.number().nullable().optional(),

      /** R-value of insulation on the crawlspace walls. */
      crawlWallInsulation: z.number().nullable().optional(),

      /** Total assembly R-value of the crawlspace ceiling system. */
      crawlAssemblyRValue: z.number().nullable().optional(),

      /** Crawlspace venting and conditioning type. */
      crawlspaceType: CrawlspaceType.nullable().optional(),

      /** Clothes washer type. */
      clothesWasherType: ClothesWasherType.nullable().optional(),

      /** Whether the clothes washer is an ENERGY STAR model. */
      clothesWasherEnergyStar: z.enum(["Yes", "No"]).nullable().optional(),

      /** Clothes washer manufacturer, from Snugg's closed list. */
      clothesWasherManufacturer: ClothesWasherManufacturer.nullable().optional(),

      /** Clothes washer model number. */
      clothesWasherModel: z.string().nullable().optional(),

      /** Clothes washer serial number(s), comma-separated when several. */
      clothesWasherSerialNumber: z.string().nullable().optional(),

      /** Clothes washer Integrated Modified Energy Factor (IMEF). */
      clothesWasherMef: z.number().nullable().optional(),

      /** Whether the dishwasher is an ENERGY STAR model. */
      dishwasherEnergyStar: z.enum(["Yes", "No"]).nullable().optional(),

      /** Dishwasher Energy Factor (EF). */
      dishwasherEnergyFactor: z.number().nullable().optional(),

      /** Exact-percentage numeric override — the banded answer is percentCflsOrLeds. */
      percentCflOrLed: z
        .number()
        .describe(
          "Exact override percentage as a number — the banded answer is percentCflsOrLeds, not this field.",
        )
        .nullable()
        .optional(),

      /** Wind zone from the vendor's map. */
      windZone: WindZone.nullable().optional(),

      /** Site shielding, used with the N-factor to derive NACH. */
      shielding: Shielding.nullable().optional(),

      /** Lawrence Berkeley Laboratory correlation factor used to calculate NACH. */
      nFactor: z.number().nullable().optional(),

      /** Dishwasher model number. */
      dishwasherModel: z.string().nullable().optional(),

      /** Dishwasher manufacturer, from Snugg's closed list. */
      dishwasherManufacturer: DishwasherManufacturer.nullable().optional(),

      /** Dishwasher model year. Spec types this `string`; `write` stringifies. */
      dishwasherModelYear: z.number().nullable().optional(),

      /** Clothes washer model year. Spec types this `string`; `write` stringifies. */
      clothesWasherModelYear: z.number().nullable().optional(),

      /** Number of incandescent bulbs in the home before the retrofit. */
      numberOfIncandescents: z.number().nullable().optional(),

      /** Override count of CFLs installed. */
      numberOfCflsInstalled: z.number().nullable().optional(),

      /** Override count of CFLs or LEDs. */
      numberOfCflsOrLeds: z.number().nullable().optional(),

      /** Override count of outdoor incandescents. */
      numberOfOutdoorIncandescents: z.number().nullable().optional(),

      /** Override count of outdoor CFLs. */
      numberOfOutdoorCfls: z.number().nullable().optional(),

      /** Override count of outdoor LEDs. */
      numberOfOutdoorLeds: z.number().nullable().optional(),

      /** Whether the home has an electrically heated hot tub. */
      hotTub: z.enum(["Yes", "No"]).nullable().optional(),

      /** Whether the home has a pool. */
      pool: z.enum(["Yes", "No"]).nullable().optional(),

      /** Pool pump speed type. */
      poolPumpType: PoolPumpType.nullable().optional(),

      /** Pool pump horsepower. */
      poolPumpHorsepower: PoolPumpHorsepower.nullable().optional(),

      /** How the basement receives heat. */
      basementHeating: BasementHeating.nullable().optional(),

      /** How the basement receives cooling. */
      basementCooling: BasementCooling.nullable().optional(),

      /** Pool water volume, in gallons. */
      poolSize: z.number().nullable().optional(),

      /**
       * Daily pool-water turnovers through the filter — only meaningful for variable-speed
       * pumps.
       */
      poolPumpTurnover: z.number().nullable().optional(),

      /** Pool pump run hours per day — only meaningful for single/two-speed pumps. */
      poolPumpHours: z.number().nullable().optional(),

      /** Pool pump manufacturer, from Snugg's closed list. */
      poolPumpManufacturer: PoolPumpManufacturer.nullable().optional(),

      /** Pool pump model number. */
      poolPumpModel: z.string().nullable().optional(),

      /** Pool pump serial number(s), comma-separated when several. */
      poolPumpSerialNumber: z.string().nullable().optional(),

      /** Days per year the pool is used. */
      poolPumpDaysPerYear: z.number().nullable().optional(),

      /** Whether an automatic dishwasher is installed. */
      dishwasherInstalled: z.enum(["Yes", "No"]).nullable().optional(),

      /** Whether `conditionedArea` includes the basement area. */
      includesBasement: z
        .enum(["Yes", "No"])
        .describe(
          "Whether the conditioned area includes the basement — the qualifier on that number, not an area of its own.",
        )
        .nullable()
        .optional(),

      /** Heating design load. The vendor publishes an empty description for this field. */
      heatingDesignLoad: z
        .number()
        .describe("Heating design load for the home.")
        .nullable()
        .optional(),

      /** Sensible cooling design load. The vendor publishes an empty description for this field. */
      coolingSensibleDesignLoad: z
        .string()
        .describe("Sensible cooling design load for the home.")
        .nullable()
        .optional(),

      /** Latent cooling design load. The vendor publishes an empty description for this field. */
      coolingLatentDesignLoad: z
        .string()
        .describe("Latent cooling design load for the home.")
        .nullable()
        .optional(),

      /**
       * Winter outdoor design temperature in °F — the vendor's regional default unless
       * overridden.
       */
      designTempWinterOutdoor: z.number().nullable().optional(),

      /** Summer outdoor design temperature in °F. */
      designTempSummerOutdoor: z.number().nullable().optional(),

      /** Winter indoor design temperature in °F. */
      designTempWinterIndoor: z.number().nullable().optional(),

      /** Summer indoor design temperature in °F. */
      designTempSummerIndoor: z.number().nullable().optional(),

      /** Total units in the multi-family building this unit belongs to. */
      numberOfUnits: z.number().nullable().optional(),

      /** Override count of LEDs. */
      numberOfLeds: z.number().nullable().optional(),

      /**
       * Whether the crawlspace rim joist is treated the same as the crawl wall, or
       * separately.
       */
      crawlspaceRimJoistTreatment: CrawlspaceRimJoistTreatment.nullable().optional(),

      /** Rim-joist insulation R-value in the crawlspace. */
      crawlspaceRimJoistInsulation: z.number().nullable().optional(),

      /** Total assembly R-value of the crawlspace rim joists. */
      crawlRimJoistAssemblyRValue: z.number().nullable().optional(),

      /**
       * Whether the basement rim joist is treated the same as the basement wall, or
       * separately.
       */
      basementRimJoistTreatment: BasementRimJoistTreatment.nullable().optional(),

      /** Rim-joist insulation R-value in the basement. */
      basementRimJoistInsulation: z.number().nullable().optional(),

      /** Total assembly R-value of the basement rim joists. */
      basementRimJoistAssemblyRValue: z.number().nullable().optional(),

      /**
       * Electrical demand in kW. The WRITE endpoint spells this `demandKW` with a capital W;
       * the response schema spells it `demandKw` — a vendor casing bug, and a mapping keyed
       * on the response name silently drops the field.
       */
      demandKW: z.number().describe("Electrical demand in kilowatts.").nullable().optional(),

      /**
       * Electrical demand savings in kW — same capital-W wire spelling as `demandKW`. Spec
       * types this `string`; `write` stringifies.
       */
      demandKWSavings: z
        .number()
        .describe("Electrical demand savings in kilowatts.")
        .nullable()
        .optional(),

      /** Ambient CO monitored through the whole assessment, in ppm. */
      cazMaxAmbientCo: z
        .number()
        .describe(
          "Ambient carbon monoxide in parts per million — a reading; the pass/fail verdict of the same test is health.healthAmbientCarbonMonoxide, never here.",
        )
        .nullable()
        .optional(),

      /** Whether the ASHRAE 62.2 ventilation-standard controls are turned on. */
      ashrae622: z.enum(["Yes", "No"]).nullable().optional(),

      /** Kitchen ventilation fan CFM rating. */
      ashraeKitchenFanCfm: z.number().nullable().optional(),

      /** Whether the kitchen has an operable window. */
      ashraeKitchenWindow: z.enum(["Yes", "No"]).nullable().optional(),

      /** Number of bathrooms WITH ventilation fans. */
      ashraeNumberOfBathrooms: AshraeNumberOfBathrooms.nullable().optional(),

      /** Bathroom 1 ventilation fan CFM rating. */
      ashraeBathroomFan1Cfm: z.number().nullable().optional(),

      /** Whether bathroom 1 has an operable window. */
      ashraeBathroom1Window: z.enum(["Yes", "No"]).nullable().optional(),

      /** Bathroom 2 ventilation fan CFM rating. */
      ashraeBathroomFan2Cfm: z.number().nullable().optional(),

      /** Whether bathroom 2 has an operable window. */
      ashraeBathroom2Window: z.enum(["Yes", "No"]).nullable().optional(),

      /** Bathroom 3 ventilation fan CFM rating. */
      ashraeBathroomFan3Cfm: z.number().nullable().optional(),

      /** Whether bathroom 3 has an operable window. */
      ashraeBathroom3Window: z.enum(["Yes", "No"]).nullable().optional(),

      /** Bathroom 4 ventilation fan CFM rating. */
      ashraeBathroomFan4Cfm: z.number().nullable().optional(),

      /** Whether bathroom 4 has an operable window. */
      ashraeBathroom4Window: z.enum(["Yes", "No"]).nullable().optional(),

      /** Additional continuous whole-house ventilation required by ASHRAE 62.2-2013, in CFM. */
      ashraeRequiredAdditionalCfm: z
        .number()
        .describe(
          'Required continuous whole-house ventilation in CFM; the vendor\'s "N/A" state (no additional requirement) stays null.',
        )
        .nullable()
        .optional(),

      /** Floor cavity insulation material. */
      floorCavityInsulationType: FloorCavityInsulationType.nullable().optional(),

      /** Floor continuous insulation material. */
      floorContinuousInsulationType: FloorContinuousInsulationType.nullable().optional(),

      /** Whether the frame-floor skirt is present. */
      floorSkirtPresent: z.enum(["Yes", "No"]).nullable().optional(),

      /** Condition of the wing insulation. */
      floorWingInsulationCondition: FloorWingInsulationCondition.nullable().optional(),

      /** Condition of the belly insulation. */
      floorBellyInsulationCondition: FloorBellyInsulationCondition.nullable().optional(),

      /** Frame floor type. */
      floorFrameFloorType: FloorFrameFloorType.nullable().optional(),

      /** Whether the floor insulation sits above or below the ducts. */
      floorInsulationLocation: FloorInsulationLocation.nullable().optional(),

      /** Crawlspace ceiling cavity insulation material. */
      crawlCavityInsulationType: CrawlCavityInsulationType.nullable().optional(),

      /** Crawlspace wall continuous insulation material. */
      crawlWallInsulationType: CrawlWallInsulationType.nullable().optional(),

      /** Crawlspace rim-joist cavity insulation material. */
      crawlspaceRimJoistInsulationType: CrawlspaceRimJoistInsulationType.nullable().optional(),

      /** Basement wall cavity insulation material. */
      basementCavityInsulationType: BasementCavityInsulationType.nullable().optional(),

      /** Basement wall continuous insulation material. */
      basementContinuousInsulationType: BasementContinuousInsulationType.nullable().optional(),

      /** Basement rim-joist cavity insulation material. */
      basementRimJoistInsulationType: BasementRimJoistInsulationType.nullable().optional(),

      /**
       * Whether occupants use operable windows to cool the home when outdoor conditions
       * allow.
       */
      windowVentingUsed: z.enum(["Yes", "No"]).nullable().optional(),

      /** Slab area below conditioned space, in ft². */
      modeledSlabFloorArea: z.number().nullable().optional(),

      /** Total heat-tape length, in feet. */
      heatTapeLength: z.number().nullable().optional(),

      /** Heat-tape load, in watts per foot. */
      heatTapeLoad: z.number().nullable().optional(),

      /** Hours per day the heat tape is on. */
      heatTapeDailyFrequency: z.number().nullable().optional(),

      /** Days per year the heat tape is on. */
      heatTapeAnnualFrequency: z.number().nullable().optional(),

      /**
       * Whether the household has an EV. The spec publishes an INTEGER enum `[1, 0]`;
       * `enveloped()` has no numeric-enum leaf, so this is `z.number()` and the 1/0
       * vocabulary travels in the description.
       */
      hasEv: z
        .number()
        .describe("Whether the household has an EV; the wire value is integer 1 (yes) or 0 (no).")
        .nullable()
        .optional(),

      /** Total miles driven by the household's EVs per year. */
      evMilesDrive: z.number().nullable().optional(),

      /** Average EV efficiency in kWh per 100 miles driven. */
      evEfficiency: z.number().nullable().optional(),

      /** Percent of EV charging that happens on this home's meter. */
      evHomeChargingPercent: z.number().nullable().optional(),

      /** kWh per year of EV home charging on this home's meter. */
      evHomeChargingAmount: z.number().nullable().optional(),

      /** Simple vs. detailed EV-charging calculation. */
      evCalculationMethod: EvCalculationMethod.nullable().optional(),

      /**
       * Whether the EV charger is ENERGY STAR certified. The vendor's published
       * description is a stringified `undefined`, which `cleanVendorDescription` strips.
       */
      evEnergyStarCharger: z
        .enum(["Yes", "No"])
        .describe("Whether the EV charger is ENERGY STAR certified.")
        .nullable()
        .optional(),

      /** Main service panel capacity, in amps. */
      mainServicePanelMaxAmps: z.number().nullable().optional(),

      /** Number of open breaker spots in the main panel. */
      openBreakerSpots: z.number().nullable().optional(),

      /** Cavity insulation R-value of the basement ceiling. */
      basementCeilingCavityInsulation: z.number().nullable().optional(),

      /** Basement ceiling cavity insulation material. */
      basementCeilingCavityInsulationType:
        BasementCeilingCavityInsulationType.nullable().optional(),

      /** Continuous insulation R-value on the basement ceiling. */
      basementCeilingContinuousInsulation: z.number().nullable().optional(),

      /** Basement ceiling continuous insulation material. */
      basementCeilingContinuousInsulationType:
        BasementCeilingContinuousInsulationType.nullable().optional(),

      /** Total assembly R-value of the basement ceiling system. */
      basementCeilingAssemblyRValue: z.number().nullable().optional(),

      /** Mechanical ventilation type. */
      ventilationType: VentilationType.nullable().optional(),

      /** Whether the ventilation runs continuously or intermittently. */
      ventilationSchedule: VentilationSchedule.nullable().optional(),

      /** Hours between ventilation cycles — the every-N-hours of an intermittent schedule. */
      ventilationCycleFrequency: z.number().nullable().optional(),

      /** Hours each ventilation cycle runs — the for-N-hours of an intermittent schedule. */
      ventilationCycleDuration: z.number().nullable().optional(),

      /** Mechanical ventilation fan flow rate, in CFM. */
      ventilationFlowRate: z.number().nullable().optional(),

      /** Max rated sensible recovery efficiency, per the HVI product directory. */
      ventilationSensibleRecoveryEfficiency: z.number().nullable().optional(),

      /** Latent recovery / moisture transfer, per the HVI product directory. */
      ventilationTotalRecoveryEfficiency: z.number().nullable().optional(),

      /** Ventilation fan input power at max rated SRE, per the HVI product directory. */
      ventilationFanPower: z.number().nullable().optional(),

      /** Whether the whole home is professionally air sealed. */
      wholeHomeIsProfessionallyAirSealed: z.enum(["Yes", "No"]).nullable().optional(),
    }),
  )
  .strict();

/**
 * `POST /jobs/{jobId}/hvac` — one heating/cooling system record. 12 of its 73
 * fields. The writable surface carries this as an array because a job may have
 * several systems; each element is one record.
 *
 * The two `required` fields in the whole capture surface are both here; see
 * `adapter.ts`'s `requiredOnCreate`.
 */
export const HvacFields = z
  .object(
    withVendorDescriptions({
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
    }),
  )
  .strict();

/** `POST /jobs/{jobId}/attic` — one attic record. 5 of its 35 fields. */
export const AtticFields = z
  .object(
    withVendorDescriptions({
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
    }),
  )
  .strict();

/** `POST /jobs/{jobId}/wall` — one wall assembly record. 4 of its 17 fields. */
export const WallFields = z
  .object(
    withVendorDescriptions({
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
    }),
  )
  .strict();

/** `POST /jobs/{jobId}/window` — one window group record. 3 of its 34 fields. */
export const WindowFields = z
  .object(
    withVendorDescriptions({
      /** Glazing, including the storm and low-e variants. */
      windowType: WindowType.nullable().optional(),

      /** Frame material. */
      windowFrame: WindowFrame.nullable().optional(),

      /** Energy Star rated. */
      windowEnergyStar: z.enum(["Yes", "No"]).nullable().optional(),
    }),
  )
  .strict();

/** `POST /jobs/{jobId}/dhw` — one water heater record. 6 of its 48 fields. */
export const DhwFields = z
  .object(
    withVendorDescriptions({
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
    }),
  )
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
  .object(
    withVendorDescriptions({
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
    }),
  )
  .strict();

// --- The field set, as a writable patch --------------------------------------
// 207 leaves across 7 resource groups — the full 163-field `basedata` capture
// surface plus the 44 bounded component-group leaves. Every leaf is
// `X.nullable().optional()` and every object is `.strict()`; see the file header
// for why both halves of that are load-bearing.
//
// Five groups are per-instance child resources (API creates one record per element
// with `POST /jobs/{jobId}/<type>`), so they are `z.array(...).optional()`.
// `basedata` and `health` are genuine singletons and stay objects.

export const snuggValuesSchema = z
  .object({
    basedata: BasedataFields.optional(),
    hvac: z.array(HvacFields).optional(),
    attic: z.array(AtticFields).optional(),
    wall: z.array(WallFields).optional(),
    window: z.array(WindowFields).optional(),
    dhw: z.array(DhwFields).optional(),
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

// --- The platform-route caps (R3 Task 5) -------------------------------------
// The structured-output route the extractor sends to rejects a schema that is too
// big or too deep, with an HTTP 400 whose text names both limits verbatim. The
// whole R3 per-group increment exists because the full `snuggExtractionSchema`
// with vendor descriptions is 128,858 characters against the character cap — one
// call carrying it is over, and with the full 163-field `basedata` group even one
// call per top-level group is over (`basedata` alone is ~94k). What fits is the
// partitioned piece: `perGroupExtractor` always splits at 8 enveloped leaves, and
// the largest resulting piece measures ~7.4k. These constants turn that
// production HTTP 400 into a failing build: the per-group cap test
// (per-group-cap.test.ts) asserts every partitioned piece's serialized JSON
// Schema sits under both ceilings, so a future field that breaks one fails the
// test rather than a real extraction in the field.

/**
 * The maximum serialized character count the structured-output route accepts in
 * `response_format.json_schema.schema`.
 *
 * The vendor's own error text: `schema must serialize to <= 32768 characters and
 * nest <= 12 levels`. Both limits are named in that one message, and only the
 * nesting one was ever checked (by `extraction-shape.test.ts` against OpenAI's
 * documented 10-level ceiling — a different, stricter source). This constant
 * guards the character half. Measured today: the largest PER-CALL schema is the
 * largest 8-leaf partitioned piece at ~7.4k characters, comfortably under. The
 * whole unpartitioned `basedata` group is ~94k and the full schema ~129k — over
 * the cap — which is why the guard runs on the partitioned pieces
 * `perGroupExtractor` actually sends, never on a group as a whole.
 */
export const SCHEMA_SERIALIZED_CHAR_CAP = 32_768;

/**
 * The maximum nesting depth the structured-output route accepts. The vendor's
 * error text names this alongside the character cap: `schema must serialize to
 * <= 32768 characters and nest <= 12 levels`.
 */
export const SCHEMA_NESTING_DEPTH_CAP = 12;
