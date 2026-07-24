import { describe, expect, test } from "vitest";
import { z } from "zod";

import { extractedSchema, isSpanGrounded } from "./provenance.js";

const atticRValue = extractedSchema(z.number());

describe("extractedSchema", () => {
  test("parses a well-formed envelope", () => {
    const parsed = atticRValue.parse({
      value: 19,
      confidence: 0.98,
      sourceSpan: "attic is R-19",
    });

    expect(parsed).toEqual({ value: 19, confidence: 0.98, sourceSpan: "attic is R-19" });
  });

  test("accepts value: null — absence is a legitimate answer, not an error", () => {
    const parsed = atticRValue.parse({
      value: null,
      confidence: 1,
      sourceSpan: null,
    });

    expect(parsed.value).toBeNull();
  });

  test("rejects a MISSING value key — nullable but required (the anti-hallucination rule)", () => {
    const result = atticRValue.safeParse({
      confidence: 1,
      sourceSpan: null,
    });

    expect(result.success).toBe(false);
  });

  test("rejects a missing confidence key", () => {
    expect(atticRValue.safeParse({ value: 19, sourceSpan: null }).success).toBe(false);
  });

  test("rejects a missing sourceSpan key", () => {
    expect(atticRValue.safeParse({ value: 19, confidence: 1 }).success).toBe(false);
  });

  test("accepts sourceSpan: null alongside a non-null value", () => {
    const parsed = atticRValue.parse({ value: 19, confidence: 0.9, sourceSpan: null });

    expect(parsed.sourceSpan).toBeNull();
  });

  test("wraps any inner zod type, not just numbers", () => {
    const fuelType = extractedSchema(z.enum(["gas", "oil", "electric"]));

    expect(fuelType.parse({ value: "oil", confidence: 1, sourceSpan: "oil boiler" }).value).toBe(
      "oil",
    );
    expect(fuelType.safeParse({ value: "wood", confidence: 1, sourceSpan: null }).success).toBe(
      false,
    );
  });

  test("still rejects a wrong-typed value", () => {
    expect(
      atticRValue.safeParse({ value: "nineteen", confidence: 1, sourceSpan: null }).success,
    ).toBe(false);
  });
});

describe("isSpanGrounded", () => {
  const transcript = "Attic is R-19 fiberglass batts, pretty compressed over the kneewall.";

  test("is true for a verbatim substring", () => {
    expect(isSpanGrounded("R-19 fiberglass batts", transcript)).toBe(true);
  });

  test("is false for a fabricated span", () => {
    expect(isSpanGrounded("R-38 blown cellulose", transcript)).toBe(false);
  });

  test("is false for a null span", () => {
    expect(isSpanGrounded(null, transcript)).toBe(false);
  });

  test("is true when only trailing whitespace differs — spans arrive trimmed", () => {
    expect(isSpanGrounded("R-19 fiberglass batts   ", transcript)).toBe(true);
    expect(isSpanGrounded("over the kneewall.\n", transcript)).toBe(true);
  });

  test("is false for an empty or whitespace-only span", () => {
    expect(isSpanGrounded("", transcript)).toBe(false);
    expect(isSpanGrounded("   ", transcript)).toBe(false);
  });

  test("is case sensitive — verbatim means verbatim", () => {
    expect(isSpanGrounded("attic is r-19", transcript)).toBe(false);
  });
});
