import { expect, test } from "vitest";
import { z } from "zod";

import { splitExtractionSchema } from "@azx/ribo-extractor-openai";

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
 * vendor descriptions is ~39.7k characters — over the character cap — which is
 * the whole reason R3 splits the call per top-level group. Each group is a
 * fraction of the whole (largest is `health` at ~13.3k) and fits with its
 * descriptions.
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

test("every per-group schema serializes under the character cap", () => {
  const groups = splitExtractionSchema(snuggExtractionSchema);
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

test("every per-group schema nests within the depth cap", () => {
  const groups = splitExtractionSchema(snuggExtractionSchema);
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
 * The five collection groups (`hvac`, `attic`, `wall`, `window`, `dhw`) will be
 * arrays of instances in Task 5. The split must still produce one entry per group,
 * and each per-group schema — including the array-wrapped ones — must fit under the
 * route's cap. This is the only test that exercises the cap against the real Snugg
 * leaf set with the array wrapper in place.
 */
test("array-wrapped collection groups split and stay under the caps", () => {
  const shape = snuggExtractionSchema.shape;
  const arraySchema = z.strictObject({
    basedata: shape.basedata,
    hvac: z.array(shape.hvac),
    attic: z.array(shape.attic),
    wall: z.array(shape.wall),
    window: z.array(shape.window),
    dhw: z.array(shape.dhw),
    health: shape.health,
  });

  const groups = splitExtractionSchema(arraySchema);
  expect(groups.map((g) => g.key)).toEqual([
    "basedata",
    "hvac",
    "attic",
    "wall",
    "window",
    "dhw",
    "health",
  ]);

  for (const group of groups) {
    const jsonSchema = z.toJSONSchema(group.schema, { target: "draft-2020-12" });
    const serialized = JSON.stringify(jsonSchema);
    expect(
      serialized.length,
      `group "${group.key}" serialized schema is ${serialized.length} characters`,
    ).toBeLessThan(SCHEMA_SERIALIZED_CHAR_CAP);

    const depth = maxNestingDepth(jsonSchema, 0);
    expect(depth, `group "${group.key}" nests ${depth} levels`).toBeLessThanOrEqual(
      SCHEMA_NESTING_DEPTH_CAP,
    );
  }
});
