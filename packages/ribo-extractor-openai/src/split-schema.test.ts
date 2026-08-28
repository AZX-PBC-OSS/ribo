import { enveloped, extractedSchema } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { splitExtractionSchema } from "./split-schema.js";

/**
 * Key-free, network-free tests for `splitExtractionSchema` — the pure, model-free
 * half of R3. This package is tool-agnostic and must not depend on any adapter, so
 * the fixtures here are synthetic schemas that mirror the structures a real
 * adapter produces: a grouped schema (top-level properties are nested objects of
 * enveloped leaves), an array-group schema (top-level properties are arrays of
 * group objects, for collections), and a non-grouped schema (top-level properties
 * are envelopes directly). The Snugg-specific test against the real
 * `snuggExtractionSchema` lives in `ribo-adapter-snuggpro`, which already depends on
 * this package for testing.
 */

// --- Fixtures ----------------------------------------------------------------

/**
 * A grouped patch schema — mirrors Snugg Pro's structure: top-level properties are
 * nested objects, each a group of leaves. `enveloped()` recurses into them, so the
 * extraction schema keeps the same top-level keys.
 */
const groupedPatch = z
  .object({
    hvac: z
      .object({
        equipmentType: z.string().nullable().optional(),
        fuel: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    attic: z
      .object({
        insulationDepth: z.string().nullable().optional(),
        insulationRValue: z.number().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const groupedExtraction = enveloped(groupedPatch);

/**
 * A non-grouped patch schema — mirrors the attic test fixture in ribo-core: a flat
 * object whose leaves are directly under the top level. `enveloped()` wraps each
 * leaf in an envelope, so the extraction schema's top-level properties ARE
 * envelopes — not nested groups.
 */
const flatPatch = z
  .object({
    rValue: z.number().nullable().optional(),
    area: z.number().nullable().optional(),
  })
  .strict();

const flatExtraction = enveloped(flatPatch);

/**
 * A collection-group extraction schema — one top-level property is a `ZodArray`
 * whose element is a group object of envelopes. This mirrors the shape Task 5
 * will produce for the five Snugg collection groups; the test exercises it before
 * that derivation exists.
 */
const arrayGroupExtraction = z.strictObject({
  hvac: z.array(
    z.strictObject({
      equipmentType: extractedSchema(z.string()),
      fuel: extractedSchema(z.string()),
    }),
  ),
  attic: z.strictObject({
    insulationDepth: extractedSchema(z.string()),
    insulationRValue: extractedSchema(z.number()),
  }),
});

// --- Leaf enumeration (for the coverage test) --------------------------------

const ENVELOPE_KEYS = new Set(["value", "confidence", "sourceSpan"]);

/**
 * Walk a zod schema and collect the dotted paths to every envelope — every
 * `{ value, confidence, sourceSpan }` leaf. This is the test's independent way to
 * enumerate what the split must cover, without relying on the implementation's own
 * `isGroupObject` heuristic: an envelope is identified by its key set, which is the
 * shape `extractedSchema` always produces. Arrays are unwrapped to their element
 * so collection groups are counted the same way as singleton groups.
 */
function unwrapArray(schema: z.ZodType): z.ZodType {
  // The schemas under test are built with the classic `z` API, so the array
  // element at runtime is the same classic wrapper the rest of the test uses.
  return schema instanceof z.ZodArray ? (schema.element as z.ZodType) : schema;
}

function enumerateLeaves(schema: z.ZodType, prefix = ""): string[] {
  const unwrapped = unwrapArray(schema);
  if (!(unwrapped instanceof z.ZodObject)) return [];
  const shape = unwrapped.shape;
  const keys = Object.keys(shape);

  if (keys.length === 3 && keys.every((k) => ENVELOPE_KEYS.has(k))) {
    return prefix ? [prefix] : [];
  }

  const leaves: string[] = [];
  for (const key of keys) {
    const child = unwrapArray(shape[key]);
    if (child instanceof z.ZodObject) {
      leaves.push(...enumerateLeaves(child, prefix ? `${prefix}.${key}` : key));
    }
  }
  return leaves;
}

// --- Tests -------------------------------------------------------------------

describe("splitExtractionSchema — grouped schema", () => {
  test("derives the top-level groups, each carrying exactly its own key", () => {
    const groups = splitExtractionSchema(groupedExtraction);

    expect(groups.map((g) => g.key)).toEqual(["hvac", "attic"]);

    // Each group's schema is a strict object with exactly one top-level key.
    for (const group of groups) {
      const shape = (group.schema as z.ZodObject).shape;
      expect(Object.keys(shape)).toEqual([group.key]);
    }
  });

  test("a per-group schema narrows — it accepts its own group and rejects another's key", () => {
    const groups = splitExtractionSchema(groupedExtraction);
    const hvac = groups.find((g) => g.key === "hvac")!;
    const attic = groups.find((g) => g.key === "attic")!;

    // A valid hvac-shaped object (enveloped) parsed against the hvac group schema.
    const hvacData = {
      hvac: {
        equipmentType: { value: "Boiler", confidence: 0.9, sourceSpan: "it's a boiler" },
        fuel: { value: "Natural Gas", confidence: 0.8, sourceSpan: "natural gas" },
      },
    };
    expect(hvac.schema.safeParse(hvacData).success).toBe(true);

    // The same hvac data parsed against the attic group schema must fail — attic's
    // schema has `attic` as its sole required key, and `hvac` is an extra key a
    // strict object rejects. This proves the split narrows rather than merely
    // relabels: the per-group schema rejects what the full schema would accept.
    expect(attic.schema.safeParse(hvacData).success).toBe(false);

    // And vice versa.
    const atticData = {
      attic: {
        insulationDepth: { value: "10-12", confidence: 0.9, sourceSpan: "about ten inches" },
        insulationRValue: { value: 30, confidence: 0.7, sourceSpan: "R-30" },
      },
    };
    expect(attic.schema.safeParse(atticData).success).toBe(true);
    expect(hvac.schema.safeParse(atticData).success).toBe(false);

    // Strictness: an object carrying BOTH groups' keys is rejected by either
    // per-group schema, even though the full schema accepts it. A non-strict
    // (open) per-group schema would accept the extra key — this is the assertion
    // that catches `z.object` where `z.strictObject` was needed.
    const bothGroups = { ...hvacData, ...atticData };
    expect(hvac.schema.safeParse(bothGroups).success).toBe(false);
    expect(attic.schema.safeParse(bothGroups).success).toBe(false);
  });

  test("every leaf of the original schema appears in exactly one group schema, and none is lost", () => {
    const groups = splitExtractionSchema(groupedExtraction);

    const originalLeaves = enumerateLeaves(groupedExtraction).sort();
    const groupLeaves = groups.flatMap((g) => enumerateLeaves(g.schema)).sort();

    // No leaf is lost: the union of per-group leaves equals the original's.
    expect(groupLeaves).toEqual(originalLeaves);

    // No leaf is duplicated: every leaf appears in exactly one group.
    const unique = new Set(groupLeaves);
    expect(unique.size).toBe(groupLeaves.length);
  });
});

describe("splitExtractionSchema — array groups", () => {
  test("a schema whose groups are arrays still splits into one entry per group", () => {
    const groups = splitExtractionSchema(arrayGroupExtraction);

    expect(groups.map((g) => g.key)).toEqual(["hvac", "attic"]);

    // Each per-group schema keeps the array wrapper so the response shape matches
    // the final answer: one top-level key, whose value is an array of instances.
    const hvac = groups.find((g) => g.key === "hvac")!;
    const attic = groups.find((g) => g.key === "attic")!;
    expect((hvac.schema as z.ZodObject).shape.hvac).toBeInstanceOf(z.ZodArray);
    expect((attic.schema as z.ZodObject).shape.attic).not.toBeInstanceOf(z.ZodArray);

    // Narrowing: a valid hvac array response parses against the hvac group, and
    // the attic group rejects it because its top-level key is wrong.
    const hvacData = {
      hvac: [
        {
          equipmentType: { value: "Boiler", confidence: 0.9, sourceSpan: "boiler" },
          fuel: { value: "Natural Gas", confidence: 0.8, sourceSpan: "gas" },
        },
      ],
    };
    expect(hvac.schema.safeParse(hvacData).success).toBe(true);
    expect(attic.schema.safeParse(hvacData).success).toBe(false);
  });

  test("every leaf of an array-group schema appears in exactly one group schema, and none is lost", () => {
    const groups = splitExtractionSchema(arrayGroupExtraction);

    const originalLeaves = enumerateLeaves(arrayGroupExtraction).sort();
    const groupLeaves = groups.flatMap((g) => enumerateLeaves(g.schema)).sort();

    expect(originalLeaves).toEqual([
      "attic.insulationDepth",
      "attic.insulationRValue",
      "hvac.equipmentType",
      "hvac.fuel",
    ]);

    // No leaf is lost: the union of per-group leaves equals the original's.
    expect(groupLeaves).toEqual(originalLeaves);

    // No leaf is duplicated: every leaf appears in exactly one group.
    expect(new Set(groupLeaves).size).toBe(groupLeaves.length);
  });

  test("a top-level array of envelopes is not a group and falls back to one entry", () => {
    const arrayOfEnvelopes = z.strictObject({
      tags: z.array(extractedSchema(z.string())),
    });

    const groups = splitExtractionSchema(arrayOfEnvelopes);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("");
    expect(groups[0]!.schema).toBe(arrayOfEnvelopes);
  });
});

describe("splitExtractionSchema — non-grouped fallback", () => {
  test("a flat enveloped schema yields one entry covering everything", () => {
    const groups = splitExtractionSchema(flatExtraction);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("");

    // The fallback entry's schema IS the whole extraction schema — not a
    // one-key slice. A valid full response parses; a partial one does not.
    const full = {
      rValue: { value: 13, confidence: 0.9, sourceSpan: "R-13" },
      area: { value: 400, confidence: 0.8, sourceSpan: "four hundred square feet" },
    };
    expect(groups[0]!.schema.safeParse(full).success).toBe(true);

    // The patch's optionality does not survive enveloping — an omitted key is
    // rejected, which is the same behaviour the single-shot extractor sees.
    expect(groups[0]!.schema.safeParse({ rValue: full.rValue }).success).toBe(false);
  });

  test("a non-object schema yields one entry covering everything", () => {
    const scalar = z.string();
    const groups = splitExtractionSchema(scalar);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("");
    expect(groups[0]!.schema).toBe(scalar);
  });
});
