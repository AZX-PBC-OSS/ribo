import { describe, expect, test } from "vitest";
import { z } from "zod";

import { MAX_ENVELOPED_LEAVES_PER_GROUP, splitExtractionSchema } from "@azx/ribo-extractor-openai";
import type { ExtractionGroup } from "@azx/ribo-extractor-openai";

import {
  SCHEMA_NESTING_DEPTH_CAP,
  SCHEMA_SERIALIZED_CHAR_CAP,
  snuggExtractionSchema,
} from "./schema.js";

/**
 * Guard the platform-route caps — R3 Task 5.
 *
 * The structured-output route rejects a schema that is too big or too deep with an HTTP
 * 400 naming both limits (`schema must serialize to <= 32768 characters and nest <= 12
 * levels`) — a production failure on a real recording in the field; this test turns it
 * into a failing build instead. The full `snuggExtractionSchema` with vendor
 * descriptions is over the character cap — the whole reason R3 splits the call per
 * top-level group — and one call per GROUP is over too (`basedata` alone exceeds it):
 * the unit that fits, and the unit `perGroupExtractor` actually sends, is the
 * partitioned piece, so the cap assertions below run against those.
 *
 * Both limits named in the vendor's error are asserted here, against the vendor's own
 * numbers. Sizes are NOT pinned to exact byte counts: a test asserting an exact size
 * fails on every innocuous wording change and teaches people to bump the number without
 * thinking. The property that matters is: under the cap.
 */

/**
 * Walk a JSON Schema node and return the maximum nesting depth, counting one level per
 * `properties` descent — the same counting method `extraction-shape.test.ts` uses, so
 * the two tests agree on what a "level" is.
 */
function maxNestingDepth(node: unknown, depth: number): number {
  let deepest = depth;
  if (Array.isArray(node)) {
    for (const child of node) deepest = Math.max(deepest, maxNestingDepth(child, depth));
    return deepest;
  }
  if (node === null || typeof node !== "object") return deepest;
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    deepest = Math.max(deepest, maxNestingDepth(child, key === "properties" ? depth + 1 : depth));
  }
  return deepest;
}

test("every per-call schema serializes under the character cap", () => {
  // Partitioned, because that is the shape of a real call: `perGroupExtractor` always
  // splits at MAX_ENVELOPED_LEAVES_PER_GROUP, and an unpartitioned `basedata` is a
  // schema no call ever carries.
  const groups = splitExtractionSchema(snuggExtractionSchema, MAX_ENVELOPED_LEAVES_PER_GROUP);
  expect(groups.length).toBeGreaterThan(1);

  for (const group of groups) {
    const jsonSchema = z.toJSONSchema(group.schema, { target: "draft-2020-12" });
    const serialized = JSON.stringify(jsonSchema);
    // Under the cap, not equal to it: a group exactly AT the cap is one wording change
    // away from breaking.
    expect(
      serialized.length,
      `group "${group.key}" serialized schema is ${serialized.length} characters`,
    ).toBeLessThan(SCHEMA_SERIALIZED_CHAR_CAP);
  }
});

test("every per-call schema nests within the depth cap", () => {
  const groups = splitExtractionSchema(snuggExtractionSchema, MAX_ENVELOPED_LEAVES_PER_GROUP);
  expect(groups.length).toBeGreaterThan(1);

  for (const group of groups) {
    const jsonSchema = z.toJSONSchema(group.schema, { target: "draft-2020-12" });
    const depth = maxNestingDepth(jsonSchema, 0);
    expect(depth, `group "${group.key}" nests ${depth} levels`).toBeLessThanOrEqual(
      SCHEMA_NESTING_DEPTH_CAP,
    );
  }
});

/**
 * The per-instance groups (`hvac`, `attic`, `vault`, `wall`, `window`, `dhw`) and the
 * job-collection groups (`concern`, `incentive`) are arrays of instances in the real
 * `snuggExtractionSchema`. This test asserts the split still produces one entry per
 * group and that collection groups are actually arrays in the derived schema. The caps
 * are NOT asserted here: they bind per CALL, and a call carries a partitioned piece —
 * the unpartitioned `basedata` group is over the character cap by design and is never
 * sent.
 */
test("the real derived schema splits collection groups as arrays", () => {
  const groups = splitExtractionSchema(snuggExtractionSchema);
  expect(groups.map((g) => g.key)).toEqual([
    "basedata",
    "hvac",
    "attic",
    "vault",
    "wall",
    "window",
    "dhw",
    "health",
    "concern",
    "incentive",
    "stage",
  ]);

  const collectionKeys = new Set([
    "hvac",
    "attic",
    "vault",
    "wall",
    "window",
    "dhw",
    "concern",
    "incentive",
  ]);
  for (const group of groups) {
    const shape = (group.schema as z.ZodObject).shape;
    const inner = shape[group.key];
    if (collectionKeys.has(group.key)) {
      expect(inner, `group "${group.key}" must be a ZodArray`).toBeInstanceOf(z.ZodArray);
    } else {
      expect(inner, `group "${group.key}" must remain a ZodObject`).toBeInstanceOf(z.ZodObject);
    }

    const jsonSchema = z.toJSONSchema(group.schema, { target: "draft-2020-12" });
    const depth = maxNestingDepth(jsonSchema, 0);
    expect(depth, `group "${group.key}" nests ${depth} levels`).toBeLessThanOrEqual(
      SCHEMA_NESTING_DEPTH_CAP,
    );
  }
});

/**
 * Guard the managed-route MODEL-FAMILY cap — Anthropic-family models reject a response
 * schema carrying more than 16 nullable unions on the managed route, and `Enveloped<V>`
 * emits two nullable unions per leaf (`value`, `sourceSpan`), so the real per-call
 * ceiling is 8 enveloped leaves. This is a DIFFERENT limit from the byte-size/nesting
 * caps above: an over-cap group can sit comfortably under both, so a byte-size test
 * never catches this. It is invisible in production today because the managed route is
 * pinned to OpenAI-family models — fixing it now, rather than when that pin changes, is
 * the point of this guard.
 *
 * `splitExtractionSchema`'s `maxLeavesPerGroup` partitions an over-cap group into
 * multiple entries sharing one key (`ExtractionGroup.part`/`parts`); `perGroupExtractor`
 * makes one call per entry and recombines. This file only exercises the pure split —
 * recombination is exercised in `ribo-extractor-openai`'s tool-agnostic
 * `per-group.test.ts`.
 */
describe("the per-group split respects the 8-enveloped-leaf / 16-nullable-union cap", () => {
  /**
   * Count the enveloped leaves ONE group (or partitioned piece) asks the model for:
   * unwrap the group's top-level key and any collection array, then count the object's
   * own keys — `enveloped()` recurses only one level, so a group's own properties are
   * always leaf envelopes, never further nested sub-groups.
   */
  function groupLeafCount(group: ExtractionGroup): number {
    const shape = (group.schema as z.ZodObject).shape;
    const value = shape[group.key]!;
    const candidate = value instanceof z.ZodArray ? (value.element as z.ZodType) : value;
    return Object.keys((candidate as z.ZodObject).shape).length;
  }

  test("before partitioning, basedata, hvac, attic, vault, window and health all exceed the 8-leaf cap — the bug this guard exists to catch", () => {
    // No `maxLeavesPerGroup` — the one-entry-per-group split `perGroupExtractor` would
    // send if it never partitioned. This pins the starting problem: without the fix
    // below, these groups would send an over-cap schema to an Anthropic-family model.
    const unpartitioned = splitExtractionSchema(snuggExtractionSchema);
    const basedata = unpartitioned.find((g) => g.key === "basedata")!;
    const hvac = unpartitioned.find((g) => g.key === "hvac")!;
    const attic = unpartitioned.find((g) => g.key === "attic")!;
    const vault = unpartitioned.find((g) => g.key === "vault")!;
    const windowGroup = unpartitioned.find((g) => g.key === "window")!;
    const health = unpartitioned.find((g) => g.key === "health")!;

    expect(groupLeafCount(basedata)).toBe(163);
    expect(groupLeafCount(hvac)).toBe(12);
    expect(groupLeafCount(attic)).toBe(0);
    expect(groupLeafCount(vault)).toBe(0);
    expect(groupLeafCount(windowGroup)).toBe(0);
    expect(groupLeafCount(health)).toBe(16);
    expect(groupLeafCount(basedata)).toBeGreaterThan(MAX_ENVELOPED_LEAVES_PER_GROUP);
    expect(groupLeafCount(hvac)).toBeGreaterThan(MAX_ENVELOPED_LEAVES_PER_GROUP);
    expect(groupLeafCount(attic)).toBeGreaterThan(MAX_ENVELOPED_LEAVES_PER_GROUP);
    expect(groupLeafCount(vault)).toBeGreaterThan(MAX_ENVELOPED_LEAVES_PER_GROUP);
    expect(groupLeafCount(windowGroup)).toBeGreaterThan(MAX_ENVELOPED_LEAVES_PER_GROUP);
    expect(groupLeafCount(health)).toBeGreaterThan(MAX_ENVELOPED_LEAVES_PER_GROUP);
  });

  test("every partitioned entry stays at or under the 8-leaf cap (16 nullable unions)", () => {
    const groups = splitExtractionSchema(snuggExtractionSchema, MAX_ENVELOPED_LEAVES_PER_GROUP);

    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      const leaves = groupLeafCount(group);
      expect(
        leaves,
        `group "${group.key}"${group.part !== undefined ? ` part ${group.part}` : ""} carries ${leaves} leaves`,
      ).toBeLessThanOrEqual(MAX_ENVELOPED_LEAVES_PER_GROUP);
      // Enveloped<V> emits exactly two nullable unions per leaf — the cap this leaf
      // count stands in for.
      expect(leaves * 2).toBeLessThanOrEqual(16);
    }
  });

  test("the over-cap groups are partitioned into pieces sharing one key, and every other group is untouched", () => {
    const groups = splitExtractionSchema(snuggExtractionSchema, MAX_ENVELOPED_LEAVES_PER_GROUP);

    const byKey = new Map<string, ExtractionGroup[]>();
    for (const group of groups) {
      byKey.set(group.key, [...(byKey.get(group.key) ?? []), group]);
    }

    // The top-level keys as seen by consumers are unchanged — partitioning is purely
    // about call count, never about the resource model.
    expect([...byKey.keys()]).toEqual([
      "basedata",
      "hvac",
      "attic",
      "vault",
      "wall",
      "window",
      "dhw",
      "health",
      "concern",
      "incentive",
      "stage",
    ]);

    expect(byKey.get("basedata")).toHaveLength(21);
    expect(byKey.get("hvac")).toHaveLength(2);
    expect(byKey.get("attic")).toHaveLength(0);
    expect(byKey.get("vault")).toHaveLength(0);
    expect(byKey.get("window")).toHaveLength(0);
    expect(byKey.get("health")).toHaveLength(2);
    for (const key of ["wall", "dhw", "concern", "incentive", "stage"]) {
      const pieces = byKey.get(key)!;
      expect(pieces, `group "${key}"`).toHaveLength(1);
      expect(pieces[0]!.part, `group "${key}" should not be partitioned`).toBeUndefined();
    }

    // Each partitioned key's pieces are labelled 0..parts-1, in order, and their leaf
    // counts sum back to the original — no leaf lost or duplicated across the split.
    for (const [key, expectedTotal] of [
      ["basedata", 163],
      ["hvac", 12],
      ["attic", 0],
      ["vault", 0],
      ["window", 0],
      ["health", 16],
    ] as const) {
      const pieces = byKey.get(key)!;
      expect(pieces.map((p) => p.part)).toEqual(pieces.map((_, i) => i));
      expect(pieces.every((p) => p.parts === pieces.length)).toBe(true);
      const total = pieces.reduce((sum, p) => sum + groupLeafCount(p), 0);
      expect(total).toBe(expectedTotal);

      // No leaf key is duplicated across the pieces.
      const allLeafKeys = pieces.flatMap((p) => {
        const shape = (p.schema as z.ZodObject).shape;
        const value = shape[p.key]!;
        const candidate = value instanceof z.ZodArray ? (value.element as z.ZodType) : value;
        return Object.keys((candidate as z.ZodObject).shape);
      });
      expect(new Set(allLeafKeys).size).toBe(allLeafKeys.length);
    }
  });

  test("a partitioned piece still serializes under the byte-size and nesting-depth caps", () => {
    const groups = splitExtractionSchema(snuggExtractionSchema, MAX_ENVELOPED_LEAVES_PER_GROUP);

    for (const group of groups) {
      const jsonSchema = z.toJSONSchema(group.schema, { target: "draft-2020-12" });
      const serialized = JSON.stringify(jsonSchema);
      expect(serialized.length).toBeLessThan(SCHEMA_SERIALIZED_CHAR_CAP);
      expect(maxNestingDepth(jsonSchema, 0)).toBeLessThanOrEqual(SCHEMA_NESTING_DEPTH_CAP);
    }
  });
});
