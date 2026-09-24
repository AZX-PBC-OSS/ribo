import { describe, expect, test } from "vitest";
import { z } from "zod";

import { abstainedValue } from "./abstained-value.js";
import { enveloped } from "./enveloped.js";
import { extractedSchema } from "./provenance.js";
// Imported from the phases layer deliberately: the pin is that THIS helper's
// envelope literal equals `nullEnvelope()`'s without importing it (importing
// would invert the layering — see the helper's file header).
import { nullEnvelope } from "../phases/presence-phase.js";

/**
 * The helper's whole point is that its output parses against the very schema it
 * was derived from — so every granularity test asserts exactly that, against
 * the same schema instance the closing parse would use.
 */

const leafPatch = z
  .object({
    basedata: z.object({ yearBuilt: z.number().nullable().optional() }).strict().optional(),
  })
  .strict();

const rowPatch = z
  .object({
    rooms: z.array(z.object({ name: z.string().nullable().optional() }).strict()).optional(),
    report: z.object({ summary: z.string().nullable().optional() }).strict().optional(),
  })
  .strict();

const nonePatch = z
  .object({
    utilities: z.object({ account: z.string().nullable().optional() }).strict().optional(),
  })
  .strict();

const collectionPatch = z
  .object({
    widgets: z.array(z.object({ color: z.string().nullable().optional() }).strict()).optional(),
  })
  .strict();

const flatPatch = z
  .object({
    color: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
  })
  .strict();

describe("abstainedValue", () => {
  test("a leaf-granularity schema abstains to all-null envelopes, and parses against itself", () => {
    const schema = enveloped(leafPatch);
    const abstained = abstainedValue(schema) as {
      basedata: { yearBuilt: { value: unknown; confidence: unknown; sourceSpan: unknown } };
    };
    expect(schema.safeParse(abstained).success).toBe(true);
    expect(abstained.basedata.yearBuilt).toEqual(nullEnvelope());
  });

  test("a row-granularity schema abstains to plain nulls plus one null span per row", () => {
    const schema = enveloped(rowPatch, { provenance: { rooms: "row", report: "row" } });
    const abstained = abstainedValue(schema) as {
      rooms: unknown[];
      report: { summary: unknown; sourceSpan: unknown };
    };
    expect(schema.safeParse(abstained).success).toBe(true);
    // The collection abstains to an empty array; the singleton row's span leaf
    // is a plain null, not an envelope.
    expect(abstained.rooms).toEqual([]);
    expect(abstained.report).toEqual({ summary: null, sourceSpan: null });
  });

  test("a none-granularity schema abstains to plain nulls with no span anywhere", () => {
    const schema = enveloped(nonePatch, { provenance: { utilities: "none" } });
    const abstained = abstainedValue(schema) as { utilities: { account: unknown } };
    expect(schema.safeParse(abstained).success).toBe(true);
    expect(abstained.utilities).toEqual({ account: null });
  });

  test("a collection group abstains to an empty array — no fabricated instances", () => {
    const schema = enveloped(collectionPatch);
    const abstained = abstainedValue(schema) as { widgets: unknown[] };
    expect(schema.safeParse(abstained).success).toBe(true);
    expect(abstained.widgets).toEqual([]);
  });

  test('the flat ("") shape abstains to a top-level leaf map of envelopes', () => {
    const schema = enveloped(flatPatch);
    const abstained = abstainedValue(schema) as Record<string, unknown>;
    expect(schema.safeParse(abstained).success).toBe(true);
    expect(Object.keys(abstained).sort()).toEqual(["color", "size"]);
    expect(abstained.color).toEqual(nullEnvelope());
  });

  test("the envelope literal is nullEnvelope's exactly — pinned, not imported", () => {
    expect(abstainedValue(extractedSchema(z.string()))).toEqual(nullEnvelope());
  });

  test("a union throws naming the path", () => {
    expect(() =>
      abstainedValue(z.object({ x: z.union([z.string(), z.number()]) }).strict()),
    ).toThrow(/abstainedValue\(\).*"x"/);
    expect(() => abstainedValue(z.union([z.string(), z.number()]))).toThrow(/<root>/);
  });
});
