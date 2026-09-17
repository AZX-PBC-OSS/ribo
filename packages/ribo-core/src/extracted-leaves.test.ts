import { describe, expect, test } from "vitest";

import { isExtractedLeaf, mapExtractedLeaves } from "./extracted-leaves.js";
import type { Extracted } from "./provenance.js";

/**
 * Tests for the runtime walk over enveloped data, against hand-built enveloped
 * data — a flat group of envelopes and a collection group that is an array of
 * them. The property under test is the walk's ONE behaviour beyond visiting:
 * structure-preserving identity — a subtree keeps its reference when nothing
 * under it changed, and a fresh object appears only along the path that did.
 * `gapFillExtractor`'s merge relies on it so untouched leaves stay
 * reference-equal to the base extractor's.
 */

const leaf = (value: unknown, confidence: number, sourceSpan: string | null): Extracted<unknown> => ({
  value,
  confidence,
  sourceSpan,
});

/** A flat group of envelopes (`envelope`) and a collection group (`hvac`). */
const fields = {
  envelope: {
    roof: leaf("asphalt_shingle", 0.9, "asphalt shingles"),
    wall: leaf("brick", 0.9, "brick walls"),
  },
  hvac: [{ fuel: leaf("gas", 0.95, "gas furnace") }, { fuel: leaf(null, 0.2, null) }],
};

describe("mapExtractedLeaves", () => {
  test("visits every leaf with its structured path — object keys and array indices, never a string", () => {
    const visited: { path: readonly (string | number)[]; leaf: Extracted<unknown> }[] = [];
    mapExtractedLeaves(fields, [], (visitedLeaf, path) => {
      visited.push({ path, leaf: visitedLeaf });
      return visitedLeaf;
    });

    expect(visited).toEqual([
      { path: ["envelope", "roof"], leaf: fields.envelope.roof },
      { path: ["envelope", "wall"], leaf: fields.envelope.wall },
      { path: ["hvac", 0, "fuel"], leaf: fields.hvac[0]?.fuel },
      { path: ["hvac", 1, "fuel"], leaf: fields.hvac[1]?.fuel },
    ]);
    // The paths are structured segments, not a pre-joined string — nothing that
    // consumes a path ever has to parse it back apart.
    for (const { path } of visited) {
      expect(Array.isArray(path)).toBe(true);
    }
  });

  test("a visitor returning every leaf unchanged returns the same root object by identity", () => {
    const result = mapExtractedLeaves(fields, [], (visited) => visited);
    expect(result).toBe(fields);
  });

  test("a visitor changing one leaf returns a fresh root, a fresh containing group, and untouched siblings by identity", () => {
    const result = mapExtractedLeaves(fields, [], (visited) =>
      visited.sourceSpan === "asphalt shingles" ? { ...visited, value: "metal" } : visited,
    ) as typeof fields;

    // Rebuilt along the path to the change…
    expect(result).not.toBe(fields);
    expect(result.envelope).not.toBe(fields.envelope);
    expect(result.envelope.roof).not.toBe(fields.envelope.roof);
    expect(result.envelope.roof).toEqual({ value: "metal", confidence: 0.9, sourceSpan: "asphalt shingles" });

    // …and identity-preserving everywhere else: the untouched sibling leaf, the
    // untouched collection group, and the untouched instance inside it.
    expect(result.envelope.wall).toBe(fields.envelope.wall);
    expect(result.hvac).toBe(fields.hvac);
    expect(result.hvac[0]).toBe(fields.hvac[0]);
    expect(result.hvac[0]?.fuel).toBe(fields.hvac[0]?.fuel);
    expect(result.hvac[1]).toBe(fields.hvac[1]);
  });

  test("changing one leaf inside a collection instance rebuilds the containing array and instance, not the sibling instance", () => {
    const result = mapExtractedLeaves(fields, [], (visited) =>
      visited.value === null ? { ...visited, value: "oil" } : visited,
    ) as typeof fields;

    expect(result.hvac).not.toBe(fields.hvac);
    expect(result.hvac[1]).not.toBe(fields.hvac[1]);
    expect(result.hvac[0]).toBe(fields.hvac[0]);
    expect(result.envelope).toBe(fields.envelope);
  });
});

describe("isExtractedLeaf", () => {
  test("accepts a leaf envelope", () => {
    expect(isExtractedLeaf(leaf("gas", 0.95, "gas furnace"))).toBe(true);
    expect(isExtractedLeaf(leaf(null, 0.2, null))).toBe(true);
  });

  test("rejects a group of envelopes", () => {
    expect(isExtractedLeaf(fields.envelope)).toBe(false);
  });

  test("rejects an array", () => {
    expect(isExtractedLeaf(fields.hvac)).toBe(false);
    expect(isExtractedLeaf([leaf("gas", 0.95, "gas furnace")])).toBe(false);
  });

  test("rejects null, a string, and other non-objects", () => {
    expect(isExtractedLeaf(null)).toBe(false);
    expect(isExtractedLeaf("gas furnace")).toBe(false);
    expect(isExtractedLeaf(42)).toBe(false);
    expect(isExtractedLeaf(undefined)).toBe(false);
  });

  test("rejects a row-shaped object — plain values plus a row-level sourceSpan but no confidence", () => {
    // The shape `enveloped()` derives for a group declared at `"row"` granularity:
    // plain nullable values and ONE row-level span. The load-bearing check is
    // `confidence` being a number — a row unit has none.
    const rowUnit = {
      name: "living room",
      area: 20,
      sourceSpan: "the living room is 20 square metres",
    };
    expect(isExtractedLeaf(rowUnit)).toBe(false);
  });
});
