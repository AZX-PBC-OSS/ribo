import { describe, expect, test } from "vitest";
import { snuggExamples } from "./examples.js";
import { snuggExtractionSchema, snuggValuesSchema } from "./schema.js";
import type { SnuggExtraction, SnuggValues } from "./schema.js";

/**
 * TWO schemas live in `schema.ts` now, so two blocks live here. Which block a
 * property belongs in is not a formality — it is the whole claim of R1.5
 * (design `r1.5-field-shape-contracts-design.md` §2.1–§2.2), and several of the
 * assertions below moved from one shape to the other rather than disappearing:
 *
 *   - `confidence`, `sourceSpan` and "all three envelope keys" are EXTRACTION
 *     properties. They are envelope fields; they exist nowhere in the patch, so
 *     these are not weaker tests in a new place, they are the only place the
 *     property can be stated at all.
 *   - "every field is required, an omitted key is not allowed" is an EXTRACTION
 *     property whose exact INVERSE is a patch property: an omitted key is how a
 *     rejected field is expressed. Both are asserted below, and asserting only
 *     one of them would leave the more surprising half unpinned.
 *   - the enum vocabulary (the fuel axis-split) and `.strict()` are properties of
 *     BOTH: they are declared on the patch and must survive the derivation.
 */

// A known-valid, fully-populated ENVELOPED field set (all 24 top-level keys + the
// 11-test health matrix), reused as the base for the mutation tests below.
const fixture = snuggExamples[0];
if (!fixture) throw new Error("expected a Snugg Pro few-shot example fixture");
const valid = (): SnuggExtraction => structuredClone(fixture.fields);

/**
 * The same fixture as a PATCH: every envelope replaced by its `value`. This is
 * what review produces from a model response in which every field was accepted —
 * deriving it rather than hand-writing 24 more fields keeps the two fixtures from
 * drifting, and states the relationship between the shapes as code.
 */
const validValues = (): SnuggValues => {
  const { healthSafety, ...top } = valid();
  return {
    ...Object.fromEntries(Object.entries(top).map(([key, env]) => [key, env.value])),
    healthSafety: Object.fromEntries(
      Object.entries(healthSafety).map(([key, env]) => [key, env.value]),
    ),
  } as SnuggValues;
};

describe("snuggExtractionSchema — what the model is asked to produce", () => {
  test("parses a fully-populated, valid field set", () => {
    expect(() => snuggExtractionSchema.parse(valid())).not.toThrow();
  });

  test("confidence is unconstrained — a bare z.number() accepts out-of-range values", () => {
    // The whole reason confidence is not `.min(0).max(1)`: strict structured-output
    // mode rejects the `minimum`/`maximum` keywords those emit. Range-clamping is
    // normalization's job, so the schema itself must accept 1.5. This is an
    // EXTRACTION property: `confidence` is an envelope field and the patch has no
    // such key, so there is nowhere else this could be asserted.
    const fields = valid();
    fields.heatingEquipmentType.confidence = 1.5;
    expect(() => snuggExtractionSchema.parse(fields)).not.toThrow();
  });

  test("rejects a fused enum token — the fuel axis must not collapse into equipment", () => {
    const fields = valid();
    // "oil_boiler" is exactly the fused member the split-axis design forbids. The
    // enum is declared on the PATCH; this asserts the derivation carries it through
    // rather than widening the leaf on the way into the envelope.
    (fields.heatingEquipmentType as { value: unknown }).value = "oil_boiler";
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });

  test("is strict — an unexpected top-level key is rejected", () => {
    const fields = valid() as unknown as Record<string, unknown>;
    fields.somethingElse = { value: null, confidence: 1, sourceSpan: null };
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });

  test("is strict inside the health matrix too", () => {
    const fields = valid();
    (fields.healthSafety as unknown as Record<string, unknown>).radon = {
      value: "passed",
      confidence: 1,
      sourceSpan: null,
    };
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });

  test("every field is required — an omitted key is not allowed (null is how absence is said)", () => {
    // The anti-hallucination rule: the model must emit an explicit `null` rather
    // than omit a key it never considered. Note the PATCH asserts the opposite,
    // below — the two shapes differ in optionality by construction, and that is
    // the design rather than a leak.
    const fields = valid() as unknown as Record<string, unknown>;
    delete fields.combustionVentType;
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });

  test("a null value may still carry a non-null sourceSpan", () => {
    // The example's blower-door field is exactly this: deferred, so value is null
    // but a grounding span records that it was addressed. `sourceSpan` is an
    // envelope field, so like `confidence` this is an EXTRACTION property only.
    const parsed = snuggExtractionSchema.parse(valid());
    expect(parsed.blowerDoorCfm50.value).toBeNull();
    expect(parsed.blowerDoorCfm50.sourceSpan).not.toBeNull();
  });

  test("a leaf envelope must carry all three keys", () => {
    const fields = valid() as unknown as Record<string, unknown>;
    fields.heatingFuel = { value: "fuel_oil", sourceSpan: "oil boiler" }; // missing confidence
    expect(() => snuggExtractionSchema.parse(fields)).toThrow();
  });
});

describe("snuggValuesSchema — the writable patch", () => {
  test("parses a fully-populated, valid patch", () => {
    expect(() => snuggValuesSchema.parse(validValues())).not.toThrow();
  });

  test("an omitted key is allowed — that is exactly what a rejected field looks like", () => {
    // The inverse of the extraction schema's required-keys rule, and the property
    // that makes field-level review possible at all: rejecting one leaf of 34 must
    // still write the other 33 rather than fail the whole write (design §2.1).
    const fields = validValues() as Record<string, unknown>;
    delete fields.combustionVentType;
    const parsed = snuggValuesSchema.parse(fields);
    expect("combustionVentType" in parsed).toBe(false);
    expect(parsed.heatingEquipmentType).toBe("boiler");
  });

  test("the empty patch parses — a review that rejected everything writes nothing", () => {
    expect(snuggValuesSchema.parse({})).toEqual({});
  });

  test("a present null is legal, and is a different thing from an absent key", () => {
    // Design §2.1's table: absent means "do not touch this field in Snugg Pro",
    // a present `null` means "write it as empty" — Snugg Pro's `Not Tested`. The
    // patch must be able to say both, so `.nullable()` and `.optional()` are two
    // separate load-bearing halves, not a redundant pair.
    const parsed = snuggValuesSchema.parse({ heatingFuel: null });
    expect("heatingFuel" in parsed).toBe(true);
    expect(parsed.heatingFuel).toBeNull();
  });

  test("the health matrix is optional as a whole, and nullable per test", () => {
    expect(snuggValuesSchema.parse({}).healthSafety).toBeUndefined();
    const parsed = snuggValuesSchema.parse({ healthSafety: { ambientCo: null, lead: "passed" } });
    expect(parsed.healthSafety).toEqual({ ambientCo: null, lead: "passed" });
  });

  test("rejects a fused enum token — the fuel axis must not collapse into equipment", () => {
    // The split-axis rule is declared HERE, on the values; the extraction schema
    // inherits it. Asserting it on both is what shows the derivation preserved it.
    expect(() => snuggValuesSchema.parse({ heatingEquipmentType: "oil_boiler" })).toThrow();
  });

  test("leaf types are still checked — a patch is optional, not untyped", () => {
    expect(() => snuggValuesSchema.parse({ heatingModelYear: "two thousand four" })).toThrow();
  });

  test("is strict — an unexpected top-level key is rejected", () => {
    expect(() => snuggValuesSchema.parse({ somethingElse: "x" })).toThrow();
  });

  test("is strict inside the health matrix too", () => {
    expect(() => snuggValuesSchema.parse({ healthSafety: { radon: "passed" } })).toThrow();
  });

  test("an ENVELOPE is not a legal patch value — the two shapes are genuinely different", () => {
    // The cross-check that keeps this block from being a second copy of the one
    // above: a full model response, which the extraction schema accepts, must not
    // parse as a patch. If it did, `schema` and `extractionSchema` would be
    // interchangeable and the split would be decoration.
    expect(snuggValuesSchema.safeParse(valid()).success).toBe(false);
    expect(snuggExtractionSchema.safeParse(validValues()).success).toBe(false);
  });
});
