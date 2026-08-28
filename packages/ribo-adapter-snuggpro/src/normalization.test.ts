import { describe, expect, test } from "vitest";
import {
  clampConfidence,
  inchesToAtticDepthBand,
  normalizeFields,
  yearsToDhwAgeBand,
} from "./normalization.js";
import { snuggExamples } from "./examples.js";
import { AtticInsulationDepth, DhwAgeBand, snuggExtractionSchema } from "./schema.js";
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
      expect(() => AtticInsulationDepth.parse(inchesToAtticDepthBand(inches))).not.toThrow();
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
  // The adapter's own few-shot example, with out-of-range confidences poked into
  // three envelopes in three DIFFERENT resource groups. Derived from the fixture
  // rather than hand-written so it cannot drift from the schema's 51 leaves — and
  // spread across groups because a pass that only recursed one level deep, or that
  // special-cased one group by name, would still pass a single-group probe.
  //
  // ENVELOPED, because that is what `normalizeFields` runs on: it sits between the
  // model's response and review, and `confidence` — the only thing it touches — is
  // an envelope field that exists nowhere in the writable patch.
  const fixture = snuggExamples[0];
  if (!fixture) throw new Error("expected a Snugg Pro few-shot example fixture");

  const base = (): SnuggExtraction => {
    const fields = structuredClone(fixture.fields) as SnuggExtraction;
    fields.hvac.hvacSystemEquipmentType.confidence = 1.4;
    fields.dhw.dhwAge.confidence = -0.5;
    fields.health.healthDraftPressure.confidence = 2;
    return fields;
  };

  test("clamps confidence on envelopes in every resource group, at any depth", () => {
    const out = normalizeFields(base());
    expect(out.hvac.hvacSystemEquipmentType.confidence).toBe(1);
    expect(out.dhw.dhwAge.confidence).toBe(0);
    expect(out.health.healthDraftPressure.confidence).toBe(1);
  });

  test("clamps EVERY leaf, not just the ones this test names", () => {
    // The count guard. Three named assertions would also pass if the pass reached
    // exactly those three; this walks the result and insists no envelope anywhere
    // escaped the range, and that it saw all 51 of them.
    let seen = 0;
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      if ("confidence" in node) {
        const { confidence } = node as { confidence: number };
        seen += 1;
        expect(confidence).toBeGreaterThanOrEqual(0);
        expect(confidence).toBeLessThanOrEqual(1);
        return;
      }
      for (const child of Object.values(node)) walk(child);
    };
    walk(normalizeFields(base()));
    expect(seen).toBe(51);
  });

  test("leaves value and sourceSpan untouched — it never converts or invents", () => {
    const out = normalizeFields(base());
    expect(out.hvac.hvacSystemEquipmentType.value).toBe("Boiler");
    expect(out.hvac.hvacSystemEquipmentType.sourceSpan).toBe("it's an oil boiler");
    expect(out.attic.atticInsulationDepth.value).toBe("4-6");
    // The R-value field stays null: nothing converts a depth into one, or back.
    expect(out.attic.atticInsulation.value).toBeNull();
  });

  test("is pure — it returns a new object and does not mutate its input", () => {
    const input = base();
    const out = normalizeFields(input);
    expect(input.hvac.hvacSystemEquipmentType.confidence).toBe(1.4); // input unchanged
    expect(out).not.toBe(input);
    expect(out.hvac).not.toBe(input.hvac); // the groups are new objects too
  });

  test("output still satisfies the EXTRACTION schema", () => {
    // The extraction schema and not the patch: normalization runs inside the
    // extractor's trust boundary, so both its input and its output are the shape
    // the model emits. A patch-shaped assertion here would not even type-check,
    // which is the point — the pass has no values-shaped signature to have.
    expect(() => snuggExtractionSchema.parse(normalizeFields(base()))).not.toThrow();
  });

  // R1.6 Task 4 — `clampDeep` must preserve arrays. The current schema is still
  // singleton groups, so these inputs are cast to the extraction shape; the cast
  // is only to satisfy the type system — the pass is a structural walk and does
  // not validate against the schema.
  describe("array preservation (R1.6 Task 4)", () => {
    const makeArrayExtraction = (): SnuggExtraction =>
      ({
        hvac: [
          {
            hvacSystemEquipmentType: {
              value: "Boiler",
              confidence: 1.4,
              sourceSpan: "it's an oil boiler",
            },
            hvacHeatingEnergySource: { value: "Fuel Oil", confidence: -0.1, sourceSpan: "oil" },
          },
          {
            hvacSystemEquipmentType: {
              value: "Furnace",
              confidence: 2.0,
              sourceSpan: "upstairs furnace",
            },
          },
        ],
      }) as unknown as SnuggExtraction;

    test("an array survives as an array with element order intact", () => {
      const input = makeArrayExtraction();
      const inputHvac = (input as unknown as { hvac: unknown[] }).hvac;
      const out = normalizeFields(input) as unknown as {
        hvac: Array<{ hvacSystemEquipmentType: { value: string } }>;
      };
      expect(Array.isArray(out.hvac)).toBe(true);
      expect(out.hvac).toHaveLength(2);
      expect(out.hvac[0]!.hvacSystemEquipmentType.value).toBe("Boiler");
      expect(out.hvac[1]!.hvacSystemEquipmentType.value).toBe("Furnace");
      // The pass is pure: it returns a new array rather than mutating the input.
      expect(out.hvac).not.toBe(inputHvac);
    });

    test("confidence clamping reaches inside every array element", () => {
      const out = normalizeFields(makeArrayExtraction()) as unknown as {
        hvac: Array<{
          hvacSystemEquipmentType: { confidence: number };
          hvacHeatingEnergySource?: { confidence: number };
        }>;
      };
      expect(out.hvac[0]!.hvacSystemEquipmentType.confidence).toBe(1);
      expect(out.hvac[0]!.hvacHeatingEnergySource?.confidence).toBe(0);
      expect(out.hvac[1]!.hvacSystemEquipmentType.confidence).toBe(1);
    });

    test("an empty collection stays an empty array and gains no element", () => {
      const input = { hvac: [] } as unknown as SnuggExtraction;
      const inputHvac = (input as unknown as { hvac: unknown[] }).hvac;
      const out = normalizeFields(input) as unknown as { hvac: unknown[] };
      expect(Array.isArray(out.hvac)).toBe(true);
      expect(out.hvac).toHaveLength(0);
      // The broken Object.fromEntries(Object.entries(node)) rebuild turned an
      // empty array into `{}`, which is still an Object but no longer an array.
      expect(JSON.stringify(out.hvac)).toBe("[]");
      expect(out.hvac).not.toBe(inputHvac);
    });
  });
});
