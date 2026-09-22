import { enveloped } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { serializedNestingDepth, splitExtractionSchema, topLevelKeyKinds } from "./split-schema.js";

/**
 * @file The two split-schema exports `describeExtraction` reports with: the
 * top-level classification the grouped/flat decision reads
 * (`topLevelKeyKinds`), and the serialized nesting-depth measure
 * (`serializedNestingDepth`) lifted from the adapter's cap suite so library
 * and adapter count a "level" the same way.
 *
 * The classification tests pin the five shapes the split's gate distinguishes
 * — group, collection group, loose leaf, non-object, empty — and, for the two
 * that decide a path, that the split's own behaviour agrees with the verdict
 * (the classifier is what the split reads; this suite fails if they part).
 */

const leaf = () => z.string().nullable().optional();

/** Two singleton groups and one collection group, enveloped. */
const groupedExtraction = enveloped(
  z
    .object({
      health: z.object({ h1: leaf() }).strict().optional(),
      hvac: z.array(z.object({ brand: leaf() }).strict()).optional(),
      attic: z.object({ a1: leaf() }).strict().optional(),
    })
    .strict(),
);

/** A group beside a loose top-level leaf — the mixed shape that falls flat today. */
const mixedExtraction = enveloped(
  z
    .object({
      health: z.object({ h1: leaf() }).strict().optional(),
      note: leaf(),
    })
    .strict(),
);

describe("topLevelKeyKinds", () => {
  test("an object of groups classifies every key a group — a collection group included", () => {
    const classified = topLevelKeyKinds(groupedExtraction);
    expect(classified.form).toBe("keys");
    if (classified.form !== "keys") return;
    expect(classified.keys).toEqual([
      { key: "health", kind: "group" },
      { key: "hvac", kind: "group" },
      { key: "attic", kind: "group" },
    ]);
  });

  test("a loose top-level leaf beside a group classifies loose — and the split agrees by falling flat", () => {
    const classified = topLevelKeyKinds(mixedExtraction);
    expect(classified.form).toBe("keys");
    if (classified.form !== "keys") return;
    expect(classified.keys).toEqual([
      { key: "health", kind: "group" },
      { key: "note", kind: "loose" },
    ]);

    // The classifier IS the split's gate: all-group schemas split per key,
    // one loose key collapses the whole schema to the single "" fallback.
    expect(splitExtractionSchema(groupedExtraction).map((g) => g.key)).toEqual([
      "health",
      "hvac",
      "attic",
    ]);
    expect(splitExtractionSchema(mixedExtraction).map((g) => g.key)).toEqual([""]);
  });

  test("a flat enveloped schema classifies every key loose", () => {
    const classified = topLevelKeyKinds(enveloped(z.object({ a: leaf(), b: leaf() }).strict()));
    expect(classified.form).toBe("keys");
    if (classified.form !== "keys") return;
    expect(classified.keys).toEqual([
      { key: "a", kind: "loose" },
      { key: "b", kind: "loose" },
    ]);
  });

  test("a non-object schema answers not-an-object", () => {
    // A top-level array of group objects — the split doc's "top-level array of
    // envelopes" — taken from a real derivation rather than hand-built.
    const arrayExtraction = topLevelKeyKinds(
      enveloped(
        z.object({ hvac: z.array(z.object({ brand: leaf() }).strict()).optional() }).strict(),
      ).shape.hvac,
    );
    expect(arrayExtraction.form).toBe("not-an-object");
    expect(arrayExtraction).toEqual({ form: "not-an-object" });
  });

  test("an empty object answers empty", () => {
    expect(topLevelKeyKinds(z.strictObject({}))).toEqual({ form: "empty" });
  });
});

describe("serializedNestingDepth", () => {
  /**
   * A deep-but-legal schema: `outer` nests an object three objects deep above
   * its leaves, `plain` is one ordinary group. Hand walk of the
   * `z.toJSONSchema(..., { target: "draft-2020-12" })` rendering, counting one
   * level per `properties` descent:
   *
   *   whole / piece "outer": root properties(1) → outer's properties(2) →
   *     mid's properties(3) → inner's properties(4) → the envelopes'
   *     properties(5) — depth 5.
   *   piece "plain": root properties(1) → plain's properties(2) → the
   *     envelope's properties(3) — depth 3.
   */
  const deepExtraction = enveloped(
    z
      .object({
        outer: z
          .object({
            mid: z.object({ inner: z.object({ a: leaf(), b: leaf() }).strict() }).strict(),
          })
          .strict()
          .optional(),
        plain: z.object({ x: leaf() }).strict().optional(),
      })
      .strict(),
  );

  test("the whole schema and each piece measure their own depth", () => {
    expect(serializedNestingDepth(deepExtraction)).toBe(5);
    const pieces = splitExtractionSchema(deepExtraction);
    expect(pieces.map((p) => p.key)).toEqual(["outer", "plain"]);
    expect(pieces.map((p) => serializedNestingDepth(p.schema))).toEqual([5, 3]);
  });

  test("a flat piece of one enveloped leaf is two levels: the leaf key, then the envelope's", () => {
    const flat = z.strictObject({ note: mixedExtraction.shape.note });
    expect(serializedNestingDepth(flat)).toBe(2);
  });
});
