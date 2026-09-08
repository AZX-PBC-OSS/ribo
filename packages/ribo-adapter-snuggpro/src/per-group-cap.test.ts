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
 * The structured-output route the per-group extractor sends to rejects a schema
 * that is too big or too deep, with an HTTP 400 whose text names both limits:
 * `schema must serialize to <= 32768 characters and nest <= 12 levels`. That
 * error is a production failure on a real recording in the field; this test
 * turns it into a failing build instead. The full `snuggExtractionSchema` with
 * vendor descriptions is ~129k characters — over the character cap — which is
 * the whole reason R3 splits the call per top-level group. Since `basedata`
 * grew to its full 163-field capture surface, one call per GROUP is over too
 * (`basedata` alone is ~94k): the unit that fits — and the unit
 * `perGroupExtractor` actually sends — is the 8-leaf PARTITIONED PIECE
 * (largest measured ~7.4k), so that is what the cap assertions below run
 * against.
 *
 * The character cap was never checked before — only the nesting depth was, and
 * against a different, stricter source (OpenAI's documented 10-level ceiling in
 * `extraction-shape.test.ts`). Both limits named in the vendor's error are
 * asserted here, against the vendor's own numbers.
 *
 * Sizes are NOT pinned to exact byte counts. A test that asserts 13,273 fails
 * on every innocuous wording change and teaches people to bump the number
 * without thinking. The property that matters is: under the cap.
 */

/**
 * Walk a JSON Schema node and return the maximum nesting depth, counting one
 * level per `properties` descent — the same counting method
 * `extraction-shape.test.ts` uses for its own nesting check, so the two tests
 * agree on what a "level" is.
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
  // Partitioned, because that is the shape of a real call: `perGroupExtractor`
  // always splits at MAX_ENVELOPED_LEAVES_PER_GROUP, and an unpartitioned
  // `basedata` (~94k with vendor descriptions) is a schema no call ever carries.
  const groups = splitExtractionSchema(snuggExtractionSchema, MAX_ENVELOPED_LEAVES_PER_GROUP);
  expect(groups.length).toBeGreaterThan(1);

  for (const group of groups) {
    const jsonSchema = z.toJSONSchema(group.schema, { target: "draft-2020-12" });
    const serialized = JSON.stringify(jsonSchema);
    // Under the cap, not equal to it — a group exactly AT the cap is one
    // wording change away from breaking, so the guard leaves no margin to
    // discover that the hard way.
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
 * R1.6 Task 5 made the five per-instance groups (`hvac`, `attic`, `wall`,
 * `window`, `dhw`) arrays of instances, and the `incentive` job-collection
 * tranche (doc 20 §5.7) added a sixth. The real `snuggExtractionSchema` now carries
 * that shape. This test asserts the split still produces one entry per group, and
 * that the collection groups are actually arrays in the derived schema. The caps
 * are NOT asserted here: they bind per CALL, and a call carries a partitioned
 * piece — the unpartitioned `basedata` group (~94k characters) is over the
 * character cap by design and is never sent. The cap assertions above and below
 * run against the partitioned pieces instead.
 */
test("the real derived schema splits collection groups as arrays", () => {
  const groups = splitExtractionSchema(snuggExtractionSchema);
  expect(groups.map((g) => g.key)).toEqual([
    "basedata",
    "hvac",
    "attic",
    "wall",
    "window",
    "dhw",
    "health",
    "incentive",
  ]);

  const collectionKeys = new Set(["hvac", "attic", "wall", "window", "dhw", "incentive"]);
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
 * Guard the managed-route MODEL-FAMILY cap — Anthropic-family models reject a
 * response schema carrying more than 16 nullable unions on the managed route, and
 * `Enveloped<V>` emits two nullable unions per leaf (`value`, `sourceSpan`), so
 * the real per-call ceiling is 8 enveloped leaves. This is a DIFFERENT limit from
 * the byte-size/nesting-depth caps above: a group like `hvac` (12 leaves) sits
 * comfortably under 32,768 characters and 12 nesting levels, so a byte-size test
 * never catches this. It is invisible in production today because the
 * managed route is pinned to OpenAI-family models, which accept far more — but
 * fixing it now, rather than when that pin changes, is the point of this guard.
 *
 * `splitExtractionSchema`'s `maxLeavesPerGroup` partitions a group whose leaves
 * exceed the cap into multiple entries sharing one key (`ExtractionGroup.part`/
 * `parts`); `perGroupExtractor` (ribo-extractor-openai) makes one call per entry
 * and recombines the pieces. This file only exercises the pure split — the
 * recombination itself is exercised in `ribo-extractor-openai`'s
 * `per-group.test.ts`, which is tool-agnostic and cannot reference the real
 * Snugg schema.
 */
describe("the per-group split respects the 8-enveloped-leaf / 16-nullable-union cap", () => {
  /**
   * Count the enveloped leaves ONE group (or partitioned piece of one) asks the
   * model for: unwrap the group's top-level key, unwrap a collection group's
   * array to its per-instance element, and count that object's own keys — one
   * key per leaf, since `enveloped()` recurses only one level (see schema.ts's
   * file header), so a group's own properties are always leaf envelopes, never
   * further nested sub-groups.
   */
  function groupLeafCount(group: ExtractionGroup): number {
    const shape = (group.schema as z.ZodObject).shape;
    const value = shape[group.key]!;
    const candidate = value instanceof z.ZodArray ? (value.element as z.ZodType) : value;
    return Object.keys((candidate as z.ZodObject).shape).length;
  }

  test("before partitioning, basedata, hvac and health all exceed the 8-leaf cap — the bug this guard exists to catch", () => {
    // No `maxLeavesPerGroup` — today's one-entry-per-group split, exactly what
    // `perGroupExtractor` would send if it never partitioned. This pins the
    // starting problem: without the fix below, three of Snugg's eight groups
    // would send an over-cap schema to an Anthropic-family model — `basedata`
    // (163 leaves, its full doc-17 capture surface) most of all.
    const unpartitioned = splitExtractionSchema(snuggExtractionSchema);
    const basedata = unpartitioned.find((g) => g.key === "basedata")!;
    const hvac = unpartitioned.find((g) => g.key === "hvac")!;
    const health = unpartitioned.find((g) => g.key === "health")!;

    expect(groupLeafCount(basedata)).toBe(163);
    expect(groupLeafCount(hvac)).toBe(12);
    expect(groupLeafCount(health)).toBe(14);
    expect(groupLeafCount(basedata)).toBeGreaterThan(MAX_ENVELOPED_LEAVES_PER_GROUP);
    expect(groupLeafCount(hvac)).toBeGreaterThan(MAX_ENVELOPED_LEAVES_PER_GROUP);
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
      // Enveloped<V> emits exactly two nullable unions per leaf (value,
      // sourceSpan) — the cap this leaf count stands in for.
      expect(leaves * 2).toBeLessThanOrEqual(16);
    }
  });

  test("basedata (163 leaves), hvac (12) and health (14) are partitioned into pieces sharing one key, and every other group is untouched", () => {
    const groups = splitExtractionSchema(snuggExtractionSchema, MAX_ENVELOPED_LEAVES_PER_GROUP);

    const byKey = new Map<string, ExtractionGroup[]>();
    for (const group of groups) {
      byKey.set(group.key, [...(byKey.get(group.key) ?? []), group]);
    }

    // The eight top-level keys as seen by consumers are unchanged — partitioning
    // is purely about call count, never about the resource model.
    expect([...byKey.keys()]).toEqual([
      "basedata",
      "hvac",
      "attic",
      "wall",
      "window",
      "dhw",
      "health",
      "incentive",
    ]);

    // 163 leaves at an 8-leaf cap: ceil(163/8) = 21 evenly-sized pieces.
    expect(byKey.get("basedata")).toHaveLength(21);
    expect(byKey.get("hvac")).toHaveLength(2);
    expect(byKey.get("health")).toHaveLength(2);
    for (const key of ["attic", "wall", "window", "dhw", "incentive"]) {
      const pieces = byKey.get(key)!;
      expect(pieces, `group "${key}"`).toHaveLength(1);
      expect(pieces[0]!.part, `group "${key}" should not be partitioned`).toBeUndefined();
    }

    // Each partitioned key's pieces are labelled 0..parts-1, in order, and their
    // leaf counts sum back to the original 163 (basedata) / 12 (hvac) / 14
    // (health) — no leaf lost or duplicated across the split.
    for (const [key, expectedTotal] of [
      ["basedata", 163],
      ["hvac", 12],
      ["health", 14],
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
