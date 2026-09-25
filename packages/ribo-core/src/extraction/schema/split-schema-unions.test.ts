import { enveloped } from "../../provenance/enveloped.js";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { MAX_NULLABLE_UNIONS_PER_CALL, splitExtractionSchema } from "./split-schema.js";

/**
 * @file The split partitions on NULLABLE UNIONS, not on leaves.
 *
 * The cap the partition exists to respect is the Anthropic family's 16 nullable unions per
 * response schema. A leaf count only stands in for it while every leaf is enveloped and so worth
 * exactly two unions (`value`, `sourceSpan`). Once a group can declare `"row"` or `"none"`
 * provenance its leaves are worth one union each, and a leaf count would split a group that fits
 * comfortably in one call — buying nothing, which is the whole point of the option.
 *
 * These are the assertions that fail if the union counting is missed.
 */

/** A group of `count` plain-value leaves, before enveloping. */
const leafGroup = (count: number): z.ZodObject => {
  const shape: Record<string, z.ZodType> = {};
  for (let i = 0; i < count; i++) shape[`leaf${i}`] = z.number().nullable().optional();
  return z.object(shape);
};

const collectionPatch = (count: number) =>
  z.object({ rooms: z.array(leafGroup(count)).optional() });

const partsFor = (schema: z.ZodType): number =>
  splitExtractionSchema(schema, MAX_NULLABLE_UNIONS_PER_CALL).filter((g) => g.key === "rooms")
    .length;

describe("splitExtractionSchema — the cap is 16 nullable unions per call", () => {
  test("a 15-leaf row group plus its row span is ONE call, not two", () => {
    // 15 plain leaves (one union each) + one row sourceSpan = 16 unions, exactly the cap.
    // Under a leaf count of 8 this was two calls; the measured difference between the two
    // shapes on a real 15-leaf room set is 2 calls against 1.
    const schema = enveloped(collectionPatch(15), { provenance: { rooms: "row" } });

    expect(partsFor(schema)).toBe(1);
  });

  test("a 16-leaf group with no provenance at all is ONE call", () => {
    const schema = enveloped(collectionPatch(16), { provenance: { rooms: "none" } });

    expect(partsFor(schema)).toBe(1);
  });

  test("a 17-leaf group with no provenance is two calls — 17 unions is over the cap", () => {
    const schema = enveloped(collectionPatch(17), { provenance: { rooms: "none" } });

    expect(partsFor(schema)).toBe(2);
  });

  test("an 8-leaf enveloped group is still one call, and a 9-leaf one still two", () => {
    // The enveloped arithmetic is unchanged: 8 leaves x 2 unions = 16, exactly the cap.
    // This is what keeps every existing partition boundary where it was.
    expect(partsFor(enveloped(collectionPatch(8)))).toBe(1);
    expect(partsFor(enveloped(collectionPatch(9)))).toBe(2);
  });

  test("enveloped pieces are still evenly sized — 12 leaves is 6 + 6, not 8 + 4", () => {
    const groups = splitExtractionSchema(
      enveloped(collectionPatch(12)),
      MAX_NULLABLE_UNIONS_PER_CALL,
    );

    const sizes = groups.map(
      (g) =>
        Object.keys(
          ((g.schema as z.ZodObject).shape.rooms as z.ZodArray<z.ZodObject>).element.shape,
        ).length,
    );
    expect(sizes).toEqual([6, 6]);
  });
});

describe("splitExtractionSchema — a row group is still a group", () => {
  const mixedPatch = z.object({
    rooms: z.array(leafGroup(3)).optional(),
    basedata: leafGroup(2).optional(),
  });

  test("a mixed schema still splits per group rather than collapsing to one call", () => {
    // A row group's properties are plain leaves, not objects. The old "every property is an
    // object" test for a group reads that as an envelope, decides the schema is not grouped, and
    // returns the WHOLE schema as a single entry — silently undoing the per-group split for
    // every group, not just the row one.
    const schema = enveloped(mixedPatch, { provenance: { rooms: "row" } });

    const groups = splitExtractionSchema(schema, MAX_NULLABLE_UNIONS_PER_CALL);

    expect(groups.map((g) => g.key)).toEqual(["rooms", "basedata"]);
  });

  test("a flat schema of bare envelopes is still the non-grouped fallback", () => {
    const flat = enveloped(z.object({ note: z.string().nullable().optional() }));

    const groups = splitExtractionSchema(flat, MAX_NULLABLE_UNIONS_PER_CALL);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("");
  });

  test("a partitioned row group keeps its row span in exactly one piece", () => {
    // 20 plain leaves + 1 span = 21 unions, so this one does partition. The span rides in
    // whichever piece declaration order puts it in; the element-wise merge in `per-group.ts`
    // reassembles the row either way, so what matters is that it appears once and is not
    // duplicated into a second call the model would answer differently.
    const schema = enveloped(collectionPatch(20), { provenance: { rooms: "row" } });

    const groups = splitExtractionSchema(schema, MAX_NULLABLE_UNIONS_PER_CALL);
    const withSpan = groups.filter((g) =>
      Object.hasOwn(
        ((g.schema as z.ZodObject).shape.rooms as z.ZodArray<z.ZodObject>).element.shape,
        "sourceSpan",
      ),
    );

    expect(groups).toHaveLength(2);
    expect(withSpan).toHaveLength(1);
  });
});
