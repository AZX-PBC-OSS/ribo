/**
 * Few-shot examples for the Snugg Pro adapter — the optional `examples` on the
 * `ToolAdapter`. Kept as data on the adapter (not baked into the prompt) so the
 * extractor owns prompt assembly and the adapter owns only field knowledge.
 *
 * One worked transcript, chosen to demonstrate the highest-value hazards on a
 * single dictation: the fuel axis-split ("oil boiler" -> `boiler` + `fuel_oil`,
 * the same span justifying both fields), a stated DEPTH banded to `4-6` (NOT an
 * R-value), an indirect DHW off the boiler on its own fuel axis, an age band from
 * a stated age, two clean safety tests as `passed`, and honest `null`s — including
 * `null` values that still carry a span because the auditor addressed the topic
 * (BTU unreadable, blower door deferred).
 *
 * Every `sourceSpan` is a verbatim substring of `transcript` (the review card's
 * grounding check). The whole object is type-checked against `SnuggFields`, so a
 * drift in the schema breaks this file — it doubles as a fixture.
 *
 * Transcript sourced from the spike corpus (`02-oil-boiler-basement`); the values
 * mirror that transcript's ground truth. Confidence is illustrative (the spike
 * treats it as uncalibrated); it is not a calibrated signal.
 */

import type { ToolAdapterExample } from "@azx/ribo-core";
import type { SnuggFields } from "./schema.js";

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

const fields: SnuggFields = {
  // Heating — the fuel axis-split: one fused span, two independent fields.
  heatingEquipmentType: env("boiler", "it's an oil boiler"),
  heatingFuel: env("fuel_oil", "it's an oil boiler"),
  heatingManufacturer: env("Burnham", "it's an oil boiler, Burnham"),
  heatingModelNumber: env("V8", "Model plate says V8", 0.9),
  heatingModelYear: env(2004, "the tag year is two thousand four"),
  // BTU explicitly unreadable: null value, but a span proves it was addressed.
  heatingOutputCapacityBtuh: env(
    null,
    "I don't see an output on the plate that I can read, it's painted over, so no BTU number from me",
  ),

  coolingEquipmentType: env(null, null),

  ductLocation: env(null, null),
  ductSealing: env(null, null),
  ductInsulation: env(null, null),
  ductLeakageCfm25: env(null, null),

  // Attic — a stated DEPTH ("six inches") bands to 4-6; no R-value was spoken.
  atticInsulationDepthIn: env("4-6", "I got about six inches of it", 0.9),
  atticInsulationType: env("cellulose", "it's cellulose, gray blown-in"),
  atticInsulationSpokenRValue: env(null, null),

  wallInsulated: env(null, null),
  wallConstruction: env(null, null),

  // Blower door explicitly deferred: null value with a grounding span.
  blowerDoorCfm50: env(null, "No blower door today, I'll come back with the fan, ran out of time"),

  windowGlazing: env(null, null),
  windowFrame: env(null, null),

  // DHW — indirect off the boiler, its own fuel axis; age band from a stated age.
  dhwFuel: env("fuel_oil", "So that runs on the oil too, same as the boiler"),
  dhwSystemType: env(
    "space_heating_boiler_with_tank",
    "Hot water's made right off the boiler, it's an indirect tank",
  ),
  dhwAgeBand: env("6-10", "that tank's about eight years old", 0.9),

  combustionVentType: env(null, null),

  // Health & safety — two affirmative clean results are `passed`, not dropped;
  // every unmentioned test is `null` (silence is never an invented pass).
  healthSafety: {
    ambientCo: env(null, null),
    venting: env(null, null),
    naturalConditionSpillage: env(null, null),
    worstCaseDepressurization: env(null, null),
    worstCaseSpillage: env(null, null),
    draftPressure: env("passed", "I got good draft, nice steady pull up the chimney, that passes"),
    gasLeak: env("passed", "no leaks at the fittings either, all dry", 0.9),
    moldMoisture: env(null, null),
    asbestos: env(null, null),
    lead: env(null, null),
    electrical: env(null, null),
  },
};

export const snuggExamples: readonly ToolAdapterExample<SnuggFields>[] = [{ transcript, fields }];
