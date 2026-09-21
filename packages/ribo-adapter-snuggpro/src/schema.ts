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
 *      resources, the `stage`, `job`, `report` and `utilities` singletons), so
 *      `write` dispatches on the group key.
 *
 * Scoping: `basedata` is the FULL honest capture surface of its endpoint (doc 17
 * §Scoping — the form fields minus the `*Improved` retrofit twins and the
 * self-described auto-calculated fields). The component groups are bounded
 * dictation-density subsets — what an auditor actually says walking a house —
 * grown from real fill-rate data, not judgement; `attic`, `wall`, `window` and
 * `door` have since grown to doc 20 §5.5's full verdicted capture surface (every
 * field but the computed ones, and the `capture?` fields described with the
 * caveat that makes them borderline — see the groups). The job-collection groups
 * each carry every field of their endpoint in extraction scope minus the computed
 * ones (`incentive`'s `recommendations` is excluded by design — see the group;
 * `report` carries its authored-text half only, its display-flag tranche being
 * separately deferred — see that group; `utilities` is a deliberately bounded
 * CORE subset of its endpoint — the per-period delivery windows and the
 * 12-month bill series are separate, out-of-scope tranches — see that group;
 * the appliances-and-pv groups defer their `*Improved` twins to the
 * improved-side tranche per the foundation design's decision 3).
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
 *   4. EQUIPMENT EFFICIENCY (AFUE / SEER / HSPF) IS LOOKED UP, NOT DICTATED.
 *      The vendor derives it from make / model / year, so the hvac efficiency
 *      leaves are `capture?` in doc 20's verdicts: they hold a STATED number
 *      only, never an estimated one. The exception is
 *      `hvacSteadyStateEfficiency` — a combustion-analyzer reading measured on
 *      site, which is an ordinary capture.
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
 *   - **The `job` group's numeric enums** — `POST /jobs` publishes real
 *     INTEGER enums for `stageId` and `jobType`, and `type: string` fields
 *     with integer members for `renterOwner` and
 *     `useStrictBpi2400Calibration` (doc 20 §4.5). Same constraint again —
 *     `enveloped()` has no numeric-enum leaf — so all four are `z.number()`
 *     with their vocabularies in their descriptions, the treatment
 *     `energyStarColdClimateHeatPump` established.
 *   - **`job.accountId` and `job.programId` are integer ids on the wire but
 *     PLAIN FREE TEXT here** — the spoken assignee/program name, resolved
 *     against the real id lists at review/write time per
 *     `runtime-reference-resolution-design.md`, the treatment
 *     `incentive.fromTemplateUuid` established.
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
 * `hvacCoolingSystemManufacturer` (`hvac`) — the COOLING brand list, a separate
 * closed enum from the heating one: the two lists genuinely differ (cooling
 * has `Coolerado` and `Comfort Maker` where heating has `Comfort Master`), and
 * both carry the vendor's `Frigidaire`/`Fridgidaire` typo pair verbatim.
 */
export const HvacCoolingSystemManufacturer = z
  .enum([
    "Unknown",
    "AirEase",
    "Amana",
    "American Standard",
    "Bosch",
    "Bryant",
    "Carrier",
    "Coleman",
    "Comfort Maker",
    "Coolerado",
    "Daikin",
    "Day & Night",
    "Frigidaire",
    "Fujitsu",
    "General Electric",
    "Goodman",
    "Janitrol",
    "Lennox",
    "LG",
    "Luxaire",
    "Mitsubishi",
    "Panasonic",
    "Payne",
    "Peerless",
    "Rheem",
    "RUUD",
    "Samsung",
    "Sears Kenmore",
    "Tappan",
    "Trane",
    "Utica",
    "York",
    "Other",
    "Fridgidaire",
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

/** `atticRoofType` (`attic`). `vaultRoofType` publishes the same list — one export. */
export const AtticRoofType = z.enum([
  "Composition Shingles",
  "Concrete Tile",
  "Wood Shakes",
  "Tar and Gravel",
]);

/**
 * `atticKneeWallInsulationType` (`attic`). The cavity-insulation vocabulary of doc 20
 * §5.0, copied verbatim; `largest-area wins` when several materials are installed.
 */
export const AtticKneeWallInsulationType = z.enum([
  "Fiberglass or Rockwool Batt",
  "Blown Fiberglass or Rockwool",
  "Cellulose",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Other",
]);

/**
 * `atticKneeWallContinuousInsulationType` (`attic`). The rigid-insulation vocabulary of
 * doc 20 §5.0, copied verbatim; largest-area wins.
 */
export const AtticKneeWallContinuousInsulationType = z.enum([
  "Rigid XPS",
  "Rigid EPS",
  "Rigid Polyisocyanurate",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Other",
]);

/**
 * `atticRoofColor` (`attic`). The vendor's list stops at `Medium` — there is no Dark
 * member, so a dictated dark roof has no member and stays `null` (rule 11).
 * `vaultRoofColor` publishes the same list — one export.
 */
export const AtticRoofColor = z.enum(["White", "Light", "Medium"]);

// == vault ===================================================================

/**
 * `vault` (`POST /jobs/{jobId}/vault`) — insulation quality of the vaulted cavities,
 * on a wire field named bare `vault`, identical to its resource name. The sibling of
 * `wallsInsulated`: identical member DESCRIPTIONS, but the vendor publishes the
 * members in a DIFFERENT ORDER here (`Well` · `Yes` · `Poorly` · `No` vs. the wall's
 * `Well` · `Poorly` · `Yes` · `No`). The two lists are therefore declared separately
 * and never shared — anything treating enum position as ordinal would silently swap
 * `Poorly` and `Yes` (doc 20 §5.5 cross-cutting notes).
 */
export const VaultInsulationQuality = z
  .enum(["Well", "Yes", "Poorly", "No"])
  .describe(
    'Four graded states, chosen by meaning: "Well" is full depth with few voids, "Poorly" is majority-filled but low density or depth is suspected, "Yes" is confirmed present with quality unknown, "No" is no insulation. Leave null if the auditor was unsure.',
  );

/**
 * `vaultCavityInsulationType` (`vault`). The cavity-insulation vocabulary of doc 20
 * §5.0, copied verbatim; largest-area wins.
 */
export const VaultCavityInsulationType = z.enum([
  "Fiberglass or Rockwool Batt",
  "Blown Fiberglass or Rockwool",
  "Cellulose",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Other",
]);

/**
 * `vaultContinuousInsulationType` (`vault`). The rigid-insulation vocabulary of doc 20
 * §5.0, copied verbatim; largest-area wins.
 */
export const VaultContinuousInsulationType = z.enum([
  "Rigid XPS",
  "Rigid EPS",
  "Rigid Polyisocyanurate",
  "Open Cell Spray Foam",
  "Closed Cell Spray Foam",
  "Other",
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

/**
 * `wallContinuousInsulationType` (`wall`). The rigid-insulation vocabulary of doc 20
 * §5.0, copied verbatim; largest-area wins. The spec publishes the identical list on
 * the `*Improved` twin — one export.
 */
export const WallContinuousInsulationType = z.enum([
  "Rigid XPS",
  "Rigid EPS",
  "Rigid Polyisocyanurate",
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

// == door ====================================================================

/**
 * `doorType` (`POST /jobs/{jobId}/door`) — door construction, on a rich enum that
 * fuses material, insulation, half-lite glazing and storm door into ONE string. An
 * auditor says these as separate facts ("an insulated steel door with a storm");
 * the member folds them back together. Note the vendor's own inconsistent storm
 * casing ("Steel, hollow with storm" vs. "Steel, insulated with Storm") — every
 * member stays verbatim.
 */
export const DoorType = z
  .enum([
    "Steel, hollow",
    "Steel, hollow with storm",
    "Steel, insulated",
    "Steel, insulated with Storm",
    "Wood",
    "Wood with Storm",
    "Fiberglass",
    "Fiberglass with Storm",
    "1/2-Lite Steel, insulated",
    "1/2-Lite Steel, insulated with Storm",
    "1/2-Lite Wood",
    "1/2-Lite Wood with Storm",
    "1/2-Lite Fiberglass",
    "1/2-Lite Fiberglass with Storm",
  ])
  .describe(
    'Door construction — one member fuses material, insulation, half-lite glazing and storm door, which the auditor says as separate facts ("an insulated steel door with a storm" → "Steel, insulated with Storm"). Combine what was stated into the single member that matches; when the stated combination fits no member, emit null with the quote rather than forcing the nearest one.',
  );

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

/**
 * `dhwTemperatureSettings` (`dhw`) — the water heater's dial setting as a
 * temperature BAND. The numeric twin is `dhwTemp`: a stated exact temperature
 * is a number there, a stated setting word is a member here.
 */
export const DhwTemperatureSettings = z.enum([
  "Low (120-130 F)",
  "Medium (130-140 F)",
  "High (140-150 F)",
  "Very High (150+ F)",
  "Don't Know",
]);

/**
 * `dhwEnergyFactorType` (`dhw`) — which energy-factor scale the water heater's
 * rated efficiency is expressed in; the number itself is `dhwEnergyFactor` or
 * `dhwUnifiedEnergyFactor`.
 */
export const DhwEnergyFactorType = z.enum(["EF", "UEF"]);

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

// == job =====================================================================

/**
 * The doc 20 §5.1 **STATES** vocabulary — the state enum declared ONCE and
 * shared by every field that carries it (`job.state` and
 * `job.propertyOwnerState`; the spec's `company.state` carries the same list
 * but is outside the capture surface). Spoken as a full state name ("the home
 * is in Massachusetts"); the wire member is the two-letter code.
 */
export const UsState = z.enum([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
]);

/**
 * `householdIncomeTier` (`job`) — the doc 20 §5.0 **INCOME-TIERS** vocabulary.
 * The members carry `%` signs, spaces and a spaced hyphen (`LMI 80 - 120`) —
 * verbatim, like every wire string.
 */
export const HouseholdIncomeTier = z.enum([
  "Any",
  "Less than 80% AMI",
  "Between 80% and 150% AMI",
  "80% AMI and Greater",
  "Greater than 150% AMI",
  "LMI",
  "LMI 80 - 120",
]);

// == utilities ===============================================================

/**
 * `billEntryType` (`POST /jobs/{jobId}/utilities`) — which of the endpoint's two
 * mutually-exclusive bill-entry families is live. A CONTROL field, not a fact
 * about the home: doc 20 §5.2 3.1 verdicts it `capture?` precisely because an
 * auditor never utters it — the note on the leaf says when it may be set.
 */
export const BillEntryType = z.enum(["Detailed", "Simple", "No Bills"]);

/**
 * `detailedElectricDataSource` / `detailedFuelDataSource` (`utilities`) — the
 * provenance of a detailed-bill import, one list shared by both streams. Only
 * meaningful when `billEntryType` is `"Detailed"`.
 */
export const DetailedBillDataSource = z.enum(["Manual", "Green Button"]);

/**
 * `simpleFuelUnits` (`utilities`) — whether the simple-mode fuel total is
 * counted in delivered gallons or in dollars spent.
 */
export const SimpleFuelUnits = z.enum(["Gallons", "Dollars"]);

/**
 * `primaryHeatingFuelType` (`utilities`) — the home's PRIMARY heating fuel, the
 * field that tells the endpoint's generic "fuel" stream which fuel it describes.
 * A wider list than the hvac/dhw fuel axes: it adds `Coal` and `Kerosene` and
 * drops `None`, so it is declared on its own rather than shared.
 */
export const PrimaryHeatingFuelType = z.enum([
  "Natural Gas",
  "Electricity",
  "Fuel Oil",
  "Propane",
  "Wood",
  "Pellets",
  "Solar",
  "Coal",
  "Kerosene",
]);

/** `electricBillUnits` (`utilities`) — the unit the electric bill figures are entered in. */
export const ElectricBillUnits = z.enum(["kWh", "Dollars"]);

/**
 * `fuelBillUnits` (`utilities`) — the unit the fuel bill figures are entered in.
 * The vendor's own description for this field is a copy-paste bug (it tells the
 * reader to "utilize the kWh option"; `kWh` is not a member — doc 20 §4.7). The
 * members above are the whole vocabulary.
 */
export const FuelBillUnits = z.enum([
  "Therms",
  "Gallons",
  "Dollars",
  "MCFs",
  "Cords",
  "Pounds",
  "Tons",
]);

// == clothesDryer, freezer, range, refrigerator, pv ===========================
// The appliances-and-PV job-collection resources (doc 20 §5.6). Every field
// doc 20 verdicts capture or capture? is here; the `*Improved` twins are
// DEFERRED to the improved-side tranche per the foundation design's decision 3
// — dictated retrofit intent ("I'd swap that for a heat-pump dryer"), not
// excluded. No field on these five resources publishes `enum: []`, and there
// is deliberately no `oven` group: the oven has no write endpoint anywhere in
// the spec, so there is nothing to write its fields to (doc 20 §5.6 "Oven: a
// no-write-target finding") — `rangeFuelType` is the oven fuel's only writable
// home.

/**
 * `clothesDryerFuelType` / `rangeFuelType` — one vendor list shared by the
 * dryer and the range: identical member sets, so one exported enum, declared
 * once and reused. On the range it covers the oven too (see `RangeFields`).
 */
export const ApplianceFuelType = z.enum([
  "Natural Gas",
  "Electricity",
  "Propane",
  "None",
  "Don't Know",
]);

/**
 * `freezerManufacturer` — doc 20 §5.0 FREEZER-BRANDS. The vendor list carries
 * both "Frigidaire" and its own "Fridgidaire" typo — both stay verbatim — and
 * it is NOT the refrigerator list: the two are genuinely different sets, and
 * normalising one onto the other is exactly the bug doc 20 §4.5 warns about.
 */
export const FreezerManufacturer = z
  .enum([
    "Amana",
    "Unknown",
    "Asko",
    "Bosch",
    "Frigidaire",
    "GE",
    "Igloo",
    "LG",
    "Maytag",
    "Samsung",
    "Sears",
    "Sub-Zero",
    "Thermador",
    "Whirlpool",
    "Other",
    "Fridgidaire",
  ])
  .describe(
    'Manufacturer from this closed list — the freezer list, which is NOT the refrigerator list. Use "Other" when the auditor names a make that is not on it, quoting the spoken name in the span.',
  );

/**
 * `refrigeratorManufacturer` — doc 20 §5.0 FRIDGE-BRANDS. Again both
 * "Frigidaire" and the vendor's own "Fridgidaire" typo, verbatim; again a
 * different set from the freezer list (this one adds Hotpoint, KitchenAid,
 * Fisher & Paykel, Ikea and Liebherr, and drops Igloo).
 */
export const RefrigeratorManufacturer = z
  .enum([
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
    "Sub-Zero",
    "Thermador",
    "Whirlpool",
    "Fisher & Paykel",
    "Ikea",
    "Liebherr",
    "Other",
    "Fridgidaire",
  ])
  .describe(
    'Manufacturer from this closed list — the refrigerator list, which is NOT the freezer list. Use "Other" when the auditor names a make that is not on it, quoting the spoken name in the span.',
  );

/**
 * `refrigeratorAge` — a banded age range, speech-shaped. The vendor's bands
 * are irregular in width and OVERLAP: both `"35-42"` and `"42+"` contain 42
 * (doc 20 §4.7). A stated age maps to the band containing it; a stated 42
 * resolves to `"35-42"`, the earlier of the two, deterministically.
 */
export const RefrigeratorAge = z.enum([
  "0-14",
  "15-21",
  "22-24",
  "25-26",
  "27-30",
  "31-34",
  "35-42",
  "42+",
  "Don't Know",
]);

/**
 * `refrigeratorSize` — a banded size range in cubic feet (the unit is stated
 * only in the vendor's `refrigeratorName` description — itself a copy-paste
 * bug; see `RefrigeratorFields`).
 */
export const RefrigeratorSize = z.enum([
  "1-5",
  "6-12",
  "13-15",
  "16-18",
  "19-21",
  "22+",
  "Don't Know",
]);

/**
 * `refrigeratorMaintenanceStarRating` — the spec's list leads with a literal
 * `null` member; that empty state is the leaf's `.nullable()`, not an enum
 * member — the rule `WallCavityInsulationType` records. The create endpoint
 * publishes no meanings for the members; the response definition does, and
 * that text travels on the leaf's own description.
 */
export const RefrigeratorMaintenanceStarRating = z
  .enum(["1", "2", "3"])
  .describe(
    'Maintenance condition, only from the auditor\'s own stated assessment: "1" when they describe observable issues that need addressing, "2" for standard condition given the system\'s age, "3" for well maintained and/or pristine. Never inferred, and never a rating for a refrigerator nobody assessed.',
  );

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
 * `POST /jobs/{jobId}/hvac` — one heating/cooling system record. The writable
 * surface carries this as an array because a job may have several systems;
 * each element is one record. The API's required capture fields live here —
 * see `adapter.ts`'s `requiredOnCreate`.
 *
 * Coverage (doc 20 §5.4): the base side is the endpoint's full
 * dictation-plausible surface. The improved side carries ONLY intent-bearing
 * fields — a fuel switch, a sizing, a load share, an equipment-class
 * preference are the dictated recommendation itself, and for an
 * `hvacUpgradeAction` of `"Install a new non-existing system"` the improved
 * side is the only place the new system exists at all. The rest of the
 * improved side is desk-side purchase specs of equipment not yet bought
 * (serials, model numbers, ratings of a proposed unit) and stays excluded.
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

      /**
       * The human instance label ("Old Heat Pump", "Basement Furnace") — the
       * only hvac handle an auditor actually says out loud, and the first
       * natural name field on any array-shaped group.
       */
      hvacSystemName: z
        .string()
        .describe(
          "The name the auditor gave this system — only when one was actually spoken; never an invented label.",
        )
        .nullable()
        .optional(),

      /** Condensing furnace/boiler — PVC combustion venting is the field tell. */
      hvacHeatingIsCondensing: z.enum(["Yes", "No"]).nullable().optional(),

      /** This system's share of the home's heating load. */
      hvacPercentOfTotalHeatingLoad: z
        .number()
        .describe(
          "Share of the home's total heating load this system covers; heating shares across all systems must add up to 100.",
        )
        .nullable()
        .optional(),

      /** This system's share of the home's cooling load. */
      hvacPercentOfTotalCoolingLoad: z
        .number()
        .describe(
          "Share of the home's total cooling load this system covers; unlike heating shares, cooling shares need not add up to 100 — the remainder is modelled as unconditioned.",
        )
        .nullable()
        .optional(),

      /** Cooling manufacturer, from Snugg's closed COOLING list — a different list from heating's. */
      hvacCoolingSystemManufacturer: HvacCoolingSystemManufacturer.nullable().optional(),

      /** Cooling model number / model name as stated, free text in the spec too. */
      hvacCoolingSystemModel: z.string().nullable().optional(),

      /** Indoor cooling model number (the air-handler/coil side of a split system). */
      hvacCoolingSystemIndoorModel: z.string().nullable().optional(),

      /** Outdoor cooling model number (the condenser side of a split system). */
      hvacCoolingSystemOutdoorModel: z.string().nullable().optional(),

      /** The UNIT's model year — never the home's year. Stringified at write. */
      hvacCoolingSystemModelYear: z
        .number()
        .describe(
          "The cooling unit's model year — never the home's year built, which is a separate field.",
        )
        .nullable()
        .optional(),

      /** Indoor heating model number. */
      hvacHeatingSystemIndoorModel: z.string().nullable().optional(),

      /** Outdoor heating model number. */
      hvacHeatingSystemOutdoorModel: z.string().nullable().optional(),

      /** Cooling serial number(s), comma-separated when several. */
      hvacCoolingSystemSerialNumber: z.string().nullable().optional(),

      /** Indoor cooling serial number(s), comma-separated when several. */
      hvacCoolingSystemIndoorSerialNumber: z.string().nullable().optional(),

      /** Outdoor cooling serial number(s), comma-separated when several. */
      hvacCoolingSystemOutdoorSerialNumber: z.string().nullable().optional(),

      /** Heating serial number(s), comma-separated when several. */
      hvacHeatingSystemSerialNumber: z.string().nullable().optional(),

      /** Indoor heating serial number(s), comma-separated when several. */
      hvacHeatingSystemIndoorSerialNumber: z.string().nullable().optional(),

      /** Outdoor heating serial number(s), comma-separated when several. */
      hvacHeatingSystemOutdoorSerialNumber: z.string().nullable().optional(),

      /** The measured duct-insulation R-value — pairs with `"Measured (R Value)"` above. */
      hvacDuctInsulationValue: z
        .number()
        .describe(
          'The duct insulation R-value as a measured number — only meaningful when hvacDuctInsulation is "Measured (R Value)".',
        )
        .nullable()
        .optional(),

      /** Variable-speed / inverter-driven compressor on the heat pump. */
      hvacHeatPumpInverter: z.enum(["Yes", "No"]).nullable().optional(),

      /**
       * Whether this is an ENERGY STAR Cold Climate Heat Pump. The spec
       * publishes an INTEGER enum `[1, 0]` on a `type: string` field — the
       * same shape as `hasEv`, so `z.number()` and the vocabulary travels in
       * the description.
       */
      energyStarColdClimateHeatPump: z
        .number()
        .describe(
          "Whether this system is an ENERGY STAR Cold Climate Heat Pump; the wire value is integer 1 (yes) or 0 (no).",
        )
        .nullable()
        .optional(),

      /**
       * Heating-side maintenance/condition star rating. The spec's enum is
       * `[null, "1", "2", "3"]` — a literal `null` plus numeric STRINGS: the
       * null is this leaf's `.nullable()` (the `WallCavityInsulationType`
       * rule) and the numeric strings stay strings (the `WindZone` rule).
       */
      hvacHeatingMaintenanceStarRating: z
        .enum(["1", "2", "3"])
        .describe(
          'Maintenance condition as the wire string — "1" observable issues need to be addressed, "2" standard condition based on the age of the system, "3" well maintained and/or pristine; a system whose condition was never judged is null.',
        )
        .nullable()
        .optional(),

      /** Cooling-side maintenance/condition star rating — same wire shape as the heating twin. */
      hvacCoolingMaintenanceStarRating: z
        .enum(["1", "2", "3"])
        .describe(
          'Maintenance condition as the wire string — "1" observable issues need to be addressed, "2" standard condition based on the age of the system, "3" well maintained and/or pristine; a system whose condition was never judged is null.',
        )
        .nullable()
        .optional(),

      /**
       * Steady-state efficiency measured on site with a combustion gas
       * analyzer — a real reading, so HAZARD 4's lookup rule does not apply.
       */
      hvacSteadyStateEfficiency: z
        .number()
        .describe(
          "Steady-state efficiency measured on site with a combustion gas analyzer — a field reading, not a nameplate rating; set it only when the auditor actually ran and stated one.",
        )
        .nullable()
        .optional(),

      /** AFUE (combustion / electric resistance) or HSPF (heat pump) — a stated number only, per HAZARD 4. */
      hvacHeatingSystemEfficiency: z
        .number()
        .describe(
          "AFUE or HSPF as a stated number only — Snugg normally derives efficiency from make/model/year, so never estimate one; which rating the number means goes in hvacHeatingSystemEfficiencyRatingUnit.",
        )
        .nullable()
        .optional(),

      /** SEER (EER for Room AC) — same stated-number-only rule as the heating twin. */
      hvacCoolingSystemEfficiency: z
        .number()
        .describe(
          "SEER, or EER for a Room AC, as a stated number only — never estimated; the unit goes in hvacCoolingSystemEfficiencyRatingUnit.",
        )
        .nullable()
        .optional(),

      /**
       * Which rating `hvacHeatingSystemEfficiency` is expressed in. The spec
       * declares `enum: []` — the value list is unpublished — so this stays
       * free text, the `hvacDuctLocation` precedent.
       */
      hvacHeatingSystemEfficiencyRatingUnit: z
        .string()
        .describe(
          "The unit hvacHeatingSystemEfficiency is expressed in (AFUE or HSPF), as free text — the vendor publishes no value list for this field.",
        )
        .nullable()
        .optional(),

      /** Which rating `hvacCoolingSystemEfficiency` is expressed in — free text, unpublished value list. */
      hvacCoolingSystemEfficiencyRatingUnit: z
        .string()
        .describe(
          "The unit hvacCoolingSystemEfficiency is expressed in (SEER or EER), as free text — the vendor publishes no value list for this field.",
        )
        .nullable()
        .optional(),

      // --- Improved side: dictated INTENT only -------------------------------
      // For `hvacUpgradeAction: "Install a new non-existing system"` the
      // improved side is the only place the new system exists, and these are
      // the fields a recommendation is dictated in — fuel, sizing, load
      // share, equipment class. Everything else on the improved side is a
      // desk-side purchase spec of unbought equipment and is excluded.

      /**
       * The proposed system's fuel — a fuel switch ("get off the oil") is
       * dictated retrofit intent. The spec declares `enum: []` here and,
       * unlike the base-side twin, there is no sanctioned list to borrow —
       * the spoken fuel lands as free text.
       */
      hvacHeatingEnergySourceImproved: z
        .string()
        .describe(
          "The proposed system's fuel as spoken, free text — the vendor publishes no value list for this field. A recommended fuel switch is dictated intent; never leave it null just because there is no list to match against.",
        )
        .nullable()
        .optional(),

      /** Proposed heating output in Btu/h — sizing intent. Auditors say tons; the conversion is `normalization.ts`'s, same as the base side. */
      hvacHeatingCapacityImproved: z
        .number()
        .describe(
          "Proposed heating output in Btu per hour — the sizing half of a dictated recommendation. Auditors say tons, not Btu/hr; the tons-to-Btu/hr conversion is a deterministic pass, so the stated size belongs here rather than nowhere.",
        )
        .nullable()
        .optional(),

      /** Proposed cooling output in Btu/h — sizing intent; "three-ton" is 36000, a conversion `normalization.ts` owns. */
      hvacCoolingCapacityImproved: z
        .number()
        .describe(
          "Proposed cooling output in Btu per hour — the sizing half of a dictated recommendation. Auditors say tons, not Btu/hr; the tons-to-Btu/hr conversion is a deterministic pass, so the stated size belongs here rather than nowhere.",
        )
        .nullable()
        .optional(),

      /** Share of heating load the improved system would carry — dictated intent expressed as a cross-instance allocation. */
      hvacPercentOfTotalHeatingLoadImproved: z
        .number()
        .describe(
          "Share of the home's heating load the proposed system would carry — a stated allocation of intent; improved heating shares across systems must add up to 100.",
        )
        .nullable()
        .optional(),

      /** Share of cooling load the improved system would carry. */
      hvacPercentOfTotalCoolingLoadImproved: z
        .number()
        .describe(
          "Share of the home's cooling load the proposed system would carry; like the base side, improved cooling shares need not add up to 100.",
        )
        .nullable()
        .optional(),

      /** Whether the PROPOSED heat pump is variable-speed / inverter-driven — a dictated preference, not a purchase spec. */
      hvacHeatPumpInverterImproved: z
        .enum(["Yes", "No"])
        .describe(
          'Whether the proposed heat pump is variable-speed / inverter-driven — "get a variable-speed unit" is dictated intent, not a desk spec.',
        )
        .nullable()
        .optional(),

      /**
       * Whether the proposed system is an ENERGY STAR Cold Climate Heat Pump —
       * a named product-class recommendation. Same integer-on-string wire
       * shape as the base-side twin.
       */
      energyStarColdClimateHeatPumpImproved: z
        .number()
        .describe(
          "Whether the proposed system is an ENERGY STAR Cold Climate Heat Pump — a product-class recommendation; the wire value is integer 1 (yes) or 0 (no).",
        )
        .nullable()
        .optional(),
    }),
  )
  .strict();

/**
 * `POST /jobs/{jobId}/attic` — one attic record. Now the full verdicted capture
 * surface of doc 20 §5.5: every field of the endpoint except the self-described
 * computed ones (`atticAssemblyRValue`, `atticKneeWallAssemblyRValue` and their
 * improved twins — "not editable since it is calculated from the other fields").
 *
 * The vendor's own `atticInsulationDepth` description routes VAULTED-ceiling depth
 * here too ("If there is no attic and instead vaulted ceilings, enter an estimate of
 * the thickness of insulation in the vaulted cavity") — the vault resource has no
 * depth field, so dictated vault depth lands on this attic leaf (doc 20 §5.5
 * cross-cutting notes; rule 8 of the extraction instructions).
 */
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

      /**
       * Interior ceiling surface area in ft². Auto-calculated from conditioned area ×
       * stories but overridable — writing it replaces the model default, so set it only
       * from a stated number ("the attic is about twelve hundred square feet").
       */
      atticModeledAtticArea: z
        .number()
        .describe(
          "Interior ceiling surface area in square feet; auto-calculated by the vendor, so set it only when the auditor states an actual number — a stated value overrides the model default.",
        )
        .nullable()
        .optional(),

      /** Total surface area of the knee wall adjoining this attic space, in ft². */
      atticKneeWallArea: z.number().nullable().optional(),

      /** Total R-value installed (BASE) in the knee wall cavity. */
      atticKneeWallInsulation: z.number().nullable().optional(),

      /**
       * Total R-value of continuous insulation on the knee wall. The vendor reuses the
       * cavity description verbatim here — treat the description as approximate (doc 20
       * §5.5 cross-cutting notes).
       */
      atticKneeWallContinuousInsulation: z
        .number()
        .describe(
          "Total R-value of the CONTINUOUS insulation on the knee wall — a separate field from the knee wall cavity R-value, despite the vendor's copy-pasted description.",
        )
        .nullable()
        .optional(),

      /** Whether the attic has a radiant barrier — directly observable, commonly called out. */
      atticRadiantBarrier: z.enum(["Yes", "No"]).nullable().optional(),

      /**
       * % of total footprint attributed to this attic/vault area. Only meaningful with
       * multiple attic/vault instances, and it is a proportion, not an identity —
       * auditors say "about half the attic" rather than a number.
       */
      atticPercent: z
        .number()
        .describe(
          "Share of the total footprint attributed to this attic area, as a percentage; only meaningful when several attic/vault instances split the house.",
        )
        .nullable()
        .optional(),

      /**
       * Solar absorptance of the roofing above (1 − reflectance). An auto-defaulted lab
       * coefficient nobody dictates — only in play with a cool-roof spec.
       */
      atticRoofAbsorptance: z
        .number()
        .describe(
          "Solar absorptance of the roofing above; the vendor supplies a default automatically, so set it only from an explicitly stated coefficient.",
        )
        .nullable()
        .optional(),

      /** Thermal emittance of the roofing above — same auto-defaulted coefficient story. */
      atticRoofEmissivity: z
        .number()
        .describe(
          "Thermal emittance of the roofing above; the vendor supplies a default automatically, so set it only from an explicitly stated coefficient.",
        )
        .nullable()
        .optional(),

      /** Whether to specify cool-roof characteristics — auditors do say "it is a cool roof". */
      atticCoolRoof: z.enum(["Yes", "No"]).nullable().optional(),

      /** Insulation type in the knee wall cavity (largest-area wins). */
      atticKneeWallInsulationType: AtticKneeWallInsulationType.nullable().optional(),

      /** Continuous insulation type on the knee wall (largest-area wins). */
      atticKneeWallContinuousInsulationType:
        AtticKneeWallContinuousInsulationType.nullable().optional(),

      /** Roofing colour for this roof section; the list has no Dark member. */
      atticRoofColor: AtticRoofColor.nullable().optional(),

      /**
       * Retrofit insulation type — "we will blow cellulose" is dictated upgrade INTENT,
       * which is captured; the improved spec numbers below are the borderline side.
       */
      atticInsulationTypeImproved: AtticInsulationType.nullable().optional(),

      /**
       * New attic sqft after retrofit — used to model attic→conditioned conversions.
       * Structural intent, but a modelled number rather than speech; set only from a
       * stated figure.
       */
      atticModeledAtticAreaImproved: z
        .number()
        .describe(
          "Attic area in square feet after the retrofit; a modelled number, so set it only from an explicitly stated figure.",
        )
        .nullable()
        .optional(),

      /**
       * Target R-value to be installed. Borders on intent ("bring it to R-49") but is
       * the spec side of it — set only when a target number is actually stated.
       */
      atticInsulationImproved: z
        .number()
        .describe(
          "Target R-value to be installed as a number; set only when the auditor states the target ('bring it to R-49'), never derived from the base value.",
        )
        .nullable()
        .optional(),

      /** Improved knee wall area — spec side; set only from a stated figure. */
      atticKneeWallAreaImproved: z.number().nullable().optional(),

      /** Target knee wall cavity R-value — spec side; set only when stated. */
      atticKneeWallInsulationImproved: z.number().nullable().optional(),

      /** Target knee wall continuous R-value — spec side; set only when stated. */
      atticKneeWallContinuousInsulationImproved: z.number().nullable().optional(),

      /**
       * Knee wall present on the improved side. An odd field: a retrofit rarely creates
       * or removes a knee wall — likely a modelling artefact of the base/improved
       * doubling, so set it only from an explicit statement.
       */
      atticHasKneeWallImproved: z
        .enum(["Yes", "No"])
        .describe(
          "Knee wall on the improved side; a retrofit rarely adds or removes one, so set this only from an explicit statement.",
        )
        .nullable()
        .optional(),

      /** Add a radiant barrier — clean upgrade intent. */
      atticRadiantBarrierImproved: z.enum(["Yes", "No"]).nullable().optional(),

      /** Cool-roof spec coefficient — auto-defaulted, not dictated. */
      atticRoofAbsorptanceImproved: z
        .number()
        .describe(
          "Solar absorptance of the improved roofing; an auto-defaulted coefficient, so set it only from an explicitly stated figure.",
        )
        .nullable()
        .optional(),

      /** Cool-roof spec coefficient — auto-defaulted, not dictated. */
      atticRoofEmissivityImproved: z
        .number()
        .describe(
          "Thermal emittance of the improved roofing; an auto-defaulted coefficient, so set it only from an explicitly stated figure.",
        )
        .nullable()
        .optional(),

      /**
       * Specify a cool roof as the improvement. Intent-shaped, but only used when a roof
       * replacement is actually in the package.
       */
      atticCoolRoofImproved: z.enum(["Yes", "No"]).nullable().optional(),

      /** Retrofit knee wall cavity insulation type — spec side. */
      atticKneeWallInsulationTypeImproved: AtticKneeWallInsulationType.nullable().optional(),

      /** Retrofit knee wall continuous insulation type — spec side. */
      atticKneeWallContinuousInsulationTypeImproved:
        AtticKneeWallContinuousInsulationType.nullable().optional(),
    }),
  )
  .strict();

/**
 * `POST /jobs/{jobId}/vault` — one vaulted / cathedral ceiling record: the
 * job-collections tranche 12 group (doc 20 §5.5; target model per
 * `docs/roadmap/design/job-collections-foundation-design.md`). A top-level key of `V`
 * following the per-instance pattern — an array with one element per real-world
 * occurrence, repeating per job (0..n). Every field of the endpoint except the
 * computed `vaultAssemblyRValue`/`Improved`.
 *
 * Like attic, the resource has NO name/label field — only `uuid` in the response — so
 * instance identity rides the roster's discriminator mechanism, with `vaultPercent`
 * (share of footprint) as the sole positional discriminator (foundation design
 * decision 2; see `inventory.ts`).
 *
 * The vault has no insulation DEPTH field at all: dictated vault depth is routed to
 * `attic.atticInsulationDepth` by the vendor's own field description — a
 * cross-resource leak extraction must know about (doc 20 §5.5 cross-cutting notes;
 * rule 8 of the extraction instructions), not a vault-group bug.
 */
export const VaultFields = z
  .object(
    withVendorDescriptions({
      /**
       * Interior surface area of the vaulted ceiling in ft²; auto-calculated with a
       * default 5/12 roof pitch, overridable — set only from a stated number.
       */
      vaultModeledVaultArea: z
        .number()
        .describe(
          "Interior surface area of the vaulted ceiling in square feet; auto-calculated by the vendor, so set it only when the auditor states an actual number.",
        )
        .nullable()
        .optional(),

      /** Total R-value installed in the vaulted ceiling cavity. */
      vaultCavityInsulation: z
        .number()
        .describe(
          "Total installed R-value in the vaulted ceiling cavity as a number — a stated DEPTH has no field on this resource; it routes to attic.atticInsulationDepth.",
        )
        .nullable()
        .optional(),

      /** Total R-value of continuous insulation on the vaulted ceiling. */
      vaultContinuousInsulation: z.number().nullable().optional(),

      /**
       * Insulation quality of the vaulted cavities — the sibling of `wallsInsulated`,
       * on a wire field named bare `vault`. Same member descriptions, DIFFERENT
       * published member order; pick by meaning, never by position.
       */
      vault: VaultInsulationQuality.nullable().optional(),

      /**
       * % of total footprint attributed to this attic/vault area (the vendor shares the
       * description with `atticPercent`). The only positional discriminator between
       * vault instances — a proportion, not an identity.
       */
      vaultPercent: z
        .number()
        .describe(
          "Share of the total footprint attributed to this vaulted area, as a percentage; only meaningful when several attic/vault instances split the house.",
        )
        .nullable()
        .optional(),

      /** Solar absorptance of roofing above the vault — auto-defaulted coefficient. */
      vaultRoofAbsorptance: z
        .number()
        .describe(
          "Solar absorptance of the roofing above the vault; the vendor supplies a default automatically, so set it only from an explicitly stated coefficient.",
        )
        .nullable()
        .optional(),

      /** Thermal emittance of roofing above the vault — auto-defaulted coefficient. */
      vaultRoofEmissivity: z
        .number()
        .describe(
          "Thermal emittance of the roofing above the vault; the vendor supplies a default automatically, so set it only from an explicitly stated coefficient.",
        )
        .nullable()
        .optional(),

      /** Specify cool-roof characteristics for this vault section. */
      vaultCoolRoof: z.enum(["Yes", "No"]).nullable().optional(),

      /** Insulation type in the vault cavity (largest-area wins). */
      vaultCavityInsulationType: VaultCavityInsulationType.nullable().optional(),

      /** Continuous insulation type on the vault. */
      vaultContinuousInsulationType: VaultContinuousInsulationType.nullable().optional(),

      /** Roofing material for this roof section — the same published list `atticRoofType` uses. */
      vaultRoofType: AtticRoofType.nullable().optional(),

      /** Roofing colour for this roof section — the same published list `atticRoofColor` uses. */
      vaultRoofColor: AtticRoofColor.nullable().optional(),

      /**
       * New vault sqft; increased when converting an unconditioned attic to conditioned
       * vaulted space. A modelled number — set only from a stated figure.
       */
      vaultModeledVaultAreaImproved: z
        .number()
        .describe(
          "Vaulted ceiling area in square feet after the retrofit; a modelled number, so set it only from an explicitly stated figure.",
        )
        .nullable()
        .optional(),

      /** Target cavity R-value — spec side; set only when stated. */
      vaultCavityInsulationImproved: z.number().nullable().optional(),

      /** Target continuous R-value — spec side; set only when stated. */
      vaultContinuousInsulationImproved: z.number().nullable().optional(),

      /** Cool-roof spec coefficient — not dictated. */
      vaultRoofAbsorptanceImproved: z
        .number()
        .describe(
          "Solar absorptance of the improved roofing; an auto-defaulted coefficient, so set it only from an explicitly stated figure.",
        )
        .nullable()
        .optional(),

      /** Cool-roof spec coefficient — not dictated. */
      vaultRoofEmissivityImproved: z
        .number()
        .describe(
          "Thermal emittance of the improved roofing; an auto-defaulted coefficient, so set it only from an explicitly stated figure.",
        )
        .nullable()
        .optional(),

      /** Cool roof as the improvement — only with an actual roof replacement in the package. */
      vaultCoolRoofImproved: z.enum(["Yes", "No"]).nullable().optional(),

      /**
       * Retrofit cavity insulation type — "spray foam the vault" is dictated upgrade
       * intent, which is captured.
       */
      vaultCavityInsulationTypeImproved: VaultCavityInsulationType.nullable().optional(),

      /** Retrofit continuous insulation type — spec side. */
      vaultContinuousInsulationTypeImproved: VaultContinuousInsulationType.nullable().optional(),
    }),
  )
  .strict();

/**
 * `POST /jobs/{jobId}/wall` — one wall-system record. Now the full verdicted capture
 * surface of doc 20 §5.5: every field of the endpoint except the self-described
 * computed ones (`wallAssemblyRValue` and its improved twin — "not editable since it
 * is calculated from the other fields", on a description the vendor copy-pasted from
 * the BASEMENT wall field; treat it as approximate, doc 20 §5.5 cross-cutting notes).
 *
 * The spec expects multiple wall SYSTEMS per job (`wallSystemPercentOfTotal` must sum
 * to 100% across them, and a partial wall retrofit requires building "a second wall
 * system" rather than a partial area), yet gives them no human-facing identity — only
 * `uuid` in the response. "The north wall" becomes an anonymous system distinguished
 * by a percentage, so instance identity stays the roster's job (`inventory.ts`).
 */
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

      /**
       * Above-grade exterior wall construction material. UNPUBLISHED ENUM: the spec
       * declares a named dropdown with `enum: []` and no member list, so a dictated
       * construction is captured as free text and goes through review rather than
       * being validated against a vocabulary.
       */
      wallExteriorWallConstruction: z
        .string()
        .describe(
          'Construction material of the above-grade exterior walls ("two-by-four stick frame", "block"). Snugg publishes no value list for this dropdown, so capture the construction as spoken free text — never invent a member of some other field\'s enum for it.',
        )
        .nullable()
        .optional(),

      /** Total R-value of continuous insulation (foam/rigid, unbroken across framing). */
      wallContinuousInsulation: z
        .number()
        .describe(
          "Total R-value of the CONTINUOUS insulation (spray foam or rigid foam, unbroken across framing) in this wall system — a separate field from the cavity R-value.",
        )
        .nullable()
        .optional(),

      /**
       * Gross exterior wall area incl. openings, in ft². Auto-calculated from house
       * length × width × average wall height but overridable — writing it replaces the
       * model default, so set it only from a stated number. (The vendor auto-adds an
       * extra foot of wall height per storey for rim joists.)
       */
      wallModeledWallArea: z
        .number()
        .describe(
          "Gross exterior wall area in square feet, including window and door openings; auto-calculated by the vendor, so set it only when the auditor states an actual number — a stated value overrides the model default.",
        )
        .nullable()
        .optional(),

      /**
       * % of all walls this system represents; the systems must total 100%. Only
       * meaningful with more than one wall system, and it is a proportion, not an
       * identity — set it only when a share was actually stated.
       */
      wallSystemPercentOfTotal: z
        .number()
        .describe(
          "Share of all walls this wall system represents, as a percentage; only meaningful when several wall systems split the house, and the vendor expects them to total 100%.",
        )
        .nullable()
        .optional(),

      /** Type of continuous insulation on the wall (largest-area wins). */
      wallContinuousInsulationType: WallContinuousInsulationType.nullable().optional(),

      /** Target cavity R-value — the spec side of a dictated intent; set only when stated. */
      wallCavityInsulationImproved: z
        .number()
        .describe(
          "Target cavity R-value to be installed as a number; set only when the auditor states the target ('bring the walls to R-21'), never derived from the base value.",
        )
        .nullable()
        .optional(),

      /** Target continuous R-value — spec side; set only when stated. */
      wallContinuousInsulationImproved: z.number().nullable().optional(),

      /**
       * Improved wall sqft. A partial wall retrofit requires building a SECOND wall
       * system rather than a partial area — an instance-modelling constraint, not a
       * leaf rule; set only from a stated figure.
       */
      wallModeledWallAreaImproved: z
        .number()
        .describe(
          "Wall area in square feet after the retrofit; a modelled number, so set it only from an explicitly stated figure.",
        )
        .nullable()
        .optional(),

      /**
       * Retrofit cavity insulation type — "dense-pack the walls with cellulose" is
       * dictated intent. The spec publishes the identical list as the base-side field,
       * leading `null` included — the same `.nullable()` rule, one export.
       */
      wallCavityInsulationTypeImproved: WallCavityInsulationType.nullable().optional(),

      /** Retrofit continuous insulation type — spec side. */
      wallContinuousInsulationTypeImproved: WallContinuousInsulationType.nullable().optional(),
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

/**
 * `POST /jobs/{jobId}/door` — one door record: the job-collections tranche 6 group
 * (doc 20 §5.5; target model per
 * `docs/roadmap/design/job-collections-foundation-design.md`). A top-level key of `V`
 * following the per-instance pattern — an array with one element per real-world
 * occurrence, repeating per job (0..n). Every field of the endpoint; doc 20 excludes
 * none of them.
 *
 * INSTANCE IDENTITY IS THE WEAKEST FIT IN THE FAMILY, and this group may need real
 * design attention later: door has no name or label AND no count field — `doorArea`
 * is a single aggregate area the vendor says may be overridden "with the actual door
 * sizes for the home" (plural). The resource is therefore closer to a door AGGREGATE
 * than a true instance, and "the front door" cannot be identified — or even separated
 * from the back door — without creating two instances that look identical on the
 * wire. Identity still rides the roster's discriminator mechanism (foundation design
 * decision 2; `inventory.ts`), using whatever content is available — the door
 * type/construction — as the handle. That is weaker than the usual "no natural label
 * but the content itself distinguishes" case the other groups have: two same-type
 * doors have no wire-visible separation at all.
 *
 * A routing rule travels with `doorArea`: a door with glazing at or above half its
 * rough opening is modelled as a WINDOW at rough-opening area — that fact lands in
 * the `window` group, never here (doc 20 §5.5).
 */
export const DoorFields = z
  .object(
    withVendorDescriptions({
      /** Door construction — material, insulation, half-lite and storm fused into one member. */
      doorType: DoorType.nullable().optional(),

      /**
       * Door U-value. Auto-calculated by the vendor from the input form, overridable
       * with the actual U-value — set it only when one was actually stated.
       */
      doorUValue: z
        .number()
        .describe(
          "Door U-value; auto-calculated by the vendor, so set it only when the auditor states an actual number.",
        )
        .nullable()
        .optional(),

      /**
       * Door area in ft². Auto-calculated, overridable with the actual door sizes —
       * and on this resource an aggregate rather than one door's measurement. A door
       * with glazing at or above half its rough opening is modelled as a WINDOW at
       * rough-opening area — that fact belongs to the window group, never here.
       */
      doorArea: z
        .number()
        .describe(
          "Door area in square feet; auto-calculated by the vendor, so set it only when the auditor states an actual number. A door with glazing covering half or more of its rough opening is modelled as a window at rough-opening area — capture that in the window group instead, never here.",
        )
        .nullable()
        .optional(),

      /** This door is ENERGY STAR certified. */
      doorEnergyStar: z.enum(["Yes", "No"]).nullable().optional(),

      /** Target U-value of the replacement door — improved spec; set only when stated. */
      doorUValueImproved: z
        .number()
        .describe(
          "Target U-value of the replacement door — the spec side of an upgrade; set it only when a replacement U-value was actually stated.",
        )
        .nullable()
        .optional(),

      /** Door area on the improved side — improved spec; set only from a stated figure. */
      doorAreaImproved: z.number().nullable().optional(),

      /** "Put in an ENERGY STAR door" — upgrade intent. */
      doorEnergyStarImproved: z.enum(["Yes", "No"]).nullable().optional(),
    }),
  )
  .strict();

/**
 * `POST /jobs/{jobId}/dhw` — one water heater record, grown to the full
 * verdicted capture surface of doc 20 §5.4. The base side is the endpoint's
 * dictation-plausible surface: the dial setting and its numeric twin, the
 * nameplate model/serial/year, the load share, the ENERGY STAR label, the
 * input capacity, the tank/pipe wrap observations, the condition star rating,
 * and the `capture?` efficiency family (EF/UEF, recovery, the decimal HES
 * factor) — stated values only, never estimated.
 *
 * The improved side carries ONLY intent-bearing fields (the foundation
 * design's decision 3): proposed type, fuel, size, temperature, ENERGY STAR
 * class, load share and the wrap measures are the dictated recommendation
 * itself — the vendor's own rule is that improved values "are only used if
 * the item is Recommended". The rest of the improved side is desk-side
 * purchase specs of unbought equipment (manufacturer, model, year, serial,
 * efficiency specs) and stays excluded.
 *
 * The doubling is asymmetric in both directions (doc 20 §5.4 pair census):
 * the base-side age, location, temperature setting, wrap R-values, condition
 * rating and HES factor have NO improved twins (you cannot rate the condition
 * of a thing not yet installed), while `dhwPipeWrapLengthImproved` and
 * `dhwPipeWrapPercentageImproved` are improved-ONLY — the recommended
 * pipe-wrap measure's quantities, with no base counterpart.
 */
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

      /** Temperature setting BAND — the dial position. A stated exact temperature goes in `dhwTemp`. */
      dhwTemperatureSettings: DhwTemperatureSettings.nullable().optional(),

      /** The water temperature itself, in °F — the numeric twin of the setting band above. */
      dhwTemp: z
        .number()
        .describe(
          "The temperature of the water produced, in °F as a number — a stated setting word (low, medium) goes in dhwTemperatureSettings, not here.",
        )
        .nullable()
        .optional(),

      /** Model number / model name as stated, free text in the spec too. */
      dhwModel: z.string().nullable().optional(),

      /** The UNIT's model year, e.g. 2011 — never the home's year. Spec types this `string`; `write` stringifies. */
      dhwModelYear: z
        .number()
        .describe(
          "The water heater's model year — never the home's year built, which is a separate field.",
        )
        .nullable()
        .optional(),

      /** Serial number(s), comma-separated when several. */
      dhwSerialNumber: z.string().nullable().optional(),

      /** This system's share of the home's annual hot-water load. */
      dhwPercentLoad: z
        .number()
        .describe(
          "Share of the home's annual DHW load this system meets, as a percentage; the shares across a home's water heaters must add up to 100.",
        )
        .nullable()
        .optional(),

      /** Whether the water heater is ENERGY STAR certified — a label read off the tank. */
      dhwEnergyStar: z.enum(["Yes", "No"]).nullable().optional(),

      /** Rated INPUT capacity in BTU/h — the input rating, unlike the hvac output capacities. */
      dhwHeatingCapacity: z
        .number()
        .describe(
          "Rated input capacity of the water heater in BTU per hour — the INPUT rating, unlike the hvac capacities, which are output ratings.",
        )
        .nullable()
        .optional(),

      /** Whether a tank wrap (insulation blanket) has been applied — a pure visual observation. */
      dhwTankWrap: z.enum(["Yes", "No"]).nullable().optional(),

      /** R-value of the tank wrap applied. */
      dhwTankWrapRValue: z.number().nullable().optional(),

      /** Whether the pipes from this water heater are wrapped. */
      dhwPipeWrap: z.enum(["Yes", "No"]).nullable().optional(),

      /** R-value of the pipe wrap applied. */
      dhwPipeWrapRValue: z.number().nullable().optional(),

      /**
       * Maintenance/condition star rating. The spec's enum is `[null, "1", "2", "3"]`
       * — a literal `null` plus numeric STRINGS: the null is this leaf's
       * `.nullable()` (the `WallCavityInsulationType` rule) and the numeric strings
       * stay strings (the `WindZone` rule), the same wire shape as the hvac star
       * ratings.
       */
      dhwMaintenanceStarRating: z
        .enum(["1", "2", "3"])
        .describe(
          'Maintenance condition as the wire string — "1" observable issues need to be addressed, "2" standard condition based on the age of the system, "3" well maintained and/or pristine; a water heater whose condition was never judged is null.',
        )
        .nullable()
        .optional(),

      /**
       * The boiler an indirect (sidearm) tank is attached to — a CROSS-RESOURCE
       * reference to an hvac instance. The spec declares `enum: []` and publishes
       * no value list, so this stays free text (the `hvacDuctLocation` precedent):
       * the boiler as the auditor referred to it. Matching that reference against
       * the job's hvac systems is a later, human-supervised step, not extraction's
       * (the `fromTemplateUuid` pattern).
       */
      dhwSidearmBoiler: z
        .string()
        .describe(
          "The boiler from the HVAC section this indirect water heater tank is attached to, as the auditor referred to it — free text; the vendor publishes no value list, and resolving the reference against the job's hvac systems is a later human-supervised step.",
        )
        .nullable()
        .optional(),

      /**
       * Standby loss of a sidearm/indirect tank. The vendor's own description of
       * this field is a copy-paste error (it reads as the water-temperature one),
       * and the units and scale are unpublished (doc 20 §5.4) — stated numbers
       * only.
       */
      dhwSidearmStandbyLoss: z
        .number()
        .describe(
          "Standby loss of the sidearm tank as a stated number only — the vendor's description of this field is a copy-paste error and its units and scale are unpublished, so set it only from an explicitly stated number.",
        )
        .nullable()
        .optional(),

      /** Which energy-factor scale the rated efficiency is expressed in. */
      dhwEnergyFactorType: DhwEnergyFactorType.nullable().optional(),

      /**
       * Rated Energy Factor — `capture?` per the efficiency precedent (looked up
       * from make/model, per the vendor's own AHRI-directory note). The wire
       * encoding has NO decimal: 0.56 is stored as 56.
       */
      dhwEnergyFactor: z
        .number()
        .describe(
          "Rated Energy Factor as a stated number only — never estimated; Snugg looks these up from make and model. The wire stores the factor without a decimal (0.56 as 56); any rescaling is a deterministic pass after extraction, so the number as stated belongs here.",
        )
        .nullable()
        .optional(),

      /** Rated Uniform Energy Factor — same stated-only rule and same no-decimal wire encoding. */
      dhwUnifiedEnergyFactor: z
        .number()
        .describe(
          "Rated Uniform Energy Factor as a stated number only — never estimated. The wire stores the factor without a decimal (0.56 as 56); any rescaling is a deterministic pass after extraction, so the number as stated belongs here.",
        )
        .nullable()
        .optional(),

      /** System recovery efficiency — stated only; the vendor notes some utility programs require it. */
      dhwRecoveryEfficiency: z
        .number()
        .describe(
          "System recovery efficiency as a stated number only — never estimated; the vendor notes it is optional for modeling but required by some utility programs.",
        )
        .nullable()
        .optional(),

      /**
       * The Home Energy Score EF field — a DECIMAL (0.55), not the no-decimal
       * encoding of `dhwEnergyFactor`, and the one efficiency field the vendor
       * says to read off the EnergyGuide label in the field (doc 20 §6).
       */
      hesDhwEnergyFactor: z
        .number()
        .describe(
          "Energy Factor of a storage water heater as a decimal (e.g. 0.55) — the Home Energy Score input, read off the EnergyGuide label on the tank; a different scale from dhwEnergyFactor's no-decimal encoding. Stated or label-read values only, never estimated.",
        )
        .nullable()
        .optional(),

      // --- Improved side: dictated INTENT only -------------------------------
      // The improved side is what the vendor recommends be installed ("only
      // used if the item is Recommended"), and these are the fields a
      // recommendation is dictated in — type, fuel, sizing, temperature,
      // ENERGY STAR, load share, wrap measures. Everything else on the
      // improved side is a desk-side purchase spec of unbought equipment and
      // is excluded.

      /** The PROPOSED water heater type — "swap it for a heat pump water heater" is retrofit intent. */
      dhwType2Improved: DhwType.describe(
        'The proposed water heater type — a recommended swap ("put in a heat pump water heater") is dictated intent, not a purchase spec.',
      )
        .nullable()
        .optional(),

      /** The proposed unit's fuel — a fuel switch ("get off the oil") is dictated retrofit intent. */
      dhwFuel2Improved: DhwFuel.describe(
        "The proposed water heater's fuel — a recommended fuel switch is dictated intent, not a purchase spec.",
      )
        .nullable()
        .optional(),

      /** Proposed tank size in gallons — "go up to an eighty" is spoken sizing intent. */
      dhwTankSizeImproved: z
        .number()
        .describe(
          "Proposed tank size in gallons — spoken sizing intent; a tankless proposal has no tank, so leave it null.",
        )
        .nullable()
        .optional(),

      /** Proposed INPUT capacity in BTU/h — sizing intent; auditors rarely speak BTU/h for water heaters. */
      dhwHeatingCapacityImproved: z
        .number()
        .describe(
          "Proposed input capacity of the water heater in BTU per hour — sizing intent, stated only; auditors rarely speak BTU/hr for water heaters.",
        )
        .nullable()
        .optional(),

      /** Share of hot-water load the proposed system would carry — dictated allocation intent. */
      dhwPercentLoadImproved: z
        .number()
        .describe(
          "Share of the home's annual DHW load the proposed system would meet, as a percentage — a stated allocation of intent; improved shares across systems must add up to 100.",
        )
        .nullable()
        .optional(),

      /** "Make sure it's an ENERGY STAR one" — a product-class recommendation. */
      dhwEnergyStarImproved: z
        .enum(["Yes", "No"])
        .describe(
          "Whether the proposed water heater is ENERGY STAR certified — a named product-class recommendation, routinely spoken.",
        )
        .nullable()
        .optional(),

      /** Proposed water temperature in °F — "turn it down to 120" is dictated behavioural advice. */
      dhwTempImproved: z
        .number()
        .describe(
          'Proposed water temperature in °F — a setback recommendation ("turn it down to 120") is dictated advice, not a purchase spec.',
        )
        .nullable()
        .optional(),

      /** "We should wrap that tank" — a dictated measure, not a purchase spec. */
      dhwTankWrapImproved: z
        .enum(["Yes", "No"])
        .describe(
          "Whether to add tank wrap to the water heater — a dictated measure, not a purchase spec.",
        )
        .nullable()
        .optional(),

      /** Wrap the pipes — the same dictated measure. */
      dhwPipeWrapImproved: z
        .enum(["Yes", "No"])
        .describe(
          "Whether to add pipe wrap to the pipes from this water heater — a dictated measure, not a purchase spec.",
        )
        .nullable()
        .optional(),

      /** Length in feet of pipe wrap to apply — improved-ONLY, no base twin. */
      dhwPipeWrapLengthImproved: z
        .number()
        .describe(
          "Length in feet of pipe wrap to apply — the quantity of a dictated measure; this field exists only on the improved side.",
        )
        .nullable()
        .optional(),

      /** Percent of the water pipes supplied by this heater that get insulation — improved-ONLY, no base twin. */
      dhwPipeWrapPercentageImproved: z
        .number()
        .describe(
          "Percent of the water pipes supplied by this heater that are covered by pipe insulation — the quantity of a dictated measure; this field exists only on the improved side.",
        )
        .nullable()
        .optional(),
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

// == clothesDryer, freezer, range, refrigerator, pv ===========================
// The appliances-and-PV job-collection groups (doc 20 §5.6; target model per
// `docs/roadmap/design/job-collections-foundation-design.md`). Each is an
// array of per-instance records — a house can have more than one of most of
// these, and a job can genuinely have zero or more of each. None of the five
// has a natural instance key on the wire except the freezer's and
// refrigerator's Name fields, so instance identity rides the roster's
// discriminator mechanism (`inventory.ts`) for all five; the per-resource
// discriminator content lives there. There is deliberately NO `oven` group —
// the oven has no write endpoint anywhere in the spec (doc 20 §5.6 "Oven: a
// no-write-target finding").

/**
 * `POST /jobs/{jobId}/clothesDryer` — one clothes dryer record.
 *
 * Cardinality / instance label: NONE. No name, label or location field — two
 * dryers on one job are indistinguishable on the wire except by fuel,
 * manufacturer and model, and a dictated "the dryer in the basement" has no
 * writable home. Instance identity is the roster's job (`inventory.ts`); the
 * spoken location rides its discriminator, never a leaf here.
 */
export const ClothesDryerFields = z
  .object(
    withVendorDescriptions({
      /**
       * The dryer's fuel axis. "A gas dryer" decomposes into `"Natural Gas"`
       * here — never a fused token, the same discipline as the hvac fuel axis.
       */
      clothesDryerFuelType: ApplianceFuelType.nullable().optional(),

      /** Yes when this is a ventless / heat-pump dryer. */
      clothesDryerHeatPump: z.enum(["Yes", "No"]).nullable().optional(),

      /**
       * Rated Combined Energy Factor — a pure spec-sheet value with an inline
       * hand-computation in the vendor's own help text (CEF=EF/1.15). Record a
       * STATED number only; never look one up and never run the vendor's
       * computation.
       */
      clothesDryerEfficiency: z
        .number()
        .describe(
          "Rated Combined Energy Factor: record only a number the auditor stated out loud — never look one up from the Energy Star website and never compute it from an EF.",
        )
        .nullable()
        .optional(),

      /**
       * Manufacturer — FREE TEXT here, unlike freezer/refrigerator, which are
       * closed enums. The spoken make lands as said, no list to miss.
       */
      clothesDryerManufacturer: z.string().nullable().optional(),

      /** Model — a nameplate read-aloud, alphanumeric; capture it as spoken. */
      clothesDryerModel: z.string().nullable().optional(),

      /**
       * Serial number — a nameplate read-aloud and the worst ASR case in this
       * group. Capture it as spoken with the read-aloud quoted; lower the
       * confidence on a garbled passage rather than dropping or "fixing" it.
       */
      clothesDryerSerialNumber: z.string().nullable().optional(),
    }),
  )
  .strict();

/**
 * `POST /jobs/{jobId}/freezer` — one freezer record.
 *
 * Cardinality / instance label: YES — `freezerName`, an undocumented free-text
 * field with no length cap, doing double duty as the label AND the missing
 * location field AND the missing type field (there is no chest-vs-upright
 * field anywhere): "garage chest freezer" all lands in that one string.
 * Instance identity still rides the roster (`inventory.ts`); the spoken label
 * lands on `freezerName`.
 */
export const FreezerFields = z
  .object(
    withVendorDescriptions({
      /**
       * Annual consumption in kWh/yr — the vendor's modeling engine supplies
       * this and its own help text warns against overriding it. Record only a
       * value the auditor explicitly states; never estimate an annual kWh.
       */
      freezerUsage: z
        .number()
        .describe(
          "Annual energy consumption in kWh/yr — normally supplied by the vendor's modeling engine, so record it only when the auditor explicitly states a number; never estimate one.",
        )
        .nullable()
        .optional(),

      /** Manufacturer — the closed FREEZER-BRANDS list (see the enum). */
      freezerManufacturer: FreezerManufacturer.nullable().optional(),

      /**
       * Model year. Spec types this `string`; `write` stringifies. A STATED
       * year only — "probably from the nineties" is a decade, not a year:
       * leave the value `null` and carry the decade in the `sourceSpan` for
       * the reviewer to resolve.
       */
      freezerModelYear: z
        .number()
        .describe(
          'Model year as a number, only when a specific year was stated. A decade ("probably from the nineties") is not a year — leave this null and let the decade ride in the sourceSpan.',
        )
        .nullable()
        .optional(),

      /** Model number — a nameplate read-aloud. */
      freezerModel: z.string().nullable().optional(),

      /**
       * The instance label — the only human-facing one on this resource. The
       * vendor publishes NO description for it; this note is all the model
       * gets.
       */
      freezerName: z
        .string()
        .describe(
          'The freezer\'s spoken label, e.g. "the garage chest freezer" — there is no separate location field and no chest/upright type field, so the label as spoken (location and type included) is the whole of it.',
        )
        .nullable()
        .optional(),

      /** ENERGY STAR flag, when stated. */
      freezerEnergyStar: z.enum(["Yes", "No"]).nullable().optional(),
    }),
  )
  .strict();

/**
 * `POST /jobs/{jobId}/range` — one range record: the combined range+oven
 * cooking appliance.
 *
 * The oven has no write endpoint anywhere in the spec, and `rangeFuelType`'s
 * own vendor description says it covers "the range and oven" — so this record
 * is the oven fuel's only writable home. The loss, recorded rather than
 * fixable here: a genuinely dual-fuel kitchen (gas cooktop, electric wall
 * oven) cannot be expressed — the fuel collapses to whichever side cooks most
 * often, and the discarded half survives only in the span. Likewise a standing
 * pilot ("gas range with a standing pilot") degrades to `"Natural Gas"` with
 * the pilot detail lost.
 *
 * Cardinality / instance label: NONE — no name, label or location field;
 * instance identity rides the roster (`inventory.ts`).
 */
export const RangeFields = z
  .object(
    withVendorDescriptions({
      /**
       * Fuel for the range AND its oven — one value. A dictated dual-fuel
       * split ("gas cooktop but the wall oven is electric") takes the side
       * used to cook most often, with the whole utterance quoted.
       */
      rangeFuelType: ApplianceFuelType.nullable().optional(),

      /** Yes when the electric cooktop is induction, not electric resistance. */
      rangeInduction: z.enum(["Yes", "No"]).nullable().optional(),

      /** Manufacturer — FREE TEXT, unlike freezer/refrigerator. */
      rangeManufacturer: z.string().nullable().optional(),

      /** Model — a nameplate read-aloud. */
      rangeModel: z.string().nullable().optional(),

      /** Serial number — a nameplate read-aloud, rarely dictated. */
      rangeSerialNumber: z.string().nullable().optional(),
    }),
  )
  .strict();

/**
 * `POST /jobs/{jobId}/refrigerator` — one refrigerator record.
 *
 * Cardinality / instance label: YES — `refrigeratorName`, free text capped at
 * 30 characters, whose vendor description is a copy-paste bug (it carries the
 * Age/Size help text). That wrong text contains one real constraint: for
 * HPXML, the house's PRIMARY refrigerator must be created first — a
 * write-ordering concern, recorded here so whoever implements egress does not
 * miss it. No location field (kitchen vs. garage beer fridge fits only inside
 * the Name string) and no type field (no mini-fridge distinction; the size
 * bands are the only proxy). Instance identity rides the roster
 * (`inventory.ts`).
 */
export const RefrigeratorFields = z
  .object(
    withVendorDescriptions({
      /**
       * Banded age — a stated age maps to the band containing it ("about
       * twelve years old" → `"0-14"`); the bands overlap at 42, and a stated
       * 42 resolves to `"35-42"` (see the enum).
       */
      refrigeratorAge: RefrigeratorAge.nullable().optional(),

      /** Banded size in cubic feet — "an eighteen cubic foot" → `"16-18"`. */
      refrigeratorSize: RefrigeratorSize.nullable().optional(),

      /**
       * The instance label — "the kitchen fridge", "the garage beer fridge".
       * The vendor's own description of this field is the Age/Size help text
       * (a copy-paste bug); this is the LABEL field.
       */
      refrigeratorName: z
        .string()
        .describe(
          'The refrigerator\'s spoken label — "the kitchen fridge", "the garage beer fridge". Ignore the vendor description on this field (it is the Age/Size help text, a copy-paste bug): this is the label field, and the spoken location fits only here.',
        )
        .nullable()
        .optional(),

      /**
       * Annual consumption in kWh/yr — same modeling-engine caveat as
       * `freezerUsage`: a stated number only, never an estimate.
       */
      refrigeratorUsage: z
        .number()
        .describe(
          "Annual energy consumption in kWh/yr — normally supplied by the vendor's modeling engine, so record it only when the auditor explicitly states a number; never estimate one.",
        )
        .nullable()
        .optional(),

      /** Manufacturer — the closed FRIDGE-BRANDS list (see the enum). */
      refrigeratorManufacturer: RefrigeratorManufacturer.nullable().optional(),

      /** Model number — a nameplate read-aloud. */
      refrigeratorModel: z.string().nullable().optional(),

      /** ENERGY STAR flag, when stated. */
      refrigeratorEnergyStar: z.enum(["Yes", "No"]).nullable().optional(),

      /**
       * Model year — redundant with `refrigeratorAge`, and the two can
       * contradict. Fill whichever the auditor actually stated: a stated age
       * fills the age band, a stated year fills this; both stated fills both
       * and the contradiction is the reviewer's to resolve. Spec types this
       * `string`; `write` stringifies.
       */
      refrigeratorModelYear: z
        .number()
        .describe(
          "Model year as a number, only when a specific year was stated. Redundant with the age band: never derive one from the other — a stated age fills refrigeratorAge, a stated year fills this, and a contradiction between the two is the reviewer's to resolve.",
        )
        .nullable()
        .optional(),

      /**
       * Condition rating (see the enum for the vendor's response-side
       * meanings). Narrated constantly ("it's in rough shape"), but the
       * create endpoint publishes no meaning for the members — the meanings
       * travel on the enum's description, and only a stated assessment fills
       * it.
       */
      refrigeratorMaintenanceStarRating: RefrigeratorMaintenanceStarRating.nullable().optional(),
    }),
  )
  .strict();

/**
 * `POST /jobs/{jobId}/pv` — one rooftop solar PV array record.
 *
 * Cardinality / instance label: NONE — the sharpest gap of the five.
 * `pvArraySlope` and `pvArrayOrientation` are PER RECORD, which is the schema
 * saying a home can have several arrays on different roof planes, yet there is
 * no name, label, roof-plane or location field: "six kilowatt on the south
 * slope, another two on the garage" produces two records indistinguishable on
 * the wire. Instance identity rides the roster (`inventory.ts`), keyed by
 * array size and the roof plane / orientation the auditor places it on.
 */
export const PvFields = z
  .object(
    withVendorDescriptions({
      /**
       * A whole-home presence flag living on a per-instance resource — treat
       * it as "this array exists". A record is only created for an array the
       * auditor introduced, so this is `"Yes"` grounded in that introduction;
       * a house with no solar is the roster's stated-none mechanism, never a
       * `pv: "No"` record.
       */
      pv: z
        .enum(["Yes", "No"])
        .describe(
          'Whether the home has a Solar PV System — a whole-home presence flag the vendor put on a per-instance resource. Treat it as "this array exists": a record exists only because an array was introduced, so this is "Yes"; a house with no solar produces no record at all, never a "No" here.',
        )
        .nullable()
        .optional(),

      /**
       * Array size in kW — "a six kilowatt array" → 6. A dictated panel count
       * × wattage is NOT multiplied into this field; the product is a
       * deterministic pass nobody has written, so the numbers ride the span
       * and the value stays `null`.
       */
      pvArraySize: z
        .number()
        .describe(
          'Array system size in kW, only as stated ("a six kilowatt array" → 6). When the auditor gives a panel count and a per-panel wattage instead, do NOT multiply them into this field — leave it null and let both numbers ride in the sourceSpan.',
        )
        .nullable()
        .optional(),

      /**
       * Annual production in kWh — comes off a bill or a monitoring app;
       * record it only when stated.
       */
      pvAnnualProduction: z.number().nullable().optional(),

      /**
       * Collector-surface slope in DEGREES, only as stated in degrees. A
       * spoken roof pitch ("four-twelve") is not degrees, and pitch→degrees is
       * arithmetic the model never does: the value stays `null` and the pitch
       * rides the `sourceSpan` for the reviewer.
       */
      pvArraySlope: z
        .number()
        .describe(
          'Slope of the collector surface in degrees, only when stated in degrees. A spoken roof pitch ("four-twelve") is not degrees and converting it is arithmetic you never do — leave this null and let the pitch ride in the sourceSpan.',
        )
        .nullable()
        .optional(),

      /**
       * Orientation in degrees from North — a spoken cardinal maps to its
       * degrees (south → 180, southwest → 225). A mapping table, not a
       * passthrough; the cardinal→degrees vocabulary travels in the
       * description.
       */
      pvArrayOrientation: z
        .number()
        .describe(
          "Orientation of the array in degrees from North: north → 0, northeast → 45, east → 90, southeast → 135, south → 180, southwest → 225, west → 270, northwest → 315. Mapping a spoken cardinal to its degrees is semantic mapping, like picking an enum member; a stated number of degrees stays itself.",
        )
        .nullable()
        .optional(),

      /**
       * Module manufacture year — commonly narrated as the install vintage.
       * Spec types this `string`; `write` stringifies. A stated year only,
       * never derived from an age.
       */
      pvModuleYear: z
        .number()
        .describe(
          "Year the PV modules were manufactured, only when a specific year was stated (the install vintage counts when the auditor states it as the module year); never derived from a stated age.",
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

// == job =====================================================================
// A job-collection group (doc 20 §5.1; target model per
// `docs/roadmap/design/job-collections-foundation-design.md`) — and a SINGLETON,
// like `basedata`, `health` and `stage`: one job per recording session, so no
// roster/instance-identity wiring.

/**
 * `PUT /jobs/{jobId}` — the only way to update an existing job, and the only
 * job-write in scope: Snugg Pro launches the app with an existing `jobId`, so job
 * creation is out of scope. The update endpoint accepts exactly `serviceTime`,
 * `accountId`, `note` and `householdIncomeTier` (plus `companyId`, the tenancy fk
 * fixed per credential, excluded from capture like every other system field), so
 * the group carries only those four. The `POST /jobs` create surface — name,
 * address block, zip, job type, program, the property-owner block and the rest —
 * is write-once at creation with no update path, so it is not captured.
 *
 * Requiredness: `PUT /jobs/{jobId}` requires nothing, so the group declares
 * nothing in `adapter.ts`'s `requiredOnCreate`; the patch leaves stay
 * `.nullable().optional()` by construction like every other group's.
 */
export const JobFields = z
  .object(
    withVendorDescriptions({
      /** Appointment time; the wire format is `YYYY-MM-DD HH:MM:SS`. */
      serviceTime: z
        .string()
        .describe(
          'The appointment time, wire format YYYY-MM-DD HH:MM:SS. Fill it only when the transcript states an absolute date and time; a purely relative day ("Thursday at nine") stays null with the quote as sourceSpan — anchoring it to a calendar date is a later step, never a guess.',
        )
        .nullable()
        .optional(),

      /**
       * Captured as PLAIN FREE TEXT despite the integer wire type: the spoken
       * assignee name, per `runtime-reference-resolution-design.md`. The
       * name→account-id lookup is a review/write-time step that must be able to
       * fail visibly — the model never invents the integer.
       */
      accountId: z
        .string()
        .describe(
          'The Snugg Pro user this job is assigned to, as the spoken name in free text ("give this one to Dave") — despite the integer wire type, never an invented id: resolving the name against the real account list is a later, human-supervised step, not extraction\'s.',
        )
        .nullable()
        .optional(),

      /** Note to the assignee — the most obviously dictated field here. */
      note: z
        .string()
        .describe(
          "The note to the assignee or assigned user, dictated verbatim — the natural dictation target of this endpoint.",
        )
        .nullable()
        .optional(),

      /** Household income tier for the job. */
      householdIncomeTier: HouseholdIncomeTier.describe(
        'Household income tier for the job — reproduce the member character for character, including the spaced hyphen in "LMI 80 - 120".',
      )
        .nullable()
        .optional(),
    }),
  )
  .strict();

/**
 * `POST /jobs/{jobId}/report` — the authored text of the homeowner-facing
 * report. A job-collection resource (design `job-collections-foundation-design.md`)
 * but a per-job SINGLETON, like `basedata`, `health` and `stage`, not an array:
 * the path terminates at the resource name with no `{reportUuid}` sub-path, the
 * one verb is a `POST` summarised "Update Report" (upsert-on-the-job), and there
 * is no delete and no list (doc 20 §5.3 "Cardinality: per-job singleton").
 *
 * Scope is doc 20 §5.3's (a1)+(a2) verdicted `capture`/`capture?` surface only —
 * the genuine long-form prose fields and the short single-line labels. The
 * (b1)/(b2) `element*` display-mode and `page*` visibility flags are a
 * separately deferred tranche (opaque integers whose meanings live only in the
 * response definition), the presentation-only titles doc 20 verdicts `exclude`
 * stay out, and `customFields` is response-only.
 *
 * `concernsSidebar` reads like it wants the homeowner's concerns in prose but
 * is a short caption (doc 20 §5.3 "Free-text inventory and expected length") —
 * the live spec's `maxLength` hints doc 20 recorded are gone as of this
 * writing, so leaf descriptions state "short label," not a specific length.
 */
export const ReportFields = z
  .object(
    withVendorDescriptions({
      // --- (a1) Long-form narrative prose (doc 20 §5.3). ---

      /** The cover-page introduction, dictated for the homeowner. */
      coverTextArea: z
        .string()
        .describe(
          "Long-form prose — multi-sentence to multi-paragraph. Capture the introduction the auditor dictated for the cover page in their own words; never compose one yourself, and null when nothing was dictated.",
        )
        .nullable()
        .optional(),

      /** The additional-notes sidebar text; often the longest dictated block. */
      additionalNotesOverview: z
        .string()
        .describe(
          "Long-form prose — multi-sentence. Capture the catch-all notes the auditor dictated for the additional-notes sidebar in their own words; never compose notes yourself, and null when nothing was dictated.",
        )
        .nullable()
        .optional(),

      /** The health-and-safety narrative — prose, not the test matrix. */
      safetyOverview: z
        .string()
        .describe(
          "Long-form prose — one to several sentences. The health-and-safety narrative the auditor dictated for the report; a named test RESULT is a `health` leaf, and this narrative is never synthesized from the tests.",
        )
        .nullable()
        .optional(),

      // --- (a2) Short single-line labels / section titles. ---

      /** The report's own title, when the auditor named the deliverable. */
      titleCover: z
        .string()
        .describe(
          "A short single-line label. Capture it only when the auditor actually named the report; never a sentence.",
        )
        .nullable()
        .optional(),

      /** The concerns-page sidebar caption, despite the name. */
      concernsSidebar: z
        .string()
        .describe(
          "Despite reading like it wants the homeowner's concerns, this is a short single-line sidebar caption, never a paragraph. A concern the homeowner voiced is a `concern` instance, not this field.",
        )
        .nullable()
        .optional(),

      /** The solutions-page subheader — uncapped in the API, still short. */
      solutionsTitle: z
        .string()
        .describe(
          "A subheader title — a short single-line label even though the API publishes no length cap for it. Capture it only when the auditor actually named the section; it is usually a template default.",
        )
        .nullable()
        .optional(),

      /** The first custom program section's title, when one was named. */
      titleCustom1: z
        .string()
        .describe(
          "A short single-line label. Custom sections have no template default, so capture the name only when the auditor gave one.",
        )
        .nullable()
        .optional(),

      /** The second custom program section's title, when one was named. */
      titleCustom2: z
        .string()
        .describe(
          "A short single-line label. Custom sections have no template default, so capture the name only when the auditor gave one.",
        )
        .nullable()
        .optional(),
    }),
  )
  .strict();

// A job-collection group (doc 20 §5.2; target model per
// `docs/roadmap/design/job-collections-foundation-design.md`).

/**
 * `POST /jobs/{jobId}/utilities` — the job's utility-billing record. A
 * job-collection resource (design `job-collections-foundation-design.md`) but a
 * SINGLETON, like `basedata` and `health`, not an array of instances: the path
 * has no `utilityId` segment, the response definition is one flat object of
 * scalars, and multiple fuels are modelled by name-mangled fields
 * (`electric*` / `fuel*` / `additionalFuel*`, `utilityPrice<Fuel>`), not by
 * repetition — one record per job, upserted (doc 20 §5.2).
 *
 * This is the endpoint's CORE subset only (doc 20 §8.3, the utilities-core
 * tranche): the mode/provenance selectors, the provider names, the simple-bill
 * scalars, the units and primary fuel, the per-fuel price overrides, and the
 * rate plans. Deliberately absent:
 *
 *   - the delivered-fuel windows and the detailed 12-month bill series —
 *     separate tranches, and the series is an import path, never dictation
 *     (doc 20 §5.2 3.7–3.8);
 *   - the three `*AccountNumber` fields — identifier-shaped captures, not
 *     names: doc 20 verdicts them `capture?` while flagging a 10–16 digit
 *     spoken string as a high-ASR-error target, and the tranche's scope is the
 *     provider NAMES;
 *   - `utilityRatePlanPriceElectricity` — verdicted `capture?` but held by doc
 *     20 itself: its semantics are unresolved (an annual dollar total, not a
 *     per-kWh rate) with an explicit "do not map until confirmed" (§5.2 3.6,
 *     §9 question 5).
 */
export const UtilitiesFields = z
  .object(
    withVendorDescriptions({
      /**
       * The bill-entry MODE — a control field gating which of the endpoint's
       * field families apply, not something an auditor utters (doc 20 §5.2 3.1).
       * Set it only when the auditor explicitly states the mode ("we're on
       * simple billing for this one"); the write path's own default is to
       * derive it from which families actually filled, not to trust a guess.
       */
      billEntryType: BillEntryType.describe(
        "Which bill-entry mode the job uses. Set it only when the auditor explicitly states the mode; never derive it from which other fields filled.",
      )
        .nullable()
        .optional(),

      /**
       * Provenance of the detailed-bill data — the import mechanism, not a fact
       * about the home (doc 20 §5.2 3.1). Set only from an explicit statement;
       * a Ribo-driven write defaults this to `"Manual"`.
       */
      detailedElectricDataSource: DetailedBillDataSource.describe(
        "Where the detailed electric bill data came from. Set only when the auditor explicitly states it; never assume an import mechanism.",
      )
        .nullable()
        .optional(),

      /** The fuel stream's provenance — same rule as the electric twin. */
      detailedFuelDataSource: DetailedBillDataSource.describe(
        "Where the detailed fuel bill data came from. Set only when the auditor explicitly states it; never assume an import mechanism.",
      )
        .nullable()
        .optional(),

      /** The electric utility's name as spoken ("they're on National Grid") — free text. */
      electricUtilityProviderName: z
        .string()
        .describe("The electric utility provider's name as spoken, free text.")
        .nullable()
        .optional(),

      /** The fuel utility's name as spoken — free text. */
      fuelUtilityProviderName: z
        .string()
        .describe("The fuel utility provider's name as spoken, free text.")
        .nullable()
        .optional(),

      /**
       * A SECOND fuel provider's name — the endpoint's only second-fuel
       * affordance; there is no second full fuel stream (doc 20 §5.2 2).
       */
      additionalFuelUtilityProviderName: z
        .string()
        .describe(
          "A second fuel utility provider's name as spoken, free text — the only affordance for a second fuel on this endpoint.",
        )
        .nullable()
        .optional(),

      /**
       * The highest monthly SUMMER electric bill in dollars, as stated — a bill
       * total, never a per-unit price (those are the `utilityPrice*` fields).
       */
      highestMonthlySummerElectricBill: z
        .number()
        .describe(
          "The highest monthly summer electric bill in dollars as stated — a bill total, not a per-unit price.",
        )
        .nullable()
        .optional(),

      /** The highest monthly WINTER electric bill in dollars, as stated. */
      highestMonthlyWinterElectricBill: z
        .number()
        .describe(
          "The highest monthly winter electric bill in dollars as stated — a bill total, not a per-unit price.",
        )
        .nullable()
        .optional(),

      /** The lowest monthly electric bill of the past year in dollars, as stated. */
      lowestMonthlyElectricBill: z
        .number()
        .describe("The lowest monthly electric bill in dollars as stated — a bill total.")
        .nullable()
        .optional(),

      /**
       * The highest monthly WINTER bill of the heating fuel in dollars. The
       * vendor names this field for natural gas but means the fuel heating the
       * largest area when several are in play.
       */
      highestMonthlyWinterNaturalGasBill: z
        .number()
        .describe(
          "The highest monthly winter bill of the heating fuel in dollars as stated — the fuel heating the largest area when several are in play.",
        )
        .nullable()
        .optional(),

      /** The lowest monthly bill of the heating fuel in dollars — typically a summer month. */
      lowestMonthlyNaturalGasBill: z
        .number()
        .describe(
          "The lowest monthly bill of the heating fuel in dollars as stated — typically a summer, hot-water-and-cooking-only month.",
        )
        .nullable()
        .optional(),

      /** Whether `totalSimpleFuelUsedInLast12Months` counts gallons delivered or dollars spent. */
      simpleFuelUnits: SimpleFuelUnits.describe(
        "Whether the simple fuel total is counted in gallons delivered or dollars spent — the unit qualifier on totalSimpleFuelUsedInLast12Months, not a bill figure of its own.",
      )
        .nullable()
        .optional(),

      /** Total fuel used over the past year, in the unit `simpleFuelUnits` names. */
      totalSimpleFuelUsedInLast12Months: z
        .number()
        .describe(
          "Total fuel used over the past twelve months as a bare number, in whichever unit simpleFuelUnits names — gallons delivered or dollars spent.",
        )
        .nullable()
        .optional(),

      /**
       * The home's PRIMARY heating fuel. A stated fact about the home, never an
       * inference from equipment mentions: a house with two systems has not said
       * which is primary until the auditor says so.
       */
      primaryHeatingFuelType: PrimaryHeatingFuelType.describe(
        "The home's primary heating fuel. Set it only when the auditor says which fuel primarily heats the home — never inferred from which equipment was mentioned.",
      )
        .nullable()
        .optional(),

      /** The unit the electric bill figures are entered in. */
      electricBillUnits: ElectricBillUnits.nullable().optional(),

      /**
       * The unit the fuel bill figures are entered in. The vendor's own description
       * here is a copy-paste bug — it recommends a `kWh` option that is not a member
       * of this list (doc 20 §4.7); never emit `kWh` for this field.
       */
      fuelBillUnits: FuelBillUnits.describe(
        "The unit the fuel bill figures are entered in. The vendor's description mentions a kWh option, but kWh is NOT a member of this list — never emit it here.",
      )
        .nullable()
        .optional(),

      /**
       * Per-unit price override for natural gas, as a bare number ("eighty-two
       * cents a therm" -> 0.82) — the vendor names no unit; it is the fuel's
       * implicit billing unit. Overrides the EIA regional default.
       */
      utilityPriceNaturalGas: z
        .number()
        .describe(
          "Per-unit price for natural gas as a bare number in the fuel's implicit billing unit, stated by the auditor; overrides the software's EIA regional default.",
        )
        .nullable()
        .optional(),

      /** Per-unit price override for propane ("a dollar fifty a gallon" -> 1.5) — same implicit-unit rule. */
      utilityPricePropane: z
        .number()
        .describe(
          "Per-unit price for propane as a bare number in the fuel's implicit billing unit, stated by the auditor; overrides the software's EIA regional default.",
        )
        .nullable()
        .optional(),

      /** Per-unit price override for fuel oil — same implicit-unit rule. */
      utilityPriceFuelOil: z
        .number()
        .describe(
          "Per-unit price for fuel oil as a bare number in the fuel's implicit billing unit, stated by the auditor; overrides the software's EIA regional default.",
        )
        .nullable()
        .optional(),

      /** Per-unit price override for electricity ("nine cents a kilowatt hour" -> 0.09) — same implicit-unit rule. */
      utilityPriceElectricity: z
        .number()
        .describe(
          "Per-unit price for electricity as a bare number in the implicit billing unit, stated by the auditor; overrides the software's EIA regional default.",
        )
        .nullable()
        .optional(),

      /**
       * Per-unit price for wood — the vendor keeps NO default for this fuel, so
       * it must be filled when wood is in use. Same implicit-unit rule.
       */
      utilityPriceWood: z
        .number()
        .describe(
          "Per-unit price for wood as a bare number in the fuel's implicit billing unit; the software has no default for this fuel, so it is required whenever wood is in use.",
        )
        .nullable()
        .optional(),

      /** Per-unit price for pellets — no vendor default exists; required when pellets are in use. */
      utilityPricePellets: z
        .number()
        .describe(
          "Per-unit price for pellets as a bare number in the fuel's implicit billing unit; the software has no default for this fuel, so it is required whenever pellets are in use.",
        )
        .nullable()
        .optional(),

      /** Per-unit price for coal — no vendor default exists; required when coal is in use. */
      utilityPriceCoal: z
        .number()
        .describe(
          "Per-unit price for coal as a bare number in the fuel's implicit billing unit; the software has no default for this fuel, so it is required whenever coal is in use.",
        )
        .nullable()
        .optional(),

      /** Per-unit price for kerosene — no vendor default exists; required when kerosene is in use. */
      utilityPriceKerosene: z
        .number()
        .describe(
          "Per-unit price for kerosene as a bare number in the fuel's implicit billing unit; the software has no default for this fuel, so it is required whenever kerosene is in use.",
        )
        .nullable()
        .optional(),

      /**
       * The electric rate plan's name as spoken, FREE TEXT: the spec declares
       * this field with `enum: []` and publishes no value list (doc 20 §4.5), so
       * the spoken name reaches review intact rather than being forced onto an
       * invented list — the `hvacDuctLocation` precedent.
       */
      electricRatePlan: z
        .string()
        .describe(
          "The electric utility rate plan's name as spoken, free text — the vendor publishes no value list for this field.",
        )
        .nullable()
        .optional(),

      /** The fuel rate plan's name as spoken — free text, same unpublished-enum treatment. */
      fuelRatePlan: z
        .string()
        .describe(
          "The utility fuel rate plan's name as spoken, free text — the vendor publishes no value list for this field.",
        )
        .nullable()
        .optional(),

      /**
       * The POST-RETROFIT electric rate plan's name — a proposal scenario, not
       * an observed site condition, which is why doc 20 §5.2 3.6 verdicts it
       * only `capture?`. Free text (unpublished value list); set it only when a
       * future rate plan is explicitly proposed, never the current plan
       * repeated.
       */
      electricRatePlanImproved: z
        .string()
        .describe(
          "The post-retrofit electric rate plan's name as spoken, free text — a proposal scenario, not an observed condition; set it only when a future rate plan is explicitly proposed.",
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
// `health`, `stage` and `job` are genuine singletons and stay objects.

export const snuggValuesSchema = z
  .object({
    basedata: BasedataFields.optional(),
    hvac: z.array(HvacFields).optional(),
    attic: z.array(AtticFields).optional(),
    vault: z.array(VaultFields).optional(),
    wall: z.array(WallFields).optional(),
    window: z.array(WindowFields).optional(),
    door: z.array(DoorFields).optional(),
    dhw: z.array(DhwFields).optional(),
    health: HealthFields.optional(),
    concern: z.array(ConcernFields).optional(),
    incentive: z.array(IncentiveFields).optional(),
    clothesDryer: z.array(ClothesDryerFields).optional(),
    freezer: z.array(FreezerFields).optional(),
    range: z.array(RangeFields).optional(),
    refrigerator: z.array(RefrigeratorFields).optional(),
    pv: z.array(PvFields).optional(),
    stage: StageFields.optional(),
    job: JobFields.optional(),
    report: ReportFields.optional(),
    utilities: UtilitiesFields.optional(),
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
