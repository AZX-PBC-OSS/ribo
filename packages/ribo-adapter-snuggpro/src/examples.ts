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
    },
  ],

  wall: [
    {
      wallsInsulated: env(null, null),
      wallExteriorWallSiding: env(null, null),
      wallCavityInsulation: env(null, null),
      wallCavityInsulationType: env(null, null),
    },
  ],

  window: [
    {
      windowType: env(null, null),
      windowFrame: env(null, null),
      windowEnergyStar: env(null, null),
    },
  ],

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
  },
};

export const snuggExamples: readonly ToolAdapterExample<SnuggExtraction>[] = [
  { transcript, fields },
];
