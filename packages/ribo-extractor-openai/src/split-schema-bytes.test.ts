import { enveloped } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { MAX_NULLABLE_UNIONS_PER_CALL, splitExtractionSchema } from "./split-schema.js";

/**
 * @file The split packs against SERIALIZED SIZE as well as nullable unions.
 *
 * The union cap exists because one model family rejects a response schema carrying more than
 * 16 nullable unions. A different cap binds on a different route: the structured-output route
 * rejects a schema that serializes past its character ceiling — `schema must serialize to
 * <= 32768 characters and nest <= 12 levels` — and a schema with FEW unions and MANY bytes
 * sails through every union check straight into that 400. So the byte cap is a second,
 * independent packing limit, supplied per caller (the library does not know your route's
 * number — see the option's doc) — and a schema under the union cap but over a supplied byte
 * cap must still split into pieces that each fit.
 */

/** One enum leaf with long values: many serialized bytes, exactly one union after enveloping. */
const longEnumLeaf = (seed: number): z.ZodEnum =>
  z.enum([
    `option-alpha-${seed}-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    `option-bravo-${seed}-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
    `option-charlie-${seed}-cccccccccccccccccccccccccccccc`,
  ]);

/** A group of `count` enum leaves, before enveloping. */
const enumGroup = (count: number, seed = 0): z.ZodObject => {
  const shape: Record<string, z.ZodType> = {};
  for (let i = 0; i < count; i++) shape[`leaf${i}`] = longEnumLeaf(seed + i);
  return z.object(shape);
};

const serializedSize = (schema: z.ZodType): number =>
  JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12" })).length;

/** The union count of one piece's group object — enveloped leaves cost two unions each. */
const pieceUnions = (schema: z.ZodType, key: string): number => {
  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodType>;
  const value = shape[key]!;
  const candidate = value instanceof z.ZodArray ? (value.element as z.ZodType) : value;
  const count = (node: z.ZodType): number => {
    if (node instanceof z.ZodNullable || node instanceof z.ZodOptional)
      return 1 + count(node.unwrap() as z.ZodType);
    if (node instanceof z.ZodObject)
      return Object.values((node as z.ZodObject<z.ZodRawShape>).shape)
        .map((child) => count(child as z.ZodType))
        .reduce((a, b) => a + b, 0);
    return 0;
  };
  return count(candidate);
};

describe("splitExtractionSchema — the byte cap", () => {
  const patch = z
    .object({
      alpha: enumGroup(4).optional(),
      beta: enumGroup(4, 100).optional(),
    })
    .strict();
  const schema = enveloped(patch);

  test("a schema under the union cap but over the byte cap splits into pieces that each fit the byte cap", () => {
    // The whole schema is 8 enveloped leaves = 16 unions — under MAX. The byte cap
    // is what forces the split. Each emitted piece is measured under the cap.
    const byteCap = 900;
    const groups = splitExtractionSchema(schema, { maxSerializedCharsPerGroup: byteCap });

    expect(groups.length).toBeGreaterThan(2);
    for (const group of groups) {
      const size = serializedSize(group.schema);
      expect(
        size,
        `piece ${group.key}#${group.part ?? 0} serialized to ${size} characters`,
      ).toBeLessThanOrEqual(byteCap);
      // And the union cap did not have to bind: every piece is under it too.
      expect(pieceUnions(group.schema, group.key)).toBeLessThanOrEqual(
        MAX_NULLABLE_UNIONS_PER_CALL,
      );
    }
  });

  test("a caller-supplied byte cap smaller than the default packing produces more pieces", () => {
    const generous = splitExtractionSchema(schema, { maxSerializedCharsPerGroup: 4_000 });
    const tight = splitExtractionSchema(schema, { maxSerializedCharsPerGroup: 900 });
    expect(tight.length).toBeGreaterThan(generous.length);
  });

  test("a caller-supplied union cap through the options bag behaves as the positional number", () => {
    const positional = splitExtractionSchema(schema, 3);
    const bagged = splitExtractionSchema(schema, { maxNullableUnionsPerGroup: 3 });
    expect(bagged.map((g) => [g.key, g.part, g.parts])).toEqual(
      positional.map((g) => [g.key, g.part, g.parts]),
    );
    // And the positional form still works at all — the existing callers' shape.
    expect(positional.length).toBeGreaterThan(2);
  });

  test("without a byte cap the split is unchanged: one entry per group under the union cap", () => {
    const groups = splitExtractionSchema(schema);
    expect(groups.map((g) => g.key)).toEqual(["alpha", "beta"]);
    expect(groups.every((g) => g.part === undefined)).toBe(true);
  });

  test("a group the byte cap does not split carries no part/parts — the same shape the union path emits", () => {
    // A generous byte cap leaves every group whole; the entries must be
    // indistinguishable from the union-only path's, because names and examples
    // downstream key off `part`.
    const groups = splitExtractionSchema(schema, { maxSerializedCharsPerGroup: 100_000 });
    expect(groups.map((g) => [g.key, g.part, g.parts])).toEqual([
      ["alpha", undefined, undefined],
      ["beta", undefined, undefined],
    ]);
  });
});

describe("splitExtractionSchema — a leaf that cannot fit any piece", () => {
  test("a single property over the supplied byte cap throws at construction, naming the group, the size, the cap and the option", () => {
    // One enum leaf whose serialized size exceeds the cap — no partition can fit it.
    const fat = enveloped(z.object({ huge: enumGroup(1, 900) }).strict());
    const byteCap = 100;
    const split = (): unknown =>
      splitExtractionSchema(fat, { maxSerializedCharsPerGroup: byteCap });
    expect(split).toThrow(Error);
    expect(split).toThrow(/huge/);
    expect(split).toThrow(new RegExp(String(byteCap)));
    expect(split).toThrow(/maxSerializedCharsPerGroup/);
  });

  test("a single property over the supplied union cap throws the same way", () => {
    // 17 unions inside ONE property (a nested group): no piece under a 16-union cap holds it.
    const nested = enveloped(
      z
        .object({
          mega: z
            .object({
              a: enumGroup(9),
              b: enumGroup(9, 500),
            })
            .strict()
            .optional(),
        })
        .strict(),
    );
    const split = (): unknown => splitExtractionSchema(nested, { maxNullableUnionsPerGroup: 16 });
    expect(split).toThrow(Error);
    expect(split).toThrow(/mega/);
    expect(split).toThrow(/maxNullableUnionsPerGroup/);
  });
});
