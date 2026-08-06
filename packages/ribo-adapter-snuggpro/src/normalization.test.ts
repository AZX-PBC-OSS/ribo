import { describe, expect, test } from "vitest";
import {
  clampConfidence,
  inchesToAtticDepthBand,
  normalizeFields,
  yearsToDhwAgeBand,
} from "./normalization.js";
import { AtticInsulationDepthBand, DhwAgeBand, snuggExtractionSchema } from "./schema.js";
import type { SnuggExtraction } from "./schema.js";

describe("clampConfidence", () => {
  test("passes an in-range value through unchanged", () => {
    expect(clampConfidence(0)).toBe(0);
    expect(clampConfidence(0.42)).toBe(0.42);
    expect(clampConfidence(1)).toBe(1);
  });

  test("clamps out-of-range values into 0..1 (strict mode can't bound the schema)", () => {
    expect(clampConfidence(1.4)).toBe(1);
    expect(clampConfidence(-0.1)).toBe(0);
    expect(clampConfidence(1000)).toBe(1);
  });

  test("collapses a non-finite confidence to 0, never a high one", () => {
    expect(clampConfidence(Number.NaN)).toBe(0);
    expect(clampConfidence(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampConfidence(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("inchesToAtticDepthBand", () => {
  test("maps a stated depth to the band that contains it", () => {
    expect(inchesToAtticDepthBand(0)).toBe("0");
    expect(inchesToAtticDepthBand(2)).toBe("1-3");
    expect(inchesToAtticDepthBand(6)).toBe("4-6"); // normalization.md worked example
    expect(inchesToAtticDepthBand(8)).toBe("7-9");
    expect(inchesToAtticDepthBand(12)).toBe("10-12"); // "ten, twelve inches" -> 10-12
    expect(inchesToAtticDepthBand(14)).toBe("13-15");
    expect(inchesToAtticDepthBand(20)).toBe("16+");
  });

  test("applies one audited upper-inclusive boundary rule", () => {
    expect(inchesToAtticDepthBand(3)).toBe("1-3");
    expect(inchesToAtticDepthBand(4)).toBe("4-6");
    expect(inchesToAtticDepthBand(15)).toBe("13-15");
    expect(inchesToAtticDepthBand(16)).toBe("16+");
    // A fractional depth resolves deterministically, never ambiguously.
    expect(inchesToAtticDepthBand(3.5)).toBe("4-6");
    // Any positive depth is at least 1-3; only a true zero is "0".
    expect(inchesToAtticDepthBand(0.5)).toBe("1-3");
  });

  test("rejects nonsensical depths rather than silently bucketing them", () => {
    expect(() => inchesToAtticDepthBand(-1)).toThrow(RangeError);
    expect(() => inchesToAtticDepthBand(Number.NaN)).toThrow(RangeError);
    expect(() => inchesToAtticDepthBand(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  test("every returned band is a real schema member", () => {
    for (const inches of [0, 2, 6, 8, 12, 14, 20]) {
      expect(() => AtticInsulationDepthBand.parse(inchesToAtticDepthBand(inches))).not.toThrow();
    }
  });
});

describe("yearsToDhwAgeBand", () => {
  test("maps a stated age to the band that contains it", () => {
    expect(yearsToDhwAgeBand(0)).toBe("0-5");
    expect(yearsToDhwAgeBand(8)).toBe("6-10"); // "about eight years" -> 6-10
    expect(yearsToDhwAgeBand(12)).toBe("11-15"); // "about twelve years" -> 11-15
    expect(yearsToDhwAgeBand(18)).toBe("16-20");
    expect(yearsToDhwAgeBand(23)).toBe("21-25");
    expect(yearsToDhwAgeBand(28)).toBe("26-30");
    expect(yearsToDhwAgeBand(33)).toBe("31-35");
    expect(yearsToDhwAgeBand(40)).toBe("36+");
  });

  test("resolves the boundary case normalization.md flags: exactly 15 -> 11-15", () => {
    expect(yearsToDhwAgeBand(15)).toBe("11-15");
    expect(yearsToDhwAgeBand(16)).toBe("16-20");
  });

  test("rejects nonsensical ages", () => {
    expect(() => yearsToDhwAgeBand(-2)).toThrow(RangeError);
    expect(() => yearsToDhwAgeBand(Number.NaN)).toThrow(RangeError);
  });

  test("every returned band is a real schema member", () => {
    for (const years of [0, 8, 12, 18, 23, 28, 33, 40]) {
      expect(() => DhwAgeBand.parse(yearsToDhwAgeBand(years))).not.toThrow();
    }
  });
});

describe("normalizeFields", () => {
  // A minimal, all-null field set with a couple of out-of-range confidences.
  // ENVELOPED, because that is what `normalizeFields` runs on: it sits between the
  // model's response and review, and `confidence` — the only thing it touches —
  // is an envelope field that exists nowhere in the writable patch.
  const envelope = (confidence: number) => ({ value: null, confidence, sourceSpan: null });
  const base = (): SnuggExtraction =>
    ({
      heatingEquipmentType: { value: "boiler", confidence: 1.4, sourceSpan: "oil boiler" },
      heatingFuel: { value: "fuel_oil", confidence: -0.5, sourceSpan: "oil boiler" },
      heatingManufacturer: envelope(1),
      heatingModelNumber: envelope(1),
      heatingModelYear: envelope(1),
      heatingOutputCapacityBtuh: envelope(1),
      coolingEquipmentType: envelope(1),
      ductLocation: envelope(1),
      ductSealing: envelope(1),
      ductInsulation: envelope(1),
      ductLeakageCfm25: envelope(1),
      atticInsulationDepthIn: envelope(1),
      atticInsulationType: envelope(1),
      atticInsulationSpokenRValue: envelope(1),
      wallInsulated: envelope(1),
      wallConstruction: envelope(1),
      blowerDoorCfm50: envelope(1),
      windowGlazing: envelope(1),
      windowFrame: envelope(1),
      dhwFuel: envelope(1),
      dhwSystemType: envelope(1),
      dhwAgeBand: envelope(1),
      combustionVentType: envelope(1),
      healthSafety: {
        ambientCo: { value: "passed", confidence: 2, sourceSpan: "CO clean" },
        venting: envelope(1),
        naturalConditionSpillage: envelope(1),
        worstCaseDepressurization: envelope(1),
        worstCaseSpillage: envelope(1),
        draftPressure: envelope(1),
        gasLeak: envelope(1),
        moldMoisture: envelope(1),
        asbestos: envelope(1),
        lead: envelope(1),
        electrical: envelope(1),
      },
    }) as SnuggExtraction;

  test("clamps confidence on top-level and nested health-matrix envelopes", () => {
    const out = normalizeFields(base());
    expect(out.heatingEquipmentType.confidence).toBe(1);
    expect(out.heatingFuel.confidence).toBe(0);
    expect(out.healthSafety.ambientCo.confidence).toBe(1);
  });

  test("leaves value and sourceSpan untouched — it never converts or invents", () => {
    const out = normalizeFields(base());
    expect(out.heatingEquipmentType.value).toBe("boiler");
    expect(out.heatingEquipmentType.sourceSpan).toBe("oil boiler");
    expect(out.healthSafety.ambientCo.value).toBe("passed");
  });

  test("is pure — it returns a new object and does not mutate its input", () => {
    const input = base();
    const out = normalizeFields(input);
    expect(input.heatingEquipmentType.confidence).toBe(1.4); // input unchanged
    expect(out).not.toBe(input);
  });

  test("output still satisfies the EXTRACTION schema", () => {
    // The extraction schema and not the patch: normalization runs inside the
    // extractor's trust boundary, so both its input and its output are the shape
    // the model emits. A patch-shaped assertion here would not even type-check,
    // which is the point — the pass has no values-shaped signature to have.
    expect(() => snuggExtractionSchema.parse(normalizeFields(base()))).not.toThrow();
  });
});
