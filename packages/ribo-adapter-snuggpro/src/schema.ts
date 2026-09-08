/**
 * The Snugg Pro energy-audit capture field set, built from the machine-readable
 * spec (`https://app.snuggpro.com/apidocs/swagger.json`, reconciled
 * field-by-field in docs/implementation/17-snuggpro-field-reconciliation.md):
 *
 *   1. **Keys are the wire names** — no rename table between schema and API.
 *   2. **Enum members are the wire strings, verbatim** — Title Case, spaces,
 *      slashes, percent signs and all, so no write-time lookup table.
 *   3. **Nesting is the resource layout** — one group per write endpoint
 *      (`basedata` singleton, per-instance component and job-collection
 *      resources, `stage` singleton), so `write` dispatches on the group key.
 *
 * Scoping: `basedata` is the FULL honest capture surface of its endpoint (doc 17
 * §Scoping — the form fields minus the `*Improved` retrofit twins and the
 * self-described auto-calculated fields). The component groups are bounded
 * dictation-density subsets — what an auditor actually says walking a house —
 * grown from real fill-rate data, not judgement; `window` has since grown to
 * doc 20 §5.5's verdicted capture surface (its `capture`/`capture?` fields,
 * base and improved sides — see the group). The job-collection groups each
 * carry every field of their endpoint in extraction scope (`incentive`'s
 * `recommendations` is excluded by design — see the group).
 *
 * ---
 *
 * TWO SHAPES LIVE HERE (design `r1.5-field-shape-contracts-design.md` §2.1–§2.3):
 *
 *   - `snuggValuesSchema` — the WRITABLE PATCH: what a review produces and what
 *     `write` sends. Hand-written, the source of truth. Every leaf is
 *     `X.nullable().optional()` and both halves are load-bearing:
 *       * `.nullable()` — a `null` is a real WRITTEN value (Snugg Pro's
 *         `"Not Tested"` state; see `HealthTestState`). "Write this empty" is
 *         not "leave this alone".
 *       * `.optional()` — a REJECTED leaf is absent from the patch entirely
 *         (`resolveReview` omits it), and the rest still write.
 *
 *   - `snuggExtractionSchema` — what the MODEL produces, derived by
 *     `enveloped()`: optionality stripped, each leaf wrapped in `ribo-core`'s
 *     provenance envelope, closed and fully required at every level so the
 *     anti-hallucination rule holds (the model must emit an explicit `null`,
 *     never omit a key). The derivation recurses into the groups, so every leaf
 *     gets its own envelope and review addresses dotted leaf paths
 *     (`"hvac.hvacDuctLeakage"`) — one envelope per group would make a group
 *     un-reviewable field by field.
 *
 * The two differ in optionality BY CONSTRUCTION. The derivation is pinned
 * byte-for-byte by `extraction-shape.test.ts` against a frozen JSON Schema
 * fixture.
 *
 * ---
 *
 * THE FOUR HAZARDS this field set exists to get right:
 *
 *   1. FUEL IS A SEPARATE AXIS from equipment. "Oil boiler" decomposes into
 *      `{ "Boiler", "Fuel Oil" }` across `hvacSystemEquipmentType` and
 *      `hvacHeatingEnergySource` — never one fused token.
 *   2. ATTIC INSULATION IS A DEPTH BAND *and also* an R-value.
 *      `atticInsulationDepth` is an inches bucket ("10-12"); `atticInsulation`
 *      is the total R-value as a number. Both are real, independent write
 *      targets and nothing converts between them — the conversion is climate-
 *      and material-dependent, and with both fields existing, unnecessary.
 *   3. HEALTH & SAFETY IS A FIXED-STATE MATRIX, not free text. Each named test
 *      is `"Passed"` / `"Failed"` / `"Warning"` / `"Not Tested"`; "CO was clean"
 *      is `"Passed"`, and a test never mentioned is `null`.
 *   4. EQUIPMENT EFFICIENCY (AFUE / SEER / HSPF) IS NOT A CAPTURE FIELD. The
 *      vendor derives it by lookup from make / model / year, not dictated. We
 *      capture the inputs and deliberately have no efficiency slot.
 *
 * ---
 *
 * Contract (docs 03 + 05), restated so it travels with the file:
 *
 *   1. In the EXTRACTION schema every field is `nullable` + REQUIRED, never
 *      `.optional()` — the model must emit an explicit `null` for "not
 *      mentioned". `enveloped()` guarantees it by stripping the patch's
 *      optionality.
 *   2. Every extraction field is wrapped in `{ value, confidence, sourceSpan }`
 *      (`ribo-core`'s `extractedSchema`). A `null` value can still carry a
 *      verbatim span ("no ducts, it's hydronic"), and `confidence` is a bare
 *      `z.number()` because `.min()`/`.max()` would emit the
 *      `minimum`/`maximum` keywords strict structured-output mode rejects
 *      (clamped in `normalization.ts`).
 *   3. The EXTRACTION schema is strict-structured-output compatible: no
 *      `.optional()`, no unions of objects, no `minimum`/`maximum`/`pattern`
 *      keywords, all objects closed and all properties required. The PATCH is
 *      deliberately the opposite and never reaches the model.
 *   4. Extract what was SAID; normalize in code. Unit coercion, spoken-number ->
 *      int and band bucketing are a deterministic pass after extraction
 *      (`normalization.ts`).
 *
 * ---
 *
 * KNOWN DIVERGENCES from the spec, recorded rather than hidden:
 *
 *   - **Numeric year/size/temperature fields** (`yearBuilt`, setpoints, design
 *     temperatures, appliance model years, `demandKWSavings`, …) are typed
 *     `string` in the spec because they are form inputs, but modelled
 *     `z.number()` here — that is what they mean and what a reviewer edits;
 *     `write` stringifies (doc 17 rows 5/12).
 *   - **`hasEv` is an INTEGER enum `[1, 0]` in the spec.** `enveloped()` has no
 *     numeric-enum leaf (zod's `z.enum` is strings-only, literal unions
 *     unsupported), so it is `z.number()` and the vocabulary travels in its
 *     description.
 *   - **`stage.stageId`'s valid codes exist only in the spec's description
 *     prose** — `POST /jobs/{jobId}/stage` publishes no `enum` key (doc 20
 *     §5.1). Same constraint as `hasEv`: `z.number()`, codes in the
 *     description.
 */

import { enveloped } from "@azx/ribo-core";
import type { Enveloped } from "@azx/ribo-core";
import { z } from "zod";

import { stripOptionalNullable } from "@azx/ribo-core";

import { VENDOR_DESCRIPTIONS } from "./descriptions.generated.js";

// --- Enumerations -----------------------------------------------------------
// Every member is COPIED VERBATIM from the swagger spec's `enum` array — do not
// tidy casing, spacing, percent signs or inch marks; a "cleaned up" member is a
// write that fails at the API. `enum: []` in the spec means Snugg publishes no
// value list; called out per-field where it happens.

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
 * guess. Auditors distinguish these out loud ("I'll estimate it at three
 * thousand"), so it is a genuine capture field, not bookkeeping.
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
 * `clothesWasherManufacturer` — `POST /jobs/{jobId}/basedata`. The vendor list
 * carries both "Frigidaire" and its own "Fridgidaire" typo — both stay verbatim.
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
 * `dishwasherManufacturer` — `POST /jobs/{jobId}/basedata`. The vendor list
 * carries both "Frigidaire" and its own "Fridgidaire" typo — both stay verbatim.
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
 * `poolPumpType` — `POST /jobs/{jobId}/basedata`. The spec's list leads with a
 * literal `null` member; that empty state is the leaf's `.nullable()`, not an
 * enum member — the rule `WallCavityInsulationType` records.
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
 * `floorFrameFloorType` — `POST /jobs/{jobId}/basedata`. The spec publishes a
 * lone member for this list.
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
 * `basementCavityInsulationType` — `POST /jobs/{jobId}/basedata`. The spec's
 * list leads with a literal `null` member; that empty state is the leaf's
 * `.nullable()`, not an enum member — the rule `WallCavityInsulationType`
 * records.
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
 * `basementCeilingContinuousInsulationType` — `POST /jobs/{jobId}/basedata`.
 * The spec's list leads with a literal `null` member; that empty state is the
 * leaf's `.nullable()`, not an enum member — the rule
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
 * ONE field for heating AND cooling equipment, on a per-system record that may
 * itself be a combined unit — hence members like `"Furnace / Central AC (shared
 * ducts)"`. Splitting heating and cooling into two fields would produce two
 * writes where the API expects one record.
 *
 * Fuel is a separate axis (`hvacHeatingEnergySource`): "oil boiler" is `"Boiler"`
 * here and `"Fuel Oil"` there, never one fused token.
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
 * `hvacUpgradeAction` (`hvac`, **required**) — an extraction field, not a
 * write-time constant. Doc 15's B2 recommended hard-coding it (retrofit
 * decisions happen later at a desk), but recommending retrofits is the auditor's
 * job and they narrate it: "there's an oil boiler here, we should get rid of it"
 * carries `"Remove a system permanently"` as plainly as `"Boiler"` (doc 17,
 * owner correction of 2026-08-06).
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
 * The spec declares this property with `enum: []` — no published value list. The
 * members below are the verbatim list from `dhwFuel2` on the sibling `dhw`
 * resource, the closest published fuel vocabulary in the document (doc 17 §2 row
 * 2). **The one enum here inferred rather than copied** — the first thing to
 * check if an HVAC write is rejected.
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
 * text: a real make that is not on Snugg's list (e.g. "Burnham") maps to
 * `"Other"`, a real answer, instead of failing at write.
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
 * The vendor's wire values use double-quote inch marks (`Duct Board 1.5"`), and
 * the platform's structured-output route (`POST <base>/_api/llm/chat`) rejects a
 * schema whose enum contains a double quote with a generic `400
 * validation_failed` (verified against the live route). So this enum uses
 * quote-free aliases spelling the inch out ("1.5 inch"), and `normalization.ts`'s
 * `DUCT_INSULATION_VENDOR_LITERALS` maps each alias back to the vendor's literal
 * for write-back. Members that never carried a quote need no translation and
 * appear in neither the alias set nor the lookup table.
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
 * HAZARD 2a — `atticInsulationDepth` (`POST /jobs/{jobId}/attic`), a depth band
 * in INCHES. Set when the auditor states a depth or thickness; a stated R-value
 * goes in `atticInsulation` instead and this stays `null`. Nothing converts
 * between them — the conversion is climate- and material-dependent, and with
 * both fields real, unnecessary.
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
 * `wallsInsulated` (`POST /jobs/{jobId}/wall`) — graded states, not a boolean.
 * `"Well"` is distinct from a bare `"Yes"`: "insulated, and done properly"
 * versus "there is something in there". "Some but thin" is `"Poorly"`.
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
 * `null` member; that empty state is the leaf's `.nullable()`, not an enum
 * member — a `null` in an enum would emit a mixed-type `enum` array that strict
 * structured-output mode rejects. Several other lists record the same rule.
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
 * `windowType` (`POST /jobs/{jobId}/window`) — glazing, including the
 * triple-pane, storm and low-e variants an auditor actually calls out.
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

/**
 * `windowExteriorTreatment{North,East,South,West}` and their `*Improved` twins
 * (`window`) — ONE list shared by all four orientations and all four upgrade
 * intents (doc 20 §5.0 WINDOW-EXTERIOR-TREATMENT); the spec publishes the
 * identical member set on all eight fields. The treatment is what the SHGC
 * fields must NOT be adjusted for — see `windowSolarHeatGainCoefficient`.
 */
export const WindowExteriorTreatment = z.enum([
  "Insect Screen (full)",
  "Insect Screen (half)",
  "Solar Screen (summer only)",
  "Solar Screen (all year)",
  "Solar Shades, Vertical Roller (summer only)",
  "Solar Shades, Vertical Roller (all year)",
  "Solar Shades, Louvered (summer only)",
  "Solar Shades, Louvered (all year)",
  "Solar Film (all year)",
  "No Treatment",
]);

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

/** `dhwAge` (`dhw`) — a banded age in years. "About twelve years" -> `"11-15"`. */
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
 * FIXED enum, not free text; every named test takes exactly one of these.
 *
 *   "Passed"      — run, came back clean.
 *   "Failed"      — run, found a real problem.
 *   "Warning"     — run, borderline / a caution.
 *   "Not Tested"  — explicitly skipped / deferred / could not be done.
 *
 * A test NEVER MENTIONED is `null`, NOT `"Not Tested"` — "explicitly skipped"
 * vs. "never came up" is information the review card wants. The write layer
 * renders BOTH as Snugg's `"Not Tested"` (the API has no null). This is why the
 * patch leaf is `.nullable()` and not merely `.optional()`: `null` means WRITE
 * `"Not Tested"`, while an absent key means "rejected — do not touch it".
 */
export const HealthTestState = z
  .enum(["Passed", "Failed", "Warning", "Not Tested"])
  .describe(
    'A clean result is "Passed"; "Not Tested" means the auditor explicitly skipped the test, and a test never mentioned is null — not "Not Tested".',
  );

/**
 * `healthRoofCondition` and `healthDrainageSystemCondition` (`health`) — the
 * health endpoint's condition-judgement fields, on one shared enum: the roof's
 * condition, and whether gutters and grading ("the drainage system") look fine
 * — both said out loud from the driveway.
 */
export const HealthCondition = z.enum(["Good", "Potential Issues", "NA"]);

// --- The resource groups ----------------------------------------------------
// One group per write endpoint. Each is `.strict()` and each leaf is
// `X.nullable().optional()`; the group itself is `.optional()` so a review that
// rejected every leaf in a group writes no request to that endpoint at all.
//
// `enveloped()` RECURSES into these rather than wrapping each whole, so every
// leaf gets its own provenance envelope and review can show the exact quote
// behind each one — one envelope per group would make its leaves un-reviewable
// individually.

/**
 * `POST /jobs/{jobId}/basedata` — the house-level singleton: the FULL honest
 * capture surface of doc 17 §Scoping (the endpoint's form fields minus the
 * `*Improved` retrofit twins and the self-described auto-calculated fields).
 * Not a dictation-density subset.
 */
/**
 * Some vendor descriptions are a stringified JS `undefined`. Strip the artifact
 * so it never reaches the model's prompt; whatever survives ("Field options:
 * 1 → Yes 0 → No") is real vendor text and stays. Filtering happens here, not
 * in `pnpm snugg:refresh` — `descriptions.generated.ts` stays vendor-faithful.
 */
function cleanVendorDescription(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const cleaned = text.replace(/^undefined\s*/i, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Compose the vendor's own description with ours, per leaf.
 *
 * The vendor sentence says what the field IS — the same text a Snugg Pro user
 * reads, anchoring our vocabulary to theirs. Ours says what mistake NOT to make
 * ("never ACH50, never CFM25"), which no vendor description contains. Vendor
 * first: the definition orients the model before the prohibition constrains it.
 *
 * Applied per group rather than per call site — the leaf's own `.describe()` is
 * read back out and appended, so a note written the obvious way is picked up
 * automatically. Leaves the vendor does not describe keep their note alone.
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
       * Electrical demand in kW. The WRITE endpoint spells this `demandKW` with a
       * capital W; the response schema spells it `demandKw` — a vendor casing bug,
       * and keying on the response name silently drops the field.
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
       * Whether the household has an EV. The spec publishes an INTEGER enum
       * `[1, 0]`; `enveloped()` has no numeric-enum leaf, so this is
       * `z.number()` and the vocabulary travels in the description.
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
 * `POST /jobs/{jobId}/hvac` — one heating/cooling system record, a bounded
 * dictation-density subset of the endpoint. The writable surface carries this
 * as an array because a job may have several systems; each element is one
 * record. The API's required capture fields live here — see `adapter.ts`'s
 * `requiredOnCreate`.
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

/** `POST /jobs/{jobId}/attic` — one attic record, a bounded subset of the endpoint. */
export const AtticFields = z
  .object(
    withVendorDescriptions({
      /** Depth BAND in inches. Set from a stated depth, never converted from an R-value. */
      atticInsulationDepth: AtticInsulationDepth.nullable().optional(),

      /** Insulation material. */
      atticInsulationType: AtticInsulationType.nullable().optional(),

      /**
       * Total installed R-value, as a number: "R-38 up top" -> 38. A REAL write
       * target, independent of the depth band — never converted to or from one.
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

/** `POST /jobs/{jobId}/wall` — one wall assembly record, a bounded subset of the endpoint. */
export const WallFields = z
  .object(
    withVendorDescriptions({
      /** Graded states, not boolean. "Some but thin" -> `"Poorly"`. */
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

/**
 * `POST /jobs/{jobId}/window` — one window-system record, carrying doc 20 §5.5's
 * verdicted capture surface of the endpoint: everything but the three
 * already-covered fields and `windowHesSpecs`, which is EXCLUDED because it is a
 * product-MODE flag ("Snugg Score jobs, not audits") that switches which other
 * fields the API demands — it is set by the writer, never extracted from a
 * transcript (doc 20 §5.5, §4.5).
 *
 * THE SPATIAL AXIS IS A FIELD SUFFIX, NOT AN INSTANCE: window is the one resource
 * with orientation baked into the wire names, so "the west windows" IS
 * addressable — as `windowAreaWest` and its siblings — while "the front bedroom
 * windows" is not addressable at all. A dictated orientation never becomes a
 * second instance; multiple window SYSTEMS per job ("if more than one type of
 * window is installed, add a second window system") are unnamed, and instance
 * identity stays the roster's job (`inventory.ts`).
 *
 * The `*Improved` area fields are NOT retrofit echoes of their base twins: they
 * are how the vendor encodes WHICH windows get replaced — dictated intent, kept
 * per the foundation design's decision 3.
 */
export const WindowFields = z
  .object(
    withVendorDescriptions({
      /** Glazing, including the storm and low-e variants. */
      windowType: WindowType.nullable().optional(),

      /** Frame material. */
      windowFrame: WindowFrame.nullable().optional(),

      /** Energy Star rated. */
      windowEnergyStar: z.enum(["Yes", "No"]).nullable().optional(),

      /** Average gross U-value incl. frame effects — a sticker reading or a modelled number. */
      windowEfficiency: z
        .number()
        .describe(
          "Average gross window U-value including frame effects — off an NFRC sticker if the auditor read one, otherwise a modelled number; set it only when one was actually stated.",
        )
        .nullable()
        .optional(),

      /** Total EXISTING window area on the north elevation of this system. */
      windowAreaNorth: z.number().nullable().optional(),

      /** Total EXISTING window area on the east elevation. */
      windowAreaEast: z.number().nullable().optional(),

      /** Total EXISTING window area on the south elevation. */
      windowAreaSouth: z.number().nullable().optional(),

      /** Total EXISTING window area on the west elevation. */
      windowAreaWest: z.number().nullable().optional(),

      /** % of EXPOSED north wall area that is glass — the alternative to the absolute area field. */
      windowNorthAreaPercent: z
        .number()
        .describe(
          "Percentage of the EXPOSED north wall area that is glass — the alternative to the absolute area field; auditors give window counts and sizes, not percentages, so set this only when a percentage was actually stated.",
        )
        .nullable()
        .optional(),

      /** % of EXPOSED east wall area that is glass. */
      windowEastAreaPercent: z
        .number()
        .describe(
          "Percentage of the EXPOSED east wall area that is glass — the alternative to the absolute area field; set it only when a percentage was actually stated.",
        )
        .nullable()
        .optional(),

      /** % of EXPOSED south wall area that is glass. */
      windowSouthAreaPercent: z
        .number()
        .describe(
          "Percentage of the EXPOSED south wall area that is glass — the alternative to the absolute area field; set it only when a percentage was actually stated.",
        )
        .nullable()
        .optional(),

      /** % of EXPOSED west wall area that is glass. */
      windowWestAreaPercent: z
        .number()
        .describe(
          "Percentage of the EXPOSED west wall area that is glass — the alternative to the absolute area field; set it only when a percentage was actually stated.",
        )
        .nullable()
        .optional(),

      /** Average gross SHGC — NEVER adjusted for screens or shades. */
      windowSolarHeatGainCoefficient: z
        .number()
        .describe(
          'Average gross Solar Heat Gain Coefficient. Never adjust it for screens or shades — a dictated "it has solar screens" is that orientation\'s windowExteriorTreatment field, not an adjustment to this number.',
        )
        .nullable()
        .optional(),

      /** Average overhang width in feet, north elevation. */
      windowNorthOverhangDepth: z.number().nullable().optional(),

      /** Average overhang width in feet, east elevation. */
      windowEastOverhangDepth: z.number().nullable().optional(),

      /** Average overhang width in feet, south elevation. */
      windowSouthOverhangDepth: z.number().nullable().optional(),

      /** Average overhang width in feet, west elevation. */
      windowWestOverhangDepth: z.number().nullable().optional(),

      /** Exterior shading device on the north windows — highly dictatable. */
      windowExteriorTreatmentNorth: WindowExteriorTreatment.nullable().optional(),

      /** Exterior shading device on the east windows. */
      windowExteriorTreatmentEast: WindowExteriorTreatment.nullable().optional(),

      /** Exterior shading device on the south windows. */
      windowExteriorTreatmentSouth: WindowExteriorTreatment.nullable().optional(),

      /** Exterior shading device on the west windows ("solar screens on the west side"). */
      windowExteriorTreatmentWest: WindowExteriorTreatment.nullable().optional(),

      /** Target U-value of the replacement glazing — improved spec. */
      windowEfficiencyImproved: z
        .number()
        .describe(
          "Target U-value of the replacement glazing — the spec side of an upgrade; set it only when a replacement U-value was actually stated.",
        )
        .nullable()
        .optional(),

      /** Area of north windows ACTUALLY BEING REPLACED — dictated intent, not a spec. */
      windowAreaNorthImproved: z
        .number()
        .describe(
          "Area of the north windows actually being replaced — dictated replacement intent, not a retrofit spec; whatever is not named here is assumed unchanged.",
        )
        .nullable()
        .optional(),

      /** Area of east windows actually being replaced — intent encoding. */
      windowAreaEastImproved: z
        .number()
        .describe(
          "Area of the east windows actually being replaced — dictated replacement intent, not a retrofit spec; whatever is not named here is assumed unchanged.",
        )
        .nullable()
        .optional(),

      /** Area of south windows actually being replaced — intent encoding. */
      windowAreaSouthImproved: z
        .number()
        .describe(
          "Area of the south windows actually being replaced — dictated replacement intent, not a retrofit spec; whatever is not named here is assumed unchanged.",
        )
        .nullable()
        .optional(),

      /** Area of west windows actually being replaced — intent encoding. */
      windowAreaWestImproved: z
        .number()
        .describe(
          "Area of the west windows actually being replaced — dictated replacement intent, not a retrofit spec; whatever is not named here is assumed unchanged.",
        )
        .nullable()
        .optional(),

      /** Target SHGC of the replacement glazing — improved spec. */
      windowSolarHeatGainCoefficientImproved: z
        .number()
        .describe(
          "Target Solar Heat Gain Coefficient of the replacement glazing — the spec side of an upgrade; set it only when a replacement SHGC was actually stated.",
        )
        .nullable()
        .optional(),

      /** Shading device to be ADDED on the north — upgrade intent. */
      windowExteriorTreatmentNorthImproved: WindowExteriorTreatment.nullable().optional(),

      /** Shading device to be ADDED on the east — upgrade intent. */
      windowExteriorTreatmentEastImproved: WindowExteriorTreatment.nullable().optional(),

      /** Shading device to be ADDED on the south — upgrade intent. */
      windowExteriorTreatmentSouthImproved: WindowExteriorTreatment.nullable().optional(),

      /** Shading device to be ADDED on the west — upgrade intent. */
      windowExteriorTreatmentWestImproved: WindowExteriorTreatment.nullable().optional(),

      /** "Replace with ENERGY STAR windows" — upgrade intent. */
      windowEnergyStarImproved: z.enum(["Yes", "No"]).nullable().optional(),
    }),
  )
  .strict();

/** `POST /jobs/{jobId}/dhw` — one water heater record, a bounded subset of the endpoint. */
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
 * `POST /jobs/{jobId}/health` — HAZARD 3, the full test matrix plus the
 * condition-judgement and attestation fields: roof condition, drainage
 * condition, and the safety-questions disclosure. Every `formData` parameter of
 * the endpoint but the malformed `customFields` (doc 20 §5.8). Undiluted flue
 * CO and radon are real tests auditors dictate — the matrix must carry them.
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

      /** Not a test state — a condition judgement on its own enum. */
      healthRoofCondition: HealthCondition.nullable().optional(),

      /**
       * Not a test state either — the drainage system (gutters, grading) on the
       * same condition enum as the roof. "Gutters and grading look fine" is
       * `"Good"`, never `"Passed"`.
       */
      healthDrainageSystemCondition: HealthCondition.nullable().optional(),

      /**
       * Different in kind from the rest of the group (doc 20 §5.8): a compliance
       * ATTESTATION about a conversation with the homeowner, not a measurement or
       * test — set only from an explicit statement, never inferred from the tests
       * themselves having been run.
       */
      healthSafetyQuestionsDisclosed: z
        .enum(["Yes", "No"])
        .describe(
          "A compliance attestation about a conversation with the homeowner, not a test result. Set it only when the auditor explicitly says whether the safety-testing answers were disclosed to the homeowner; never infer it from the tests themselves having been run.",
        )
        .nullable()
        .optional(),
    }),
  )
  .strict();

/**
 * `POST /jobs/{jobId}/concern` — one homeowner-concern record: free-text fields
 * comprising the endpoint's entire writable surface (doc 20 §5.7). No enum, no
 * foreign key, no required field, and a `POST /jobs/concern/{uuid}` update twin
 * taking the same fields.
 *
 * A job-collection resource (`job-collections-foundation-design.md`): a
 * top-level key of `V` following the per-instance pattern — an array with one
 * element per real-world occurrence, repeating per job (0..n). It has no
 * natural name field, so instance identity rides the roster's discriminator
 * mechanism — the SUBJECT of the concern (noise vs. comfort vs. cost) — rather
 * than any leaf declared here. See `inventory.ts`.
 */
export const ConcernFields = z
  .object(
    withVendorDescriptions({
      /** A short sentence stating the concern. `maxLength: 255` in the spec. */
      concernSummary: z
        .string()
        .describe(
          "One short sentence stating the homeowner's concern in the words it was spoken in — the longer telling of the same concern goes in concernDetail, and an auditor's own finding is not a concern unless it was voiced as one.",
        )
        .nullable()
        .optional(),

      /** The longer description of the same concern, when one was spoken. */
      concernDetail: z
        .string()
        .describe(
          "The more detailed description of the same concern — only what was actually said; when only a one-liner was spoken, leave this null rather than padding it out.",
        )
        .nullable()
        .optional(),
    }),
  )
  .strict();

// == incentive ===============================================================
// A job-collection group (doc 20 §5.7; target model per
// `docs/roadmap/design/job-collections-foundation-design.md`).

/**
 * `POST /jobs/{jobId}/incentives` — one incentive record, created "from
 * template".
 *
 * The operation carries **no name, no description and no title**: the
 * incentive's identity comes entirely from the template it was instantiated
 * from, which in this schema is the captured `fromTemplateUuid` text itself.
 * Instance identity is the roster's job (`inventory.ts`): one incentive per
 * distinct rebate or program the auditor mentions, distinguished by that name
 * and/or its amount.
 *
 * The endpoint's `recommendations` field (an array of
 * `{uuid, selectedLineItems}`) is EXCLUDED from extraction: same-job UUIDs of a
 * resource this adapter does not build, dropped per the foundation design's
 * decision 4 — `recDefinitionId` has no listing endpoint anywhere in the spec
 * and a recommendation cannot be created from an empty state, so a
 * cross-reference to records that can never be written is data the app can
 * never use.
 */
export const IncentiveFields = z
  .object(
    withVendorDescriptions({
      /**
       * REQUIRED by the API at create time (doc 20 §5.7), and captured as PLAIN
       * FREE TEXT despite the name: the spoken rebate or program name, never a
       * resolved UUID. Per `runtime-reference-resolution-design.md`, the spoken
       * name IS the lookup key, and matching it against the program's real
       * template list (`GET /programs/{programId}/incentive-templates`) is a
       * review/write-time step that must be able to fail visibly — not an
       * extraction one. Nothing here validates, enumerates or resolves it.
       */
      fromTemplateUuid: z
        .string()
        .describe(
          "The rebate or program name the auditor spoke, as free text — despite the field name, never a UUID: resolving the spoken name against the program's real incentive-template list is a later, human-supervised step, not extraction's.",
        )
        .nullable()
        .optional(),

      /** The rebate amount in dollars: "a fifteen hundred dollar rebate" -> 1500. */
      amount: z
        .number()
        .describe(
          'The rebate amount in dollars as a number ("a fifteen hundred dollar rebate" → 1500).',
        )
        .nullable()
        .optional(),
    }),
  )
  .strict();

/**
 * `POST /jobs/{jobId}/stage` — the job's current workflow stage. A
 * job-collection resource (design `job-collections-foundation-design.md`) but a
 * SINGLETON, like `basedata` and `health`, not an array of instances — the
 * endpoint is a state transition on the job, not an instance create (doc 20
 * §5.1). Its sibling `stageChangeReason` is deliberately out of scope.
 */
export const StageFields = z
  .object(
    withVendorDescriptions({
      /**
       * The job's current workflow stage as an integer code.
       * `POST /jobs/{jobId}/stage` publishes NO `enum` key for this parameter —
       * its valid codes exist only in the description's prose (doc 20 §5.1).
       * `enveloped()` has no numeric-enum leaf (the same constraint `hasEv`
       * hit), so this is `z.number()` and the label→code vocabulary travels in
       * the description.
       */
      stageId: z
        .number()
        .describe(
          "The job's current workflow stage; the wire value is an integer code — 1 (Lead), 2 (Audit), 3 (Bid Proposed), 4 (Bid Approved), 5 (Retrofit In Progress), 6 (Retrofit Complete), 7 (QA), 8 (Uncategorized), 9 (Archived Won), 10 (Archived Lost).",
        )
        .nullable()
        .optional(),
    }),
  )
  .strict();

// --- The field set, as a writable patch --------------------------------------
// Every leaf is `X.nullable().optional()` and every object is `.strict()`; see
// the file header for why both halves are load-bearing.
//
// Per-instance child resources (the component resources plus `concern` and
// `incentive` — the API creates one record per element with
// `POST /jobs/{jobId}/<type>`) are `z.array(...).optional()`. `basedata`,
// `health` and `stage` are genuine singletons and stay objects.

export const snuggValuesSchema = z
  .object({
    basedata: BasedataFields.optional(),
    hvac: z.array(HvacFields).optional(),
    attic: z.array(AtticFields).optional(),
    wall: z.array(WallFields).optional(),
    window: z.array(WindowFields).optional(),
    dhw: z.array(DhwFields).optional(),
    health: HealthFields.optional(),
    concern: z.array(ConcernFields).optional(),
    incentive: z.array(IncentiveFields).optional(),
    stage: StageFields.optional(),
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
 * What the MODEL is asked to produce, derived from the patch — never
 * hand-written. `enveloped()` strips the patch's `.optional()`/`.nullable()`,
 * wraps each leaf in `ribo-core`'s provenance envelope, recurses into the
 * resource groups rather than swallowing each into one envelope, and closes
 * every object with every key required. See the file header, and
 * `extraction-shape.test.ts` for the frozen JSON Schema this derivation must
 * keep producing.
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
// The structured-output route the extractor sends to rejects a schema that is
// too big or too deep with an HTTP 400 naming both limits. The full
// `snuggExtractionSchema` with vendor descriptions exceeds the character cap —
// even one call per top-level group does — which is why the R3 per-group
// increment partitions the schema and sends the pieces. These constants plus
// the per-group cap test (per-group-cap.test.ts) turn that production HTTP 400
// into a failing build: every partitioned piece's serialized JSON Schema is
// asserted under both ceilings, so a future field that breaks one fails the
// test rather than a real extraction in the field.

/**
 * The maximum serialized character count the structured-output route accepts in
 * `response_format.json_schema.schema`.
 *
 * The vendor's own error text: `schema must serialize to <= 32768 characters and
 * nest <= 12 levels`. Only the nesting half was ever checked (by
 * `extraction-shape.test.ts`, against OpenAI's documented and stricter
 * ceiling); this constant guards the character half. The guard runs on the
 * partitioned pieces `perGroupExtractor` actually sends, never on a group as a
 * whole — an unpartitioned group can exceed the cap.
 */
export const SCHEMA_SERIALIZED_CHAR_CAP = 32_768;

/**
 * The maximum nesting depth the structured-output route accepts, named
 * alongside the character cap in the vendor's error text: `schema must
 * serialize to <= 32768 characters and nest <= 12 levels`.
 */
export const SCHEMA_NESTING_DEPTH_CAP = 12;
