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

/**
 * @file The split partitions a FLAT (non-grouped) extraction schema over its byte cap.
 *
 * A flat schema — one whose top-level properties are leaves rather than nested groups — used
 * to fall back to a single entry covering the whole input under every cap, because the
 * grouped packer never ran on the non-grouped path. The bug: a flat schema over the
 * provider's byte cap produced one oversized piece and the request was rejected at the
 * route. Read how the grouped path calls {@link partitionGroupTwoCaps}: the same pattern
 * applies, with one structural difference — flat pieces have no wrapping object; each
 * piece is `z.strictObject({ leafA, leafB, … })`, pieces share `key === ""`, and the merge
 * accumulates them by `Object.assign`.
 */

// --- Fixtures for the flat path ----------------------------------------------

/**
 * A flat (non-grouped) extraction schema: top-level properties are leaf envelopes, not
 * nested groups. `enveloped()` wraps each leaf in `{ value, confidence, sourceSpan }`, so
 * the extraction schema's top-level properties ARE leaf envelopes — the case the flat
 * fallback serves.
 */
const flatEnumPatch = (count: number, seed = 0): z.ZodObject => {
  const shape: Record<string, z.ZodType> = {};
  for (let i = 0; i < count; i++) shape[`leaf${i}`] = longEnumLeaf(seed + i);
  return z.object(shape).strict();
};

describe("splitExtractionSchema — the byte cap on a flat schema", () => {
  test("a flat schema over the byte cap partitions; every piece is under the cap", () => {
    // 32 long enum leaves envelope to 32 envelopes. The whole extraction schema's JSON
    // Schema rendering is well over the byte cap on its own; the packer must split it.
    // The discriminator is the SERIALIZED SIZE of each produced piece, not the count —
    // a count assertion would pass against any implementation and miss the bug.
    const schema = enveloped(flatEnumPatch(32));
    const byteCap = 4_000;
    const groups = splitExtractionSchema(schema, { maxSerializedCharsPerGroup: byteCap });

    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      const size = serializedSize(group.schema);
      expect(
        size,
        `piece key "${group.key}" part ${group.part ?? 0} = ${size} chars`,
      ).toBeLessThanOrEqual(byteCap);
    }
    // The pieces' `part`/`parts` and shared `key === ""` are how a downstream consumer
    // recombines them — pin that they line up.
    expect(groups.every((g) => g.key === "")).toBe(true);
    expect(groups[0]!.parts).toBe(groups.length);
    expect(groups.map((g) => g.part)).toEqual(groups.map((_, i) => i));
  });

  test("a flat schema under the byte cap is unchanged — one entry, the whole schema", () => {
    // The whole flat schema's serialized form fits the cap well within the limit, so
    // the packer must NOT split it. The fallback's existing single-entry shape — the
    // whole extraction schema, not a narrowed slice — is preserved.
    const schema = enveloped(flatEnumPatch(8));
    const generous = splitExtractionSchema(schema, { maxSerializedCharsPerGroup: 100_000 });

    expect(generous).toHaveLength(1);
    expect(generous[0]!.key).toBe("");
    expect(generous[0]!.part).toBeUndefined();
    expect(generous[0]!.schema).toBe(schema);
  });

  test("without any caps, a flat schema is unchanged — byte-cap default-off, ADR 0015", () => {
    // Default-off means absent, not zero; the fallback must keep its byte-identical
    // single-entry shape so request regressions stay green (this package's `per-group.test.ts`
    // suite pins the byte identity of the flat fallback's request at construction).
    const schema = enveloped(flatEnumPatch(32));
    const groups = splitExtractionSchema(schema);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("");
    expect(groups[0]!.schema).toBe(schema);
  });

  test("the grouped path is untouched — a grouped schema over the byte cap still partitions into pieces that each fit the cap", () => {
    // Regression for the grouped byte-cap path added in an earlier wave: the grouped
    // extractor still produces as many pieces under the same cap as before.
    const patch = z
      .object({
        alpha: enumGroup(4).optional(),
        beta: enumGroup(4, 100).optional(),
      })
      .strict();
    const schema = enveloped(patch);
    const byteCap = 900;
    const groups = splitExtractionSchema(schema, { maxSerializedCharsPerGroup: byteCap });
    for (const group of groups) {
      expect(serializedSize(group.schema)).toBeLessThanOrEqual(byteCap);
    }
    expect(groups.length).toBeGreaterThan(2);
  });

  test("a flat schema with a single overweight leaf throws ADR 0013's refusal — naming the leaf, the size, the cap and the option", () => {
    // One enum leaf whose serialized size exceeds the cap — no piece can fit it. The
    // refusal must name the leaf, the measured size, the cap and the option, matching
    // the grouped-leaf refusal in this same describe (ADR 0013).
    const schema = enveloped(z.object({ huge: longEnumLeaf(900) }).strict());
    const byteCap = 200;
    const split = (): unknown =>
      splitExtractionSchema(schema, { maxSerializedCharsPerGroup: byteCap });
    expect(split).toThrow(Error);
    expect(split).toThrow(/huge/);
    expect(split).toThrow(new RegExp(String(byteCap)));
    expect(split).toThrow(/maxSerializedCharsPerGroup/);
  });
});
