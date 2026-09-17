import { z } from "zod";
import { describe, expect, test } from "vitest";

import { assertLeafGranularity } from "./assert-leaf-granularity.js";
import { enveloped } from "./enveloped.js";

/**
 * Tests for the construction-time `"leaf"`-granularity guard. Every fixture is
 * built with `enveloped()` — the point is to test what the library really
 * produces rather than what someone believes it produces — and the array shapes
 * are named separately, because they diverge exactly on the bug a one-level
 * implementation commits: `enveloped()` derives an array of PRIMITIVES to an
 * array of envelopes, so after unwrapping the array the check is holding an
 * envelope, not an object of envelopes.
 */

const flatGroupsPatch = z
  .object({
    roof: z.enum(["asphalt_shingle", "metal", "tile"]).nullable().optional(),
    wall: z.string().nullable().optional(),
  })
  .strict();

/** The `hvac` shape: a collection group whose instances are objects of leaves. */
const hvacPatch = z
  .object({
    hvac: z
      .array(
        z
          .object({
            systemType: z.enum(["furnace", "boiler", "heat_pump"]).nullable().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

/** An array of PRIMITIVES — the fixture a one-level implementation gets wrong. */
const tagsPatch = z.object({ tags: z.array(z.string()).optional() }).strict();

const nestedPatch = z
  .object({
    basedata: z
      .object({
        yearBuilt: z.number().nullable().optional(),
        floorArea: z.number().nullable().optional(),
      })
      .strict(),
  })
  .strict();

const bareLeafPatch = z.object({ notes: z.string().optional() }).strict();

describe("assertLeafGranularity — schemas it accepts", () => {
  test("an all-leaf schema of flat groups", () => {
    expect(() =>
      assertLeafGranularity(enveloped(flatGroupsPatch), { combinator: "consensusExtractor" }),
    ).not.toThrow();
  });

  test("a collection group derived from an array of objects — the hvac shape", () => {
    expect(() =>
      assertLeafGranularity(enveloped(hvacPatch), { combinator: "consensusExtractor" }),
    ).not.toThrow();
  });

  test("a group derived from an array of primitives — enveloped() turns it into an array of envelopes", () => {
    // The pin against the one-level implementation: `enveloped()` derives
    // `z.array(z.string())` to `z.array(extractedSchema(z.string()))`, so after
    // unwrapping the array the check is holding an ENVELOPE — whose own
    // properties (`value`, `confidence`, `sourceSpan`) are not envelopes. A
    // one-level "unwrap the array, then check the object's properties" version
    // rejects this legitimate `"leaf"` group — and then misreports it as `"row"`,
    // because the envelope carries a `sourceSpan` key.
    expect(() =>
      assertLeafGranularity(enveloped(tagsPatch), { combinator: "consensusExtractor" }),
    ).not.toThrow();
  });

  test("a group containing a nested object of envelopes — the check recurses rather than rejecting", () => {
    expect(() =>
      assertLeafGranularity(enveloped(nestedPatch), { combinator: "consensusExtractor" }),
    ).not.toThrow();
  });

  test("a top-level bare leaf", () => {
    expect(() =>
      assertLeafGranularity(enveloped(bareLeafPatch), { combinator: "validateExtractor" }),
    ).not.toThrow();
  });
});

describe("assertLeafGranularity — the refusals", () => {
  /** A collection group — the wide-table shape row provenance exists for. */
  const roomsPatch = z
    .object({
      rooms: z
        .array(
          z
            .object({
              name: z.string().nullable().optional(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict();

  /** A flat group: the group object itself is the row unit. */
  const flatRowPatch = z
    .object({
      wall: z.object({ material: z.string().nullable().optional() }).strict(),
    })
    .strict();

  const catchRefusal = (schema: z.ZodType, combinator: string): Error => {
    try {
      assertLeafGranularity(schema, { combinator });
    } catch (caught) {
      return caught as Error;
    }
    throw new Error("expected assertLeafGranularity to throw");
  };

  test("a row group throws, naming the combinator, the group, and the granularity", () => {
    const error = catchRefusal(
      enveloped(roomsPatch, { provenance: { rooms: "row" } }),
      "consensusExtractor",
    );
    expect(error.message).toContain("consensusExtractor");
    expect(error.message).toContain('"rooms"');
    expect(error.message).toContain('"row"');
    expect(error.message).toMatch(/per-leaf provenance envelope/);
  });

  test("a flat row group — the group object is the row unit — throws the same way", () => {
    const error = catchRefusal(
      enveloped(flatRowPatch, { provenance: { wall: "row" } }),
      "validateExtractor",
    );
    expect(error.message).toContain("validateExtractor");
    expect(error.message).toContain('"wall"');
    expect(error.message).toContain('"row"');
  });

  test("a none group throws, naming it and the granularity", () => {
    const error = catchRefusal(
      enveloped(roomsPatch, { provenance: { rooms: "none" } }),
      "consensusExtractor",
    );
    expect(error.message).toContain('"rooms"');
    expect(error.message).toContain('"none"');
    expect(error.message).not.toContain('"row"');
  });

  test("a schema mixing a leaf group with a row group names only the offending one", () => {
    const mixedPatch = z
      .object({
        roof: z.enum(["asphalt_shingle", "metal", "tile"]).nullable().optional(),
        rooms: roomsPatch.shape.rooms,
      })
      .strict();
    const error = catchRefusal(
      enveloped(mixedPatch, { provenance: { rooms: "row" } }),
      "consensusExtractor",
    );
    expect(error.message).toContain('"rooms"');
    expect(error.message).not.toContain("roof");
  });

  test("a row group containing a nested object is reported as row, not none", () => {
    // The pin that discrimination runs on the ROW UNIT rather than wherever the
    // recursion happened to stop: the nested object gets plain leaves and NO
    // `sourceSpan` key of its own, so a guard that discriminated at the
    // recursion's failure point would call this subtree `"none"` when the group
    // is `"row"`.
    const nestedRowPatch = z
      .object({
        rooms: z
          .array(
            z
              .object({
                name: z.string().nullable().optional(),
                dimensions: z.object({ width: z.number().nullable().optional() }).strict(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict();
    const error = catchRefusal(
      enveloped(nestedRowPatch, { provenance: { rooms: "row" } }),
      "consensusExtractor",
    );
    expect(error.message).toContain('"rooms"');
    expect(error.message).toContain('"row"');
    expect(error.message).not.toContain('"none"');
  });
});
