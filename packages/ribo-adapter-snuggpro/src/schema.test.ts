import { describe, expect, test } from "vitest";
import { snuggExamples } from "./examples.js";
import { snuggExtractionSchema, snuggValuesSchema } from "./schema.js";
import type { SnuggExtraction, SnuggValues } from "./schema.js";

/**
 * TWO schemas live in `schema.ts`, so two blocks live here. Which block a property
 * belongs in is the whole claim of R1.5 (design `r1.5-field-shape-contracts-design.md`
 * §2.1–§2.2):
 *
 *   - `confidence`, `sourceSpan` and the envelope keys are EXTRACTION properties — they
 *     exist nowhere in the patch, so this is the only place they can be stated.
 *   - "every field is required" is an EXTRACTION property whose exact INVERSE is a patch
 *     property: an omitted key is how a rejected field is expressed. Both are asserted;
 *     asserting only one would leave the more surprising half unpinned.
 *   - the enum vocabulary (the fuel axis-split) and `.strict()` are properties of BOTH:
 *     declared on the patch, and they must survive the derivation.
 */

// A known-valid, fully-populated ENVELOPED field set, reused as the base for the
// mutation tests below.
const fixture = snuggExamples[0];
if (!fixture) throw new Error("expected a Snugg Pro few-shot example fixture");
const valid = (): SnuggExtraction => structuredClone(fixture.fields);

/**
 * The same fixture as a PATCH: every envelope replaced by its `value`, group structure
 * preserved — what review produces when every field was accepted. Deriving it rather
 * than hand-writing a second fixture keeps the two from drifting, and states the
 * relationship between the shapes as code.
 */
const unwrap = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(unwrap);
  if (typeof node === "object" && node !== null && "value" in node) {
    return (node as { value: unknown }).value;
  }
  if (typeof node === "object" && node !== null) {
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, unwrap(child)]));
  }
  return node;
};
const validValues = (): SnuggValues => unwrap(valid()) as SnuggValues;

describe("snuggExtractionSchema — what the model is asked to produce", () => {
  test("parses a fully-populated, valid field set", () => {
    expect(() => snuggExtractionSchema.parse(valid())).not.toThrow();
  });

  test("confidence is unconstrained — a bare z.number() accepts out-of-range values", () => {
    // The reason confidence is not `.min(0).max(1)`: strict structured-output mode
    // rejects the `minimum`/`maximum` keywords those emit. Range-clamping is
    // normalization's job. This is an EXTRACTION property: `confidence` is an envelope
    // field and the patch has no such key.
    const fields = valid();
    fields.hvac![0]!.hvacSystemEquipmentType.confidence = 1.5;
    expect(() => snuggExtractionSchema.parse(fields)).not.toThrow();
  });

  test("rejects a fused enum token — the fuel axis must not collapse into equipment", () => {
    const fields = valid();
    // "Oil Boiler" is exactly the fused member the split-axis design forbids: fuel is
    // `hvacHeatingEnergySource`, never part of the equipment name. The enum is declared
    // on the PATCH; this asserts the derivation carries it through.
    (fields.hvac![0]!.hvacSystemEquipmentType as { value: unknown }).value = "Oil Boiler";
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });

  test("rejects a re-cased enum member — the wire strings are exact", () => {
    // The property the whole spec-derived rewrite rests on: `"6% - well sealed"` reads
    // as the same answer to a human and is a value Snugg Pro would refuse. If the schema
    // tolerated it, every enum leaf would need a normalization pass this design
    // deliberately does not have.
    const fields = valid();
    (fields.hvac![0]!.hvacDuctLeakage as { value: unknown }).value = "6% - well sealed";
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });

  test("is strict — an unexpected top-level key is rejected", () => {
    const fields = valid() as unknown as Record<string, unknown>;
    fields.somethingElse = { value: null, confidence: 1, sourceSpan: null };
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });

  test("is strict inside a resource group too", () => {
    const fields = valid();
    (fields.health as unknown as Record<string, unknown>).healthCarbonMonoxide = {
      value: "Passed",
      confidence: 1,
      sourceSpan: null,
    };
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });

  test("every field is required — an omitted key is not allowed (null is how absence is said)", () => {
    // The anti-hallucination rule: the model must emit an explicit `null` rather than
    // omit a key it never considered. The PATCH asserts the opposite below — the two
    // shapes differ in optionality by construction.
    const fields = valid();
    delete (fields.attic[0] as unknown as Record<string, unknown>).atticInsulationDepth;
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });

  test("a whole resource group is required too, not only its leaves", () => {
    // The group level is where "required at every level" could quietly stop holding:
    // required leaves say nothing about the group itself. A model that skips a group it
    // has nothing to say about must still fail rather than produce a short response.
    const fields = valid();
    delete (fields as unknown as Record<string, unknown>).window;
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });

  test("a group is NOT itself an envelope — the derivation recursed instead of wrapping", () => {
    // If `enveloped()` had wrapped each group whole, this would parse and review would
    // show one verdict per group — one verdict for the whole health matrix at once, the
    // exact failure field-level review exists to avoid.
    const fields = valid() as unknown as Record<string, unknown>;
    fields.health = { value: null, confidence: 1, sourceSpan: null };
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });

  test("a null value may still carry a non-null sourceSpan", () => {
    // The example's blower-door field is exactly this: deferred, so value is null but a
    // grounding span records that it was addressed. An EXTRACTION property only, like
    // `confidence`.
    const parsed = snuggExtractionSchema.parse(valid());
    expect(parsed.basedata.blowerDoorReading.value).toBeNull();
    expect(parsed.basedata.blowerDoorReading.sourceSpan).not.toBeNull();
  });

  test("a leaf envelope must carry all three keys", () => {
    const fields = valid();
    // missing `confidence`
    (fields.hvac![0]! as unknown as Record<string, unknown>).hvacHeatingEnergySource = {
      value: "Fuel Oil",
      sourceSpan: "it's an oil boiler",
    };
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });
});

describe("snuggValuesSchema — the writable patch", () => {
  test("parses a fully-populated, valid patch", () => {
    expect(() => snuggValuesSchema.parse(validValues())).not.toThrow();
  });

  test("an omitted key is allowed — that is exactly what a rejected field looks like", () => {
    // The inverse of the extraction schema's required-keys rule, and the property that
    // makes field-level review possible: rejecting one leaf must still write the rest
    // rather than fail the whole write (design §2.1).
    const fields = validValues();
    delete (fields.hvac![0]! as Record<string, unknown>).hvacHeatingSystemModel;
    const parsed = snuggValuesSchema.parse(fields);
    expect("hvacHeatingSystemModel" in (parsed.hvac?.[0] ?? {})).toBe(false);
    expect(parsed.hvac?.[0]?.hvacSystemEquipmentType).toBe("Boiler");
  });

  test("the empty patch parses — a review that rejected everything writes nothing", () => {
    expect(snuggValuesSchema.parse({})).toEqual({});
  });

  test("a present null is legal, and is a different thing from an absent key", () => {
    // Design §2.1's table: absent means "do not touch this field in Snugg Pro", a
    // present `null` means "write it as empty" — Snugg Pro's `"Not Tested"`. So
    // `.nullable()` and `.optional()` are two separate load-bearing halves.
    const parsed = snuggValuesSchema.parse({ hvac: [{ hvacHeatingEnergySource: null }] });
    expect("hvacHeatingEnergySource" in (parsed.hvac?.[0] ?? {})).toBe(true);
    expect(parsed.hvac?.[0]?.hvacHeatingEnergySource).toBeNull();
  });

  test("each resource group is optional as a whole, and nullable per leaf", () => {
    // A group with every leaf rejected writes no request to that endpoint at all,
    // which is only expressible because the group itself is `.optional()`.
    expect(snuggValuesSchema.parse({}).health).toBeUndefined();
    const parsed = snuggValuesSchema.parse({
      health: { healthAmbientCarbonMonoxide: null, healthLead: "Passed" },
    });
    expect(parsed.health).toEqual({ healthAmbientCarbonMonoxide: null, healthLead: "Passed" });
  });

  test("rejects a fused enum token — the fuel axis must not collapse into equipment", () => {
    // The split-axis rule is declared HERE, on the values; the extraction schema
    // inherits it. Asserting it on both is what shows the derivation preserved it.
    expect(() =>
      snuggValuesSchema.parse({ hvac: [{ hvacSystemEquipmentType: "Oil Boiler" }] }),
    ).toThrow();
  });

  test("leaf types are still checked — a patch is optional, not untyped", () => {
    expect(() =>
      snuggValuesSchema.parse({ hvac: [{ hvacHeatingSystemModelYear: "two thousand four" }] }),
    ).toThrow();
  });

  test("is strict — an unexpected top-level key is rejected", () => {
    expect(() => snuggValuesSchema.parse({ somethingElse: "x" })).toThrow();
  });

  test("is strict inside a resource group too", () => {
    expect(() => snuggValuesSchema.parse({ health: { healthCarbonMonoxide: "Passed" } })).toThrow();
  });

  test("a leaf cannot be addressed at the wrong endpoint", () => {
    // Grouping by endpoint is only load-bearing if enforced: a patch that put
    // `windowType` on `basedata` would build a request to an endpoint with no such
    // field, and the API would take the write and drop it.
    expect(() => snuggValuesSchema.parse({ basedata: { windowType: "Double pane" } })).toThrow();
  });

  test("an ENVELOPE is not a legal patch value — the two shapes are genuinely different", () => {
    // The cross-check that keeps this block from being a second copy of the one above:
    // a full model response must not parse as a patch. If it did, `schema` and
    // `extractionSchema` would be interchangeable and the split would be decoration.
    expect(snuggValuesSchema.safeParse(valid()).success).toBe(false);
    expect(snuggExtractionSchema.safeParse(validValues()).success).toBe(false);
  });

  test("accepts multiple instances per collection group", () => {
    const twoHvac = {
      hvac: [
        { hvacSystemEquipmentType: "Boiler", hvacUpgradeAction: "Keep an existing system as is" },
        {
          hvacSystemEquipmentType: "Central Heat Pump (shared ducts)",
          hvacUpgradeAction: "Replace with a newer model",
        },
      ],
    };
    const parsed = snuggValuesSchema.parse(twoHvac);
    expect(parsed.hvac).toHaveLength(2);
    expect(parsed.hvac?.[0]?.hvacSystemEquipmentType).toBe("Boiler");
    expect(parsed.hvac?.[1]?.hvacSystemEquipmentType).toBe("Central Heat Pump (shared ducts)");
  });

  test("rejects a bare object where a collection group expects an array", () => {
    expect(() =>
      snuggValuesSchema.parse({
        hvac: {
          hvacSystemEquipmentType: "Boiler",
          hvacUpgradeAction: "Keep an existing system as is",
        },
      }),
    ).toThrow();
  });

  test("singleton groups still reject arrays", () => {
    // `basedata` and `health` are genuine API singletons: a dictation cannot describe
    // two houses or two health matrices for the same job.
    expect(() => snuggValuesSchema.parse({ basedata: [{ yearBuilt: 2000 }] })).toThrow();
    expect(() =>
      snuggValuesSchema.parse({ health: [{ healthAmbientCarbonMonoxide: "Passed" }] }),
    ).toThrow();
  });

  test("round-trips a patch with two HVAC instances unchanged", () => {
    const original = {
      hvac: [
        {
          hvacSystemEquipmentType: "Boiler",
          hvacUpgradeAction: "Keep an existing system as is",
          hvacHeatingEnergySource: "Fuel Oil",
        },
        {
          hvacSystemEquipmentType: "Central Heat Pump (shared ducts)",
          hvacUpgradeAction: "Replace with a newer model",
          hvacHeatingEnergySource: "Electricity",
        },
      ],
    };
    expect(snuggValuesSchema.parse(original)).toEqual(original);
  });
});
