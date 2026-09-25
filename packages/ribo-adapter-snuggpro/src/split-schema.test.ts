import { expect, test } from "vitest";
import { z } from "zod";

import { splitExtractionSchema } from "@azx/ribo-core";

import { snuggExtractionSchema } from "./schema.js";

/**
 * Snugg-specific tests for `splitExtractionSchema` against the real
 * `snuggExtractionSchema`. The pure function lives in `@azx/ribo-core`
 * (tool-agnostic); these tests live here because the real schema lives here.
 */

// The resource groups are the top-level keys of `snuggValuesSchema`, which `enveloped()`
// preserves.
const SNUGG_GROUPS = [
  "basedata",
  "hvac",
  "attic",
  "vault",
  "wall",
  "window",
  "door",
  "dhw",
  "health",
  "concern",
  "incentive",
  "clothesDryer",
  "freezer",
  "range",
  "refrigerator",
  "pv",
  "stage",
  "job",
  "report",
  "utilities",
] as const;

const ENVELOPE_KEYS = new Set(["value", "confidence", "sourceSpan"]);

/** `shape[key]` for a key from the shape's own keys — a bare shape indexes to `any`, so
 * the test narrows once here (the same move `ribo-core`'s `fieldAt` makes) instead of
 * suppressing `no-unsafe-argument` at each use. */
const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType => shape[key] as z.ZodType;

/**
 * Walk a zod object schema and collect the dotted paths to every envelope — every
 * `{ value, confidence, sourceSpan }` leaf. An envelope is identified by its key set,
 * independent of the split implementation's own group-detection heuristic.
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
    const child = fieldAt(shape, key);
    leaves.push(...enumerateLeaves(child, prefix ? `${prefix}.${key}` : key));
  }
  return leaves;
}

test("the Snugg groups are derived from snuggExtractionSchema, each carrying exactly its own key", () => {
  const groups = splitExtractionSchema(snuggExtractionSchema);

  expect(groups.map((g) => g.key)).toEqual([...SNUGG_GROUPS]);

  for (const group of groups) {
    const shape = (group.schema as z.ZodObject).shape;
    expect(Object.keys(shape)).toEqual([group.key]);
  }
});

test("every leaf of snuggExtractionSchema appears in exactly one group schema, and none is lost", () => {
  const groups = splitExtractionSchema(snuggExtractionSchema);

  const originalLeaves = enumerateLeaves(snuggExtractionSchema).sort();
  const groupLeaves = groups.flatMap((g) => enumerateLeaves(g.schema)).sort();

  expect(originalLeaves).toHaveLength(441);

  // No leaf is lost: the union of per-group leaves equals the original's.
  expect(groupLeaves).toEqual(originalLeaves);

  // No leaf is duplicated: every leaf appears in exactly one group.
  expect(new Set(groupLeaves).size).toBe(groupLeaves.length);
});
