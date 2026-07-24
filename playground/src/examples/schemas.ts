/**
 * @file Example JSON Schemas for the dev-only "Try it" extraction panel.
 *
 * Two schemas, both using the SnuggPro-style `{ value, confidence, sourceSpan }`
 * provenance envelope so the panel can render a grounded quote per field:
 *
 *   - {@link DEFAULT_SCHEMA} — a small, legible 3-field starter, prefilled so the
 *     panel is runnable immediately.
 *   - {@link SNUGGPRO_SCHEMA} — a larger, realistic subset of the real SnuggPro
 *     field set (equipment/fuel split, the attic depth-band vs spoken-R-value pair,
 *     a nested health-and-safety matrix) for a meatier demo.
 *
 * Exported as pretty-printed JSON strings — the panel drops them straight into the
 * CodeMirror editor.
 */

type JsonSchema = Record<string, unknown>;

/** An `{ value, confidence, sourceSpan }` provenance envelope around `valueSchema`. */
const envelope = (valueSchema: JsonSchema): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  required: ["value", "confidence", "sourceSpan"],
  properties: {
    value: valueSchema,
    confidence: { type: "number", description: "0..1 — how sure the value is what was said." },
    sourceSpan: {
      type: ["string", "null"],
      description: "Verbatim substring of the source text that justifies the value, or null.",
    },
  },
});

const defaultSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Home energy audit — starter",
  description:
    "A tiny 3-field example. Each field is a { value, confidence, sourceSpan } envelope.",
  type: "object",
  additionalProperties: false,
  required: ["heatingFuel", "atticInsulationRValue", "blowerDoorCfm50"],
  properties: {
    heatingFuel: envelope({
      type: ["string", "null"],
      description:
        "The fuel that heats the home, e.g. natural_gas, propane, fuel_oil, electricity.",
    }),
    atticInsulationRValue: envelope({
      type: ["number", "null"],
      description: "A spoken attic insulation R-value, e.g. R-38 -> 38. null if not stated.",
    }),
    blowerDoorCfm50: envelope({
      type: ["number", "null"],
      description: "Blower-door airflow at 50 pascals, in CFM50. null if not stated.",
    }),
  },
};

const heatingEquipmentType = {
  description: "Equipment axis only — fuel is a SEPARATE field.",
  enum: [
    "boiler",
    "furnace_central_ac",
    "central_heat_pump",
    "electric_resistance",
    "direct_heater",
    "stove_or_insert",
    "other",
    null,
  ],
};

const heatingFuel = {
  description: 'Fuel axis. "oil boiler" -> fuel_oil; "propane furnace" -> propane. Never fused.',
  enum: [
    "electricity",
    "natural_gas",
    "propane",
    "fuel_oil",
    "pellets",
    "wood",
    "solar",
    "other",
    null,
  ],
};

const coolingEquipmentType = {
  enum: [
    "central_ac_standalone_ducts",
    "room_ac",
    "central_heat_pump",
    "evaporative_cooler_direct",
    "evaporative_cooler_ducted",
    "none",
    "other",
    null,
  ],
};

const atticDepthBand = {
  description: "Depth BAND in inches — ONLY when a depth was stated. Not an R-value.",
  enum: ["0", "1-3", "4-6", "7-9", "10-12", "13-15", "16+", null],
};

const windowGlazing = { enum: ["single_pane", "double_pane", "other", null] };
const windowFrame = { enum: ["metal", "vinyl", "wood_or_metal_clad", "other", null] };
const healthState = {
  description: "A clean result is passed, not null. A test never mentioned is null.",
  enum: ["passed", "failed", "warning", "not_tested", null],
};

const snuggProSchema: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "SnuggPro energy audit — bounded field set (demo subset)",
  description:
    "A realistic subset of the SnuggPro capture fields. Every leaf is a { value, confidence, sourceSpan } envelope; healthSafety is a nested matrix of named tests.",
  type: "object",
  additionalProperties: false,
  required: [
    "heatingEquipmentType",
    "heatingFuel",
    "heatingOutputCapacityBtuh",
    "coolingEquipmentType",
    "atticInsulationDepthIn",
    "atticInsulationSpokenRValue",
    "windowGlazing",
    "windowFrame",
    "blowerDoorCfm50",
    "healthSafety",
  ],
  properties: {
    heatingEquipmentType: envelope(heatingEquipmentType),
    heatingFuel: envelope(heatingFuel),
    heatingOutputCapacityBtuh: envelope({
      type: ["number", "null"],
      description: 'Stated BTU output, e.g. "eighty thousand BTU" -> 80000.',
    }),
    coolingEquipmentType: envelope(coolingEquipmentType),
    atticInsulationDepthIn: envelope(atticDepthBand),
    atticInsulationSpokenRValue: envelope({
      type: ["number", "null"],
      description: 'A spoken R-value when no depth was measured, e.g. "R-30" -> 30.',
    }),
    windowGlazing: envelope(windowGlazing),
    windowFrame: envelope(windowFrame),
    blowerDoorCfm50: envelope({
      type: ["number", "null"],
      description: "Blower-door airflow at 50 pascals (NOT a duct-blaster CFM25).",
    }),
    healthSafety: {
      type: "object",
      additionalProperties: false,
      required: ["ambientCo", "naturalConditionSpillage", "moldMoisture"],
      properties: {
        ambientCo: envelope(healthState),
        naturalConditionSpillage: envelope(healthState),
        moldMoisture: envelope(healthState),
      },
    },
  },
};

export const DEFAULT_SCHEMA = JSON.stringify(defaultSchema, null, 2);
export const SNUGGPRO_SCHEMA = JSON.stringify(snuggProSchema, null, 2);
