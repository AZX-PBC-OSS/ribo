import { enveloped } from "../../provenance/enveloped.js";
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

/** A group beside a loose top-level leaf — the mixed shape (ADR 0023). */
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

  test("a loose top-level leaf beside a group classifies loose — and the split carries it as the trailing '' piece", () => {
    const classified = topLevelKeyKinds(mixedExtraction);
    expect(classified.form).toBe("keys");
    if (classified.form !== "keys") return;
    expect(classified.keys).toEqual([
      { key: "health", kind: "group" },
      { key: "note", kind: "loose" },
    ]);

    // The classifier's kinds are what the split partitions on: all-group
    // schemas split per key, and a mixed schema splits its groups and appends
    // the loose keys as the unwrapped portion (ADR 0023) — one loose key no
    // longer collapses anything to a single "" fallback.
    expect(splitExtractionSchema(groupedExtraction).map((g) => g.key)).toEqual([
      "health",
      "hvac",
      "attic",
    ]);
    expect(splitExtractionSchema(mixedExtraction).map((g) => g.key)).toEqual(["health", ""]);
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
  test("agrees with the structured-output route's verdicts", () => {
    // Shapes probed against the live route on 2026-09-22, which accepted depth 12 and
    // rejected 13. The enum case is the one a schema-structure count gets wrong: one
    // property, rejected for the nesting inside its data.
    const nestObjects = (k: number): z.ZodType =>
      k === 0 ? z.string() : z.strictObject({ a: nestObjects(k - 1) });
    const nestArrays = (k: number): unknown => (k === 0 ? "x" : [nestArrays(k - 1)]);
    const nestedEnumValue = z.strictObject({
      a: z.any().meta({ enum: [nestArrays(8)] }),
    });

    expect(serializedNestingDepth(nestObjects(5))).toBe(12); // accepted
    expect(serializedNestingDepth(nestObjects(6))).toBe(14); // rejected
    expect(serializedNestingDepth(nestedEnumValue)).toBe(13); // rejected
  });

  /**
   * A deep-but-legal schema: `outer` nests an object three objects deep above
   * its leaves, `plain` is one ordinary group. In raw JSON nesting each object
   * level costs two (the object, then its `properties`), and each nullable
   * envelope value ends in `anyOf` → arm → scalar:
   *
   *   whole / piece "outer": 14 — two deeper per object than "plain" at
   *     `mid` and `inner`.
   *   piece "plain": root, properties, plain, properties, x, properties,
   *     value, anyOf, arm, "string" — 10.
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
    expect(serializedNestingDepth(deepExtraction)).toBe(14);
    const pieces = splitExtractionSchema(deepExtraction);
    expect(pieces.map((p) => p.key)).toEqual(["outer", "plain"]);
    expect(pieces.map((p) => serializedNestingDepth(p.schema))).toEqual([14, 10]);
  });

  test("a flat piece of one enveloped leaf is eight levels, the nullable value's anyOf deepest", () => {
    // root, properties, note, properties, value, anyOf, arm, "string".
    const flat = z.strictObject({ note: mixedExtraction.shape.note });
    expect(serializedNestingDepth(flat)).toBe(8);
  });
});
