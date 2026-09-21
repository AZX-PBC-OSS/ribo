/**
 * Few-shot examples for the Snugg Pro adapter — the optional `examples` on the
 * `ToolAdapter`. Kept as data on the adapter (not baked into the prompt) so the
 * extractor owns prompt assembly and the adapter owns only field knowledge.
 *
 * One worked transcript, chosen to demonstrate the highest-value hazards on a
 * single dictation:
 *
 *   - the fuel axis-split — "oil boiler" is `"Boiler"` on the equipment axis and
 *     `"Fuel Oil"` on the fuel axis, the same span justifying both fields;
 *   - a **closed manufacturer enum** — the auditor says "Burnham", a real boiler
 *     make that is genuinely not on Snugg's list, so the value is `"Other"` while
 *     the span still quotes what was said. This is the case the old free-text
 *     `heatingManufacturer` could not represent and would have failed at write;
 *   - a stated DEPTH banded to `"4-6"` (and no R-value spoken, so `atticInsulation`
 *     stays `null` — the two are independent fields now, not a fallback pair);
 *   - an indirect DHW off the boiler: `"Sidearm Tank"` on its own fuel axis, with
 *     an age band from a stated age and a tank size in gallons;
 *   - two clean safety tests as `"Passed"`, in a 13-test matrix;
 *   - honest `null`s — including `null` values that still carry a span because the
 *     auditor addressed the topic (BTU unreadable, blower door deferred);
 *   - a required field left `null`: nothing in this transcript states an
 *     `hvacUpgradeAction`, and the correct answer is `null` even though the API
 *     requires it. Requiredness is surfaced to the auditor at review
 *     (`adapter.ts`'s `requiredOnCreate`), never invented by the model.
 *
 * Every `sourceSpan` is a verbatim substring of `transcript` (the review card's
 * grounding check). The whole object is type-checked against `SnuggExtraction` —
 * the ENVELOPED shape, which is what a few-shot example must be, since its fields
 * become the assistant turn the model imitates — so a drift in the schema breaks
 * this file. It doubles as a fixture.
 *
 * Transcript sourced from the spike corpus (`02-oil-boiler-basement`); the values
 * mirror that transcript's ground truth, re-expressed in the spec's literal
 * vocabulary. Confidence is illustrative (the spike treats it as uncalibrated); it
 * is not a calibrated signal.
 */

import type { ToolAdapterExample } from "@azx/ribo-core";
import type { SnuggExtraction } from "./schema.js";

const transcript = `Basement first on the Delgado job. Down here we've got the heating plant — it's an oil boiler, Burnham, cast iron sections. Model plate says V8, V-eight series, and the tag year is two thousand four. I don't see an output on the plate that I can read, it's painted over, so no BTU number from me.

Hot water's made right off the boiler, it's an indirect tank, a forty-gallon Amtrol hanging next to it. So that runs on the oil too, same as the boiler. I'd say that tank's about eight years old, the install sticker says twenty seventeen.

The oil tank's in the corner, two-seventy-five gallon, about two-thirds full.

I put the sniffer around the boiler and the oil lines, no gas smell obviously it's oil, but no leaks at the fittings either, all dry.

Draft on the boiler flue — I got good draft, nice steady pull up the chimney, that passes.

Up in the attic earlier I measured the insulation, it's cellulose, gray blown-in, and I got about six inches of it across most of the attic. Six inches of cellulose.

Upstairs is a separate system, a Carrier Infinity heat pump on electricity with its own air handler in the attic. It was installed in twenty fifteen and we'll keep it as is.

No blower door today, I'll come back with the fan, ran out of time. Ending for now.`;

/** Provenance envelope, literal-preserving so enum values keep their narrow type. */
const env = <const V>(value: V, sourceSpan: string | null, confidence = 1) => ({
  value,
  confidence,
  sourceSpan,
});

const fields: SnuggExtraction = {
  basedata: {
    yearBuilt: env(null, null),
    conditionedArea: env(null, null),
    floorsAboveGrade: env(null, null),
    numberOfBedrooms: env(null, null),
    typeOfHome: env(null, null),
    // Blower door explicitly deferred: null value with a grounding span.
    blowerDoorReading: env(
      null,
      "No blower door today, I'll come back with the fan, ran out of time",
    ),
    blowerDoorTestPerformed: env(null, null),
    averageWallHeight: env(null, null),
    houseLength: env(null, null),
    houseWidth: env(null, null),
    numberOfOccupants: env(null, null),
    frontOfBuildingOrientation: env(null, null),
    tuckUnderGarage: env(null, null),
    garageSize: env(null, null),
    programmableThermostatInstalled: env(null, null),
    heatingSetpointHigh: env(null, null),
    heatingSetpointLow: env(null, null),
    coolingSetpointHigh: env(null, null),
    coolingSetpointLow: env(null, null),
    thermostatManufacturer: env(null, null),
    thermostatModel: env(null, null),
    thermostatSerialNumber: env(null, null),
    totalNumberOfLightBulbs: env(null, null),
    sharedWallsNorth: env(null, null),
    percentOfCeilingsShared: env(null, null),
    percentOfFloorsShared: env(null, null),
    foundationBasement: env(null, null),
    foundationAboveGradeHeight: env(null, null),
    basementWallInsulation: env(null, null),
    crawlspaceInsulation: env(null, null),
    skylightArea: env(null, null),
    unmodeledBlowerDoorReading: env(null, null),
    equivalentNach: env(null, null),
    conditionedAirVolume: env(null, null),
    effectiveLeakageArea: env(null, null),
    modeledBasementWallArea: env(null, null),
    basementCavityInsulation: env(null, null),
    basementContinuousInsulation: env(null, null),
    basementWallAssemblyRValue: env(null, null),
    floorCavityInsulation: env(null, null),
    floorContinuousInsulation: env(null, null),
    floorAssemblyRValue: env(null, null),
    sharedWallsEast: env(null, null),
    sharedWallsSouth: env(null, null),
    sharedWallsWest: env(null, null),
    foundationCrawlspace: env(null, null),
    foundationSlab: env(null, null),
    foundationFramefloor: env(null, null),
    percentCflsOrLeds: env(null, null),
    crawlCavityInsulation: env(null, null),
    crawlWallInsulation: env(null, null),
    crawlAssemblyRValue: env(null, null),
    crawlspaceType: env(null, null),
    clothesWasherType: env(null, null),
    clothesWasherEnergyStar: env(null, null),
    clothesWasherManufacturer: env(null, null),
    clothesWasherModel: env(null, null),
    clothesWasherSerialNumber: env(null, null),
    clothesWasherMef: env(null, null),
    dishwasherEnergyStar: env(null, null),
    dishwasherEnergyFactor: env(null, null),
    percentCflOrLed: env(null, null),
    windZone: env(null, null),
    shielding: env(null, null),
    nFactor: env(null, null),
    dishwasherModel: env(null, null),
    dishwasherManufacturer: env(null, null),
    dishwasherModelYear: env(null, null),
    clothesWasherModelYear: env(null, null),
    numberOfIncandescents: env(null, null),
    numberOfCflsInstalled: env(null, null),
    numberOfCflsOrLeds: env(null, null),
    numberOfOutdoorIncandescents: env(null, null),
    numberOfOutdoorCfls: env(null, null),
    numberOfOutdoorLeds: env(null, null),
    hotTub: env(null, null),
    pool: env(null, null),
    poolPumpType: env(null, null),
    poolPumpHorsepower: env(null, null),
    basementHeating: env(null, null),
    basementCooling: env(null, null),
    poolSize: env(null, null),
    poolPumpTurnover: env(null, null),
    poolPumpHours: env(null, null),
    poolPumpManufacturer: env(null, null),
    poolPumpModel: env(null, null),
    poolPumpSerialNumber: env(null, null),
    poolPumpDaysPerYear: env(null, null),
    dishwasherInstalled: env(null, null),
    includesBasement: env(null, null),
    heatingDesignLoad: env(null, null),
    coolingSensibleDesignLoad: env(null, null),
    coolingLatentDesignLoad: env(null, null),
    designTempWinterOutdoor: env(null, null),
    designTempSummerOutdoor: env(null, null),
    designTempWinterIndoor: env(null, null),
    designTempSummerIndoor: env(null, null),
    numberOfUnits: env(null, null),
    numberOfLeds: env(null, null),
    crawlspaceRimJoistTreatment: env(null, null),
    crawlspaceRimJoistInsulation: env(null, null),
    crawlRimJoistAssemblyRValue: env(null, null),
    basementRimJoistTreatment: env(null, null),
    basementRimJoistInsulation: env(null, null),
    basementRimJoistAssemblyRValue: env(null, null),
    demandKW: env(null, null),
    demandKWSavings: env(null, null),
    cazMaxAmbientCo: env(null, null),
    ashrae622: env(null, null),
    ashraeKitchenFanCfm: env(null, null),
    ashraeKitchenWindow: env(null, null),
    ashraeNumberOfBathrooms: env(null, null),
    ashraeBathroomFan1Cfm: env(null, null),
    ashraeBathroom1Window: env(null, null),
    ashraeBathroomFan2Cfm: env(null, null),
    ashraeBathroom2Window: env(null, null),
    ashraeBathroomFan3Cfm: env(null, null),
    ashraeBathroom3Window: env(null, null),
    ashraeBathroomFan4Cfm: env(null, null),
    ashraeBathroom4Window: env(null, null),
    ashraeRequiredAdditionalCfm: env(null, null),
    floorCavityInsulationType: env(null, null),
    floorContinuousInsulationType: env(null, null),
    floorSkirtPresent: env(null, null),
    floorWingInsulationCondition: env(null, null),
    floorBellyInsulationCondition: env(null, null),
    floorFrameFloorType: env(null, null),
    floorInsulationLocation: env(null, null),
    crawlCavityInsulationType: env(null, null),
    crawlWallInsulationType: env(null, null),
    crawlspaceRimJoistInsulationType: env(null, null),
    basementCavityInsulationType: env(null, null),
    basementContinuousInsulationType: env(null, null),
    basementRimJoistInsulationType: env(null, null),
    windowVentingUsed: env(null, null),
    modeledSlabFloorArea: env(null, null),
    heatTapeLength: env(null, null),
    heatTapeLoad: env(null, null),
    heatTapeDailyFrequency: env(null, null),
    heatTapeAnnualFrequency: env(null, null),
    hasEv: env(null, null),
    evMilesDrive: env(null, null),
    evEfficiency: env(null, null),
    evHomeChargingPercent: env(null, null),
    evHomeChargingAmount: env(null, null),
    evCalculationMethod: env(null, null),
    evEnergyStarCharger: env(null, null),
    mainServicePanelMaxAmps: env(null, null),
    openBreakerSpots: env(null, null),
    basementCeilingCavityInsulation: env(null, null),
    basementCeilingCavityInsulationType: env(null, null),
    basementCeilingContinuousInsulation: env(null, null),
    basementCeilingContinuousInsulationType: env(null, null),
    basementCeilingAssemblyRValue: env(null, null),
    ventilationType: env(null, null),
    ventilationSchedule: env(null, null),
    ventilationCycleFrequency: env(null, null),
    ventilationCycleDuration: env(null, null),
    ventilationFlowRate: env(null, null),
    ventilationSensibleRecoveryEfficiency: env(null, null),
    ventilationTotalRecoveryEfficiency: env(null, null),
    ventilationFanPower: env(null, null),
    wholeHomeIsProfessionallyAirSealed: env(null, null),
  },

  hvac: [
    {
      // The fuel axis-split: one fused span, two independent fields.
      hvacSystemEquipmentType: env("Boiler", "it's an oil boiler"),
      // Nothing in this transcript recommends doing anything with the boiler. The
      // API requires this field; the model must still say `null` rather than pick.
      hvacUpgradeAction: env(null, null),
      hvacHeatingEnergySource: env("Fuel Oil", "it's an oil boiler"),
      // "Burnham" is a real make and not a member of Snugg's closed list, so the
      // stored value is `"Other"` while the span preserves what was actually said.
      hvacHeatingSystemManufacturer: env("Other", "it's an oil boiler, Burnham", 0.8),
      hvacHeatingSystemModel: env("V8", "Model plate says V8", 0.9),
      // The UNIT's model year, e.g. 2011 — never the home's year. Stringified at write.
      hvacHeatingSystemModelYear: env(2004, "the tag year is two thousand four"),
      // BTU explicitly unreadable: null value, but a span proves it was addressed.
      hvacHeatingCapacity: env(
        null,
        "I don't see an output on the plate that I can read, it's painted over, so no BTU number from me",
      ),
      hvacCoolingCapacity: env(null, null),
      hvacDuctLocation: env(null, null),
      hvacDuctLeakage: env(null, null),
      hvacDuctLeakageValue: env(null, null),
      hvacDuctInsulation: env(null, null),
      // Nothing in this transcript names the system, rates its condition,
      // states a load share or an efficiency, or recommends a replacement —
      // every remainder leaf (doc 20 §5.4) is an honest null.
      hvacSystemName: env(null, null),
      hvacHeatingIsCondensing: env(null, null),
      hvacPercentOfTotalHeatingLoad: env(null, null),
      hvacPercentOfTotalCoolingLoad: env(null, null),
      hvacCoolingSystemManufacturer: env(null, null),
      hvacCoolingSystemModel: env(null, null),
      hvacCoolingSystemIndoorModel: env(null, null),
      hvacCoolingSystemOutdoorModel: env(null, null),
      hvacCoolingSystemModelYear: env(null, null),
      hvacHeatingSystemIndoorModel: env(null, null),
      hvacHeatingSystemOutdoorModel: env(null, null),
      hvacCoolingSystemSerialNumber: env(null, null),
      hvacCoolingSystemIndoorSerialNumber: env(null, null),
      hvacCoolingSystemOutdoorSerialNumber: env(null, null),
      hvacHeatingSystemSerialNumber: env(null, null),
      hvacHeatingSystemIndoorSerialNumber: env(null, null),
      hvacHeatingSystemOutdoorSerialNumber: env(null, null),
      hvacDuctInsulationValue: env(null, null),
      hvacHeatPumpInverter: env(null, null),
      energyStarColdClimateHeatPump: env(null, null),
      hvacHeatingMaintenanceStarRating: env(null, null),
      hvacCoolingMaintenanceStarRating: env(null, null),
      hvacSteadyStateEfficiency: env(null, null),
      hvacHeatingSystemEfficiency: env(null, null),
      hvacCoolingSystemEfficiency: env(null, null),
      hvacHeatingSystemEfficiencyRatingUnit: env(null, null),
      hvacCoolingSystemEfficiencyRatingUnit: env(null, null),
      hvacHeatingEnergySourceImproved: env(null, null),
      hvacHeatingCapacityImproved: env(null, null),
      hvacCoolingCapacityImproved: env(null, null),
      hvacPercentOfTotalHeatingLoadImproved: env(null, null),
      hvacPercentOfTotalCoolingLoadImproved: env(null, null),
      hvacHeatPumpInverterImproved: env(null, null),
      energyStarColdClimateHeatPumpImproved: env(null, null),
    },
    {
      // A second system demonstrates the array shape Task 10 exists to capture.
      hvacSystemEquipmentType: env(
        "Central Heat Pump (shared ducts)",
        "a Carrier Infinity heat pump on electricity with its own air handler in the attic",
        0.9,
      ),
      hvacUpgradeAction: env("Keep an existing system as is", "we'll keep it as is"),
      hvacHeatingEnergySource: env("Electricity", "heat pump on electricity"),
      hvacHeatingSystemManufacturer: env("Carrier", "Carrier"),
      hvacHeatingSystemModel: env("Infinity", "Infinity"),
      hvacHeatingSystemModelYear: env(2015, "twenty fifteen"),
      hvacHeatingCapacity: env(null, null),
      hvacCoolingCapacity: env(null, null),
      hvacDuctLocation: env(null, null),
      hvacDuctLeakage: env(null, null),
      hvacDuctLeakageValue: env(null, null),
      hvacDuctInsulation: env(null, null),
      // "Keep an existing system as is" leaves the improved side blank by the
      // field's own semantics, and nothing else new is stated either.
      hvacSystemName: env(null, null),
      hvacHeatingIsCondensing: env(null, null),
      hvacPercentOfTotalHeatingLoad: env(null, null),
      hvacPercentOfTotalCoolingLoad: env(null, null),
      hvacCoolingSystemManufacturer: env(null, null),
      hvacCoolingSystemModel: env(null, null),
      hvacCoolingSystemIndoorModel: env(null, null),
      hvacCoolingSystemOutdoorModel: env(null, null),
      hvacCoolingSystemModelYear: env(null, null),
      hvacHeatingSystemIndoorModel: env(null, null),
      hvacHeatingSystemOutdoorModel: env(null, null),
      hvacCoolingSystemSerialNumber: env(null, null),
      hvacCoolingSystemIndoorSerialNumber: env(null, null),
      hvacCoolingSystemOutdoorSerialNumber: env(null, null),
      hvacHeatingSystemSerialNumber: env(null, null),
      hvacHeatingSystemIndoorSerialNumber: env(null, null),
      hvacHeatingSystemOutdoorSerialNumber: env(null, null),
      hvacDuctInsulationValue: env(null, null),
      hvacHeatPumpInverter: env(null, null),
      energyStarColdClimateHeatPump: env(null, null),
      hvacHeatingMaintenanceStarRating: env(null, null),
      hvacCoolingMaintenanceStarRating: env(null, null),
      hvacSteadyStateEfficiency: env(null, null),
      hvacHeatingSystemEfficiency: env(null, null),
      hvacCoolingSystemEfficiency: env(null, null),
      hvacHeatingSystemEfficiencyRatingUnit: env(null, null),
      hvacCoolingSystemEfficiencyRatingUnit: env(null, null),
      hvacHeatingEnergySourceImproved: env(null, null),
      hvacHeatingCapacityImproved: env(null, null),
      hvacCoolingCapacityImproved: env(null, null),
      hvacPercentOfTotalHeatingLoadImproved: env(null, null),
      hvacPercentOfTotalCoolingLoadImproved: env(null, null),
      hvacHeatPumpInverterImproved: env(null, null),
      energyStarColdClimateHeatPumpImproved: env(null, null),
    },
  ],

  attic: [
    {
      // A stated DEPTH ("six inches") bands to 4-6. No R-value was spoken, so the
      // independent R-value field stays null — it is not derived from the depth.
      atticInsulationDepth: env("4-6", "I got about six inches of it", 0.9),
      atticInsulationType: env("Cellulose", "it's cellulose, gray blown-in"),
      atticInsulation: env(null, null),
      atticHasKneeWall: env(null, null),
      atticRoofType: env(null, null),
      // The remainder of the endpoint's verdicted capture surface: nothing in this
      // transcript states an area, a knee wall, a roof coefficient or any retrofit, so
      // every one of them is an unforced null.
      atticModeledAtticArea: env(null, null),
      atticKneeWallArea: env(null, null),
      atticKneeWallInsulation: env(null, null),
      atticKneeWallContinuousInsulation: env(null, null),
      atticRadiantBarrier: env(null, null),
      atticPercent: env(null, null),
      atticRoofAbsorptance: env(null, null),
      atticRoofEmissivity: env(null, null),
      atticCoolRoof: env(null, null),
      atticKneeWallInsulationType: env(null, null),
      atticKneeWallContinuousInsulationType: env(null, null),
      atticRoofColor: env(null, null),
      atticInsulationTypeImproved: env(null, null),
      atticModeledAtticAreaImproved: env(null, null),
      atticInsulationImproved: env(null, null),
      atticKneeWallAreaImproved: env(null, null),
      atticKneeWallInsulationImproved: env(null, null),
      atticKneeWallContinuousInsulationImproved: env(null, null),
      atticHasKneeWallImproved: env(null, null),
      atticRadiantBarrierImproved: env(null, null),
      atticRoofAbsorptanceImproved: env(null, null),
      atticRoofEmissivityImproved: env(null, null),
      atticCoolRoofImproved: env(null, null),
      atticKneeWallInsulationTypeImproved: env(null, null),
      atticKneeWallContinuousInsulationTypeImproved: env(null, null),
    },
  ],

  // The attic in this transcript is a flat-floor attic; no vaulted or cathedral ceiling
  // is ever brought up, so the honest roster-driven output is an empty array — the
  // "transcript never brings the group up at all" case, not one all-null instance.
  vault: [],

  wall: [
    {
      wallsInsulated: env(null, null),
      wallExteriorWallSiding: env(null, null),
      wallCavityInsulation: env(null, null),
      wallCavityInsulationType: env(null, null),
      // The remainder of the endpoint's verdicted capture surface (doc 20 §5.5):
      // nothing in this transcript states a construction, a continuous insulation,
      // an area, a share or any wall retrofit, so every one of them is an unforced null.
      wallExteriorWallConstruction: env(null, null),
      wallContinuousInsulation: env(null, null),
      wallModeledWallArea: env(null, null),
      wallSystemPercentOfTotal: env(null, null),
      wallContinuousInsulationType: env(null, null),
      wallCavityInsulationImproved: env(null, null),
      wallContinuousInsulationImproved: env(null, null),
      wallModeledWallAreaImproved: env(null, null),
      wallCavityInsulationTypeImproved: env(null, null),
      wallContinuousInsulationTypeImproved: env(null, null),
    },
  ],

  window: [
    {
      windowType: env(null, null),
      windowFrame: env(null, null),
      windowEnergyStar: env(null, null),
      windowEfficiency: env(null, null),
      windowAreaNorth: env(null, null),
      windowAreaEast: env(null, null),
      windowAreaSouth: env(null, null),
      windowAreaWest: env(null, null),
      windowNorthAreaPercent: env(null, null),
      windowEastAreaPercent: env(null, null),
      windowSouthAreaPercent: env(null, null),
      windowWestAreaPercent: env(null, null),
      windowSolarHeatGainCoefficient: env(null, null),
      windowNorthOverhangDepth: env(null, null),
      windowEastOverhangDepth: env(null, null),
      windowSouthOverhangDepth: env(null, null),
      windowWestOverhangDepth: env(null, null),
      windowExteriorTreatmentNorth: env(null, null),
      windowExteriorTreatmentEast: env(null, null),
      windowExteriorTreatmentSouth: env(null, null),
      windowExteriorTreatmentWest: env(null, null),
      windowEfficiencyImproved: env(null, null),
      windowAreaNorthImproved: env(null, null),
      windowAreaEastImproved: env(null, null),
      windowAreaSouthImproved: env(null, null),
      windowAreaWestImproved: env(null, null),
      windowSolarHeatGainCoefficientImproved: env(null, null),
      windowExteriorTreatmentNorthImproved: env(null, null),
      windowExteriorTreatmentEastImproved: env(null, null),
      windowExteriorTreatmentSouthImproved: env(null, null),
      windowExteriorTreatmentWestImproved: env(null, null),
      windowEnergyStarImproved: env(null, null),
    },
  ],

  // No door is ever brought up in this transcript, so the honest roster-driven output
  // is an empty array — the "transcript never brings the group up at all" case, not one
  // all-null instance.
  door: [],

  dhw: [
    {
      // Indirect off the boiler — Snugg's name for that is "Sidearm Tank".
      dhwType2: env("Sidearm Tank", "Hot water's made right off the boiler, it's an indirect tank"),
      dhwFuel2: env("Fuel Oil", "So that runs on the oil too, same as the boiler"),
      dhwAge: env("6-10", "that tank's about eight years old", 0.9),
      // The tank is in the basement, which is not obviously any of Snugg's three
      // locations — an unforced `null` beats a guess between them.
      dhwLocation: env(null, null),
      dhwTankSize: env(40, "a forty-gallon Amtrol"),
      dhwManufacturer: env("Other", "a forty-gallon Amtrol", 0.8),
      // Nothing in this transcript names a temperature setting, a model or
      // serial, a load share, an efficiency, a wrap, a condition rating or any
      // recommendation — every remainder leaf (doc 20 §5.4) is an honest null.
      // The install-sticker year is an install date, not the model year, so
      // `dhwModelYear` stays null too (rule 1 — never derive one field from
      // another).
      dhwTemperatureSettings: env(null, null),
      dhwTemp: env(null, null),
      dhwModel: env(null, null),
      dhwModelYear: env(null, null),
      dhwSerialNumber: env(null, null),
      dhwPercentLoad: env(null, null),
      dhwEnergyStar: env(null, null),
      dhwHeatingCapacity: env(null, null),
      dhwTankWrap: env(null, null),
      dhwTankWrapRValue: env(null, null),
      dhwPipeWrap: env(null, null),
      dhwPipeWrapRValue: env(null, null),
      dhwMaintenanceStarRating: env(null, null),
      dhwSidearmBoiler: env(null, null),
      dhwSidearmStandbyLoss: env(null, null),
      dhwEnergyFactorType: env(null, null),
      dhwEnergyFactor: env(null, null),
      dhwUnifiedEnergyFactor: env(null, null),
      dhwRecoveryEfficiency: env(null, null),
      hesDhwEnergyFactor: env(null, null),
      dhwType2Improved: env(null, null),
      dhwFuel2Improved: env(null, null),
      dhwTankSizeImproved: env(null, null),
      dhwHeatingCapacityImproved: env(null, null),
      dhwPercentLoadImproved: env(null, null),
      dhwEnergyStarImproved: env(null, null),
      dhwTempImproved: env(null, null),
      dhwTankWrapImproved: env(null, null),
      dhwPipeWrapImproved: env(null, null),
      dhwPipeWrapLengthImproved: env(null, null),
      dhwPipeWrapPercentageImproved: env(null, null),
    },
  ],

  health: {
    // Two affirmative clean results are `"Passed"`, not dropped; every unmentioned
    // test is `null` (silence is never an invented pass).
    healthAmbientCarbonMonoxide: env(null, null),
    healthNaturalConditionSpillage: env(null, null),
    healthWorstCaseDepressurization: env(null, null),
    healthWorstCaseSpillage: env(null, null),
    healthUndilutedFlueCo: env(null, null),
    healthDraftPressure: env(
      "Passed",
      "I got good draft, nice steady pull up the chimney, that passes",
    ),
    healthGasLeak: env("Passed", "no leaks at the fittings either, all dry", 0.9),
    healthVenting: env(null, null),
    healthMoldMoisture: env(null, null),
    healthRadon: env(null, null),
    healthAsbestos: env(null, null),
    healthLead: env(null, null),
    healthElectrical: env(null, null),
    healthRoofCondition: env(null, null),
    healthDrainageSystemCondition: env(null, null),
    // Nothing in this transcript states a disclosure conversation, and the field is
    // an attestation — never inferred from the draft/leak tests having been run.
    healthSafetyQuestionsDisclosed: env(null, null),
  },

  // This dictation is the auditor walking the basement alone — no homeowner worry
  // is voiced anywhere in it, so the concern collection is honestly EMPTY. The
  // empty array is itself the demonstration for this group: a transcript with no
  // voiced concern produces `[]`, never an invented one (rule 14).
  concern: [],

  // This transcript mentions no rebate or incentive program, so the honest
  // roster-driven output is an empty array — the "transcript never brings the
  // group up at all" case, not one all-null instance.
  incentive: [],

  // This basement walk-through names no appliance — no dryer, freezer, range or
  // refrigerator comes up — so every appliance collection is honestly EMPTY,
  // the same never-brought-up case as incentive above, not one all-null
  // instance per appliance.
  clothesDryer: [],
  freezer: [],
  range: [],
  refrigerator: [],

  // No solar PV either. An empty array — NOT a one-instance record carrying
  // `pv: "No"`: a house with no solar produces no pv record at all (rule 18).
  pv: [],

  stage: {
    // Nothing in this transcript moves the job's workflow stage, so the group's one
    // capture field is an unforced `null` — silence is never an invented stage, the
    // same discipline as an unmentioned health test.
    stageId: env(null, null),
  },

  job: {
    // This dictation is the auditor walking the basement alone — no appointment,
    // assignee, note or income tier is spoken anywhere in it, so every job leaf is an
    // unforced `null`. The group carries only PUT /jobs/{jobId}'s update surface (job
    // creation is out of scope), which requires nothing; requiredness is surfaced at
    // review via the adapter's `requiredOnCreate`, never invented by the model — the
    // same lesson the required-but-null `hvacUpgradeAction` above demonstrates.
    serviceTime: env(null, null),
    accountId: env(null, null),
    note: env(null, null),
    householdIncomeTier: env(null, null),
  },

  report: {
    // Nothing in this transcript is dictated AS REPORT COPY — no cover-page intro, no
    // notes narrative, no section labels — so every authored-text field is an unforced
    // `null`. The demonstration for this group is the same as the stage group's: the
    // model never composes report prose itself (rule 17), so a transcript with no
    // dictated report text produces all `null`s, never a written paragraph.
    coverTextArea: env(null, null),
    additionalNotesOverview: env(null, null),
    safetyOverview: env(null, null),
    titleCover: env(null, null),
    concernsSidebar: env(null, null),
    solutionsTitle: env(null, null),
    titleCustom1: env(null, null),
    titleCustom2: env(null, null),
  },

  utilities: {
    // The dictation never touches billing: no provider, bill figure, price, unit
    // or rate plan comes up, so every leaf is an honest null. The transcript DOES
    // state two heating systems on two different fuels (oil downstairs, electric
    // heat pump upstairs) without saying which is primary — so
    // `primaryHeatingFuelType` stays null too: which system primarily heats the
    // home was never stated, and inferring it from the equipment mentions is
    // exactly the derivation rule 1 forbids.
    billEntryType: env(null, null),
    detailedElectricDataSource: env(null, null),
    detailedFuelDataSource: env(null, null),
    electricUtilityProviderName: env(null, null),
    fuelUtilityProviderName: env(null, null),
    additionalFuelUtilityProviderName: env(null, null),
    highestMonthlySummerElectricBill: env(null, null),
    highestMonthlyWinterElectricBill: env(null, null),
    lowestMonthlyElectricBill: env(null, null),
    highestMonthlyWinterNaturalGasBill: env(null, null),
    lowestMonthlyNaturalGasBill: env(null, null),
    simpleFuelUnits: env(null, null),
    totalSimpleFuelUsedInLast12Months: env(null, null),
    primaryHeatingFuelType: env(null, null),
    electricBillUnits: env(null, null),
    fuelBillUnits: env(null, null),
    utilityPriceNaturalGas: env(null, null),
    utilityPricePropane: env(null, null),
    utilityPriceFuelOil: env(null, null),
    utilityPriceElectricity: env(null, null),
    utilityPriceWood: env(null, null),
    utilityPricePellets: env(null, null),
    utilityPriceCoal: env(null, null),
    utilityPriceKerosene: env(null, null),
    electricRatePlan: env(null, null),
    fuelRatePlan: env(null, null),
    electricRatePlanImproved: env(null, null),
  },
};

export const snuggExamples: readonly ToolAdapterExample<SnuggExtraction>[] = [
  { transcript, fields },
];
