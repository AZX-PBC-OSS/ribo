import { expect, test } from "vitest";
import { snuggExamples } from "./examples.js";
import { SnuggFieldsSchema } from "./schema.js";

// A known-valid, fully-populated field set (all 24 top-level keys + the 11-test
// health matrix), reused as the base for the mutation tests below.
const fixture = snuggExamples[0];
if (!fixture) throw new Error("expected a Snugg Pro few-shot example fixture");
const valid = () => structuredClone(fixture.fields);

test("parses a fully-populated, valid field set", () => {
  expect(() => SnuggFieldsSchema.parse(valid())).not.toThrow();
});

test("confidence is unconstrained — a bare z.number() accepts out-of-range values", () => {
  // The whole reason confidence is not `.min(0).max(1)`: strict structured-output
  // mode rejects the `minimum`/`maximum` keywords those emit. Range-clamping is
  // normalization's job, so the schema itself must accept 1.5.
  const fields = valid();
  fields.heatingEquipmentType.confidence = 1.5;
  expect(() => SnuggFieldsSchema.parse(fields)).not.toThrow();
});

test("rejects a fused enum token — the fuel axis must not collapse into equipment", () => {
  const fields = valid();
  // "oil_boiler" is exactly the fused member the split-axis design forbids.
  (fields.heatingEquipmentType as { value: unknown }).value = "oil_boiler";
  expect(() => SnuggFieldsSchema.parse(fields)).toThrow();
});

test("is strict — an unexpected top-level key is rejected", () => {
  const fields = valid() as Record<string, unknown>;
  fields.somethingElse = { value: null, confidence: 1, sourceSpan: null };
  expect(() => SnuggFieldsSchema.parse(fields)).toThrow();
});

test("is strict inside the health matrix too", () => {
  const fields = valid();
  (fields.healthSafety as Record<string, unknown>).radon = {
    value: "passed",
    confidence: 1,
    sourceSpan: null,
  };
  expect(() => SnuggFieldsSchema.parse(fields)).toThrow();
});

test("every field is required — an omitted key is not allowed (null is how absence is said)", () => {
  const fields = valid() as Record<string, unknown>;
  delete fields.combustionVentType;
  expect(() => SnuggFieldsSchema.parse(fields)).toThrow();
});

test("a null value may still carry a non-null sourceSpan", () => {
  // The example's blower-door field is exactly this: deferred, so value is null
  // but a grounding span records that it was addressed.
  const parsed = SnuggFieldsSchema.parse(valid());
  expect(parsed.blowerDoorCfm50.value).toBeNull();
  expect(parsed.blowerDoorCfm50.sourceSpan).not.toBeNull();
});

test("a leaf envelope must carry all three keys", () => {
  const fields = valid() as Record<string, unknown>;
  fields.heatingFuel = { value: "fuel_oil", sourceSpan: "oil boiler" }; // missing confidence
  expect(() => SnuggFieldsSchema.parse(fields)).toThrow();
});
