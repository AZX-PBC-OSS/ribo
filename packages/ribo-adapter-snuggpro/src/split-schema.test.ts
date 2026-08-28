import { expect, test } from "vitest";
import { z } from "zod";

import { splitExtractionSchema } from "@azx/ribo-extractor-openai";

import { snuggExtractionSchema } from "./schema.js";

/**
 * Snugg-specific tests for `splitExtractionSchema` against the real
 * `snuggExtractionSchema` — 51 enveloped leaves across seven resource groups.
 * The pure function lives in `@azx/ribo-extractor-openai` (tool-agnostic, no
 * adapter dependency); these tests live here because the real schema lives here,
 * and this package already depends on the extractor for testing
 * (`extraction-shape.test.ts`).
 */

// The seven resource groups are the top-level keys of `snuggValuesSchema`, which
// `enveloped()` preserves — see schema.ts's file header.
const SEVEN_GROUPS = ["basedata", "hvac", "attic", "wall", "window", "dhw", "health"] as const;

const ENVELOPE_KEYS = new Set(["value", "confidence", "sourceSpan"]);

/**
 * Walk a zod object schema and collect the dotted paths to every envelope — every
 * `{ value, confidence, sourceSpan }` leaf. An envelope is identified by its key
 * set, which is the shape `extractedSchema` always produces, independent of the
 * split implementation's own group-detection heuristic.
 */
function enumerateLeaves(schema: z.ZodType, prefix = ""): string[] {
  if (schema instanceof z.ZodArray) {
    return enumerateLeaves(schema.element as unknown as z.ZodType, prefix);
  }
  if (!(schema instanceof z.ZodObject)) return [];
  const shape = schema.shape;
  const keys = Object.keys(shape);

  if (keys.length === 3 && keys.every((k) => ENVELOPE_KEYS.has(k))) {
    return prefix ? [prefix] : [];
  }

  const leaves: string[] = [];
  for (const key of keys) {
    const child = shape[key];
    leaves.push(...enumerateLeaves(child, prefix ? `${prefix}.${key}` : key));
  }
  return leaves;
}

test("the seven Snugg groups are derived from snuggExtractionSchema, each carrying exactly its own key", () => {
  const groups = splitExtractionSchema(snuggExtractionSchema);

  expect(groups.map((g) => g.key)).toEqual([...SEVEN_GROUPS]);

  for (const group of groups) {
    const shape = (group.schema as z.ZodObject).shape;
    expect(Object.keys(shape)).toEqual([group.key]);
  }
});

test("every leaf of snuggExtractionSchema appears in exactly one group schema, and none is lost", () => {
  const groups = splitExtractionSchema(snuggExtractionSchema);

  const originalLeaves = enumerateLeaves(snuggExtractionSchema).sort();
  const groupLeaves = groups.flatMap((g) => enumerateLeaves(g.schema)).sort();

  // 51 leaves across 7 groups — the count that the field set was designed for.
  expect(originalLeaves).toHaveLength(51);

  // No leaf is lost: the union of per-group leaves equals the original's.
  expect(groupLeaves).toEqual(originalLeaves);

  // No leaf is duplicated: every leaf appears in exactly one group.
  expect(new Set(groupLeaves).size).toBe(groupLeaves.length);
});
