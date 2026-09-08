import { expect, test } from "vitest";
import { z } from "zod";

import { splitExtractionSchema } from "@azx/ribo-extractor-openai";

import { snuggExtractionSchema } from "./schema.js";

/**
 * Snugg-specific tests for `splitExtractionSchema` against the real
 * `snuggExtractionSchema` — 208 enveloped leaves across eight resource groups.
 * The pure function lives in `@azx/ribo-extractor-openai` (tool-agnostic, no
 * adapter dependency); these tests live here because the real schema lives here,
 * and this package already depends on the extractor for testing
 * (`extraction-shape.test.ts`).
 */

// The eight resource groups are the top-level keys of `snuggValuesSchema`, which
// `enveloped()` preserves — see schema.ts's file header.
const EIGHT_GROUPS = [
  "basedata",
  "hvac",
  "attic",
  "wall",
  "window",
  "dhw",
  "health",
  "stage",
] as const;

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

test("the eight Snugg groups are derived from snuggExtractionSchema, each carrying exactly its own key", () => {
  const groups = splitExtractionSchema(snuggExtractionSchema);

  expect(groups.map((g) => g.key)).toEqual([...EIGHT_GROUPS]);

  for (const group of groups) {
    const shape = (group.schema as z.ZodObject).shape;
    expect(Object.keys(shape)).toEqual([group.key]);
  }
});

test("every leaf of snuggExtractionSchema appears in exactly one group schema, and none is lost", () => {
  const groups = splitExtractionSchema(snuggExtractionSchema);

  const originalLeaves = enumerateLeaves(snuggExtractionSchema).sort();
  const groupLeaves = groups.flatMap((g) => enumerateLeaves(g.schema)).sort();

  // 208 leaves across 8 groups — the full 163-field basedata capture surface,
  // the 44 bounded component-group leaves, and the one `stage` leaf.
  expect(originalLeaves).toHaveLength(208);

  // No leaf is lost: the union of per-group leaves equals the original's.
  expect(groupLeaves).toEqual(originalLeaves);

  // No leaf is duplicated: every leaf appears in exactly one group.
  expect(new Set(groupLeaves).size).toBe(groupLeaves.length);
});
