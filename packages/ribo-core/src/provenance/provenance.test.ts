import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  extractedSchema,
  isExtractedSchema,
  isSpanGrounded,
  spanGroundedness,
} from "./provenance.js";

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

describe("spanGroundedness", () => {
  const laidOut = "Item            Amount\nBlower door     $       5,250.00\n";

  test("a verbatim quote is grounded", () => {
    expect(spanGroundedness("$       5,250.00", laidOut)).toBe("grounded");
  });

  test("a column-padded quote the model collapsed is a near miss, not a fabrication", () => {
    // `layoutPageText` pads columns to align them, so the transcript holds runs of spaces a
    // model reasonably reports as one. The value IS in the document; reporting this as
    // ungrounded sends a reviewer hunting for a hallucination that never happened.
    expect(spanGroundedness("$ 5,250.00", laidOut)).toBe("near-miss");
  });

  test("case and curly quotes are near misses too", () => {
    expect(spanGroundedness("BLOWER DOOR", laidOut)).toBe("near-miss");
    expect(spanGroundedness("‘quoted’", "the 'quoted' word")).toBe("near-miss");
  });

  test("HTML-entity escaping is a near miss, not ungrounded or grounded", () => {
    // Document OCR markdown carries escaped entities (`&amp;`) that the verbatim
    // tier correctly rejects, but they are still present in the transcript — not
    // fabrication. Decoding happens in the near-miss tier only.
    expect(spanGroundedness("attic & R-19", "attic &amp; R-19")).toBe("near-miss");
    expect(spanGroundedness("5 &lt; 10", "5 < 10")).toBe("near-miss");
    expect(spanGroundedness("it&apos;s done", "it's done")).toBe("near-miss");
    expect(spanGroundedness("&#39;quoted&#39;", "'quoted'")).toBe("near-miss");
    expect(spanGroundedness("&#x2018;quoted&#x2019;", "'quoted'")).toBe("near-miss");
    // A numeric entity for a LETTER only matches if decoding runs before the lowercase pass —
    // decode afterwards and `&#65;` stays `A` against a lowercased `a`.
    expect(spanGroundedness("&#65;ttic", "attic")).toBe("near-miss");
    expect(spanGroundedness("&#x41;TTIC", "attic")).toBe("near-miss");
    // The verbatim tier stays strict: only an exact substring is grounded.
    expect(isSpanGrounded("attic & R-19", "attic &amp; R-19")).toBe(false);
  });

  test("text that is not in the document at all is ungrounded", () => {
    expect(spanGroundedness("$ 9,999.00", laidOut)).toBe("ungrounded");
  });

  test("a null or empty span is ungrounded, never near", () => {
    // Every string contains "", so a normalized `.includes` would call an empty span a near
    // miss of everything — the same vacuity `isSpanGrounded` guards against.
    expect(spanGroundedness(null, laidOut)).toBe("ungrounded");
    expect(spanGroundedness("", laidOut)).toBe("ungrounded");
    expect(spanGroundedness("   ", laidOut)).toBe("ungrounded");
  });

  test("isSpanGrounded stays exactly the verbatim tier", () => {
    // The boolean is unchanged and still means "verbatim": every existing caller keeps its
    // meaning, and a near miss is a THIRD state a caller opts into, not a loosening of this one.
    expect(isSpanGrounded("$ 5,250.00", laidOut)).toBe(false);
    expect(isSpanGrounded("$       5,250.00", laidOut)).toBe(true);
  });
});

describe("isExtractedSchema", () => {
  test("recognises what extractedSchema builds, whatever the leaf type", () => {
    expect(isExtractedSchema(extractedSchema(z.number()))).toBe(true);
    expect(isExtractedSchema(extractedSchema(z.enum(["a", "b"])))).toBe(true);
  });

  test("rejects a group of envelopes — the shape the split has to tell it apart from", () => {
    expect(isExtractedSchema(z.strictObject({ rValue: extractedSchema(z.number()) }))).toBe(false);
  });

  test("rejects a plain-leaf row, which carries a sourceSpan but no value/confidence pair", () => {
    const row = z.strictObject({
      name: z.string().nullable(),
      sourceSpan: z.string().nullable(),
    });
    expect(isExtractedSchema(row)).toBe(false);
  });

  test("rejects an object carrying the three key names with the wrong shapes", () => {
    const impostor = z.strictObject({
      value: z.string(),
      confidence: z.string(),
      sourceSpan: z.string().nullable(),
    });
    expect(isExtractedSchema(impostor)).toBe(false);
  });
});
