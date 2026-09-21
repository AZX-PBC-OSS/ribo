import { enveloped } from "@azx/ribo-core";
import { z } from "zod";
import { expect, test } from "vitest";

import { deriveExtractionShape } from "./shape-operations.js";
import { generateShapedValue } from "./shape-generate.js";
import { reverseShapedFields } from "./shape-reverse.js";

/**
 * @file STAGE 1 — the two properties, over a schema the library has never seen.
 *
 * The fixture is a marine survey: nested sub-objects, not flat prefixed leaves
 * — the pilot adapter's shape is the already-shaped one, and operations applied
 * to it are near-empty. Every operation the set names appears here, at mixed
 * provenance granularities: two drops (one crossing a collection), two retypes
 * (one inside a `"row"` group), a regroup that deepens, renames and re-hangs,
 * and a nested array inside a row group, whose elements are rows of their own.
 *
 * The two properties, and the division of labour between them:
 *
 *   - **The value property is the value-side half only.** It generates in the
 *     EXTRACTION space — never in the caller's, which is falsifiable by the
 *     generator: a caller's `z.string()` admits `"abc"`, and a string→number
 *     retype fails on it — reverses, and asserts the derived patch parses with
 *     dropped paths absent and every envelope member intact. It cannot catch an
 *     applier that writes a wrong extraction SCHEMA while emitting a
 *     self-consistent mapping.
 *   - **The schema property is the other half.** It renders the derived schema
 *     the way the wire does (`z.toJSONSchema`, draft-2020-12) and asserts the
 *     dropped leaves are absent from what the model would see, the regrouped
 *     structure is really there, and the retyped leaves render their new kind.
 */

const Condition = z.enum(["Good", "Fair", "Poor"]);

const surveySchema = z.object({
  vessel: z.object({
    identification: z.object({
      name: z.string().nullable().optional(),
      buildYear: z.string().nullable().optional(),
    }),
    dimensions: z.object({
      lengthM: z.number().nullable().optional(),
      beamM: z.number().nullable().optional(),
    }),
    notes: z.string().nullable().optional(),
  }),
  engines: z.array(
    z.object({
      make: z.string().nullable().optional(),
      ratingKw: z.string().nullable().optional(),
      serialNumber: z.string().nullable().optional(),
      readings: z.array(
        z.object({
          takenAt: z.string().nullable().optional(),
          mm: z.number().nullable().optional(),
        }),
      ),
    }),
  ),
  inspections: z.object({
    hull: z.object({
      condition: Condition.nullable().optional(),
      lastHauled: z.string().nullable().optional(),
    }),
  }),
});

const shape = deriveExtractionShape(surveySchema, {
  operations: [
    { op: "drop", path: "vessel.notes" },
    { op: "drop", path: "engines.serialNumber" },
    { op: "retype", path: "vessel.identification.buildYear", to: "number" },
    { op: "retype", path: "engines.ratingKw", to: "number" },
    {
      op: "regroup",
      group: "vessel",
      moves: {
        "identification.buildYear": "papers.yearOfBuild",
        "dimensions.lengthM": "dimensions.loa",
      },
    },
    {
      op: "regroup",
      group: "inspections",
      moves: { "hull.lastHauled": "hull.yard.lastHauled" },
    },
  ],
  provenance: { engines: "row", inspections: "none" },
  requiredOnCreate: { engines: ["make"] },
});

/** The codomain's own boundary schema — what the combinator parses reversal's output against. */
const outputSchema = enveloped(shape.patchSchema, {
  provenance: shape.mapping.provenance,
});

test("the value property: everything the extraction space admits reverses into the patch", () => {
  // One run per pool member, so the retype's canonical encoding is exercised on
  // the numbers whose String form is least forgiving: 0, a fraction, a decimal.
  for (const n of [0, 12.5, 125, 1972, 0.001]) {
    const generated = generateShapedValue(shape.extractionSchema, { number: n }) as Record<
      string,
      unknown
    >;
    const reversed = reverseShapedFields(generated, shape.mapping);

    // The derived patch parses — dropped paths absent is part of the parse,
    // because the derived patch does not declare them.
    const parsed = outputSchema.safeParse(reversed);
    expect(
      parsed.success,
      `pool member ${n}: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`,
    ).toBe(true);

    // Dropped paths are absent from the reversed data itself.
    const vessel = reversed.vessel as Record<string, unknown>;
    expect(vessel).not.toHaveProperty("notes");
    const engine = (reversed.engines as unknown[])[0] as Record<string, unknown>;
    expect(engine).not.toHaveProperty("serialNumber");

    // The retype reversed through the pinned encoding — never padded — and the
    // envelope travelled whole: the extraction envelope's confidence and span
    // arrive verbatim at the caller's original path.
    const generatedVessel = generated.vessel as Record<string, Record<string, unknown>>;
    const identification = vessel.identification as Record<string, unknown>;
    expect(identification.buildYear).toEqual({
      value: String(n),
      confidence: (generatedVessel.papers!.yearOfBuild as Record<string, unknown>).confidence,
      sourceSpan: (generatedVessel.papers!.yearOfBuild as Record<string, unknown>).sourceSpan,
    });
    const dimensions = vessel.dimensions as Record<string, unknown>;
    expect(dimensions.lengthM).toEqual({
      value: n,
      confidence: 1,
      sourceSpan: "quote of vessel.dimensions.loa",
    });

    // A row group's citation landed back on the patch's rows — including the
    // nested array's elements, which are rows of their own.
    const generatedEngine = (generated.engines as Record<string, unknown>[])[0]!;
    expect(engine.sourceSpan).toBe(generatedEngine.sourceSpan);
    const reading = (engine.readings as unknown[])[0] as Record<string, unknown>;
    expect(reading.sourceSpan).toBe(
      (generatedEngine.readings as Record<string, unknown>[])[0]!.sourceSpan,
    );
    // A retyped leaf inside the row group reversed as a plain string.
    expect(engine.ratingKw).toBe(String(n));

    // A "none" group carries plain values and no span anywhere — and the
    // regroup reversed back to the caller's paths.
    const inspections = reversed.inspections as Record<string, unknown>;
    const hull = inspections.hull as Record<string, unknown>;
    expect(hull.condition).toBe("Good");
    expect(hull.lastHauled).toBe("value for inspections.hull.yard.lastHauled");
    expect(hull).not.toHaveProperty("yard");
    expect(JSON.stringify(inspections)).not.toContain("sourceSpan");
  }
});

test("the value property holds for an EMPTY collection — the model may answer none", () => {
  const generated = generateShapedValue(shape.extractionSchema, {
    number: 125,
    arrayElements: 0,
  }) as Record<string, unknown>;
  const reversed = reverseShapedFields(generated, shape.mapping);

  // The collection still exists — "there are none" is an answer, not an omission.
  expect(reversed.engines).toEqual([]);
  const parsed = outputSchema.safeParse(reversed);
  expect(parsed.success).toBe(true);
});

test("the schema property: the derived schema the model would see is the derivation's", () => {
  const rendered = z.toJSONSchema(shape.extractionSchema, { target: "draft-2020-12" });
  const text = JSON.stringify(rendered);

  // Dropped leaves are absent from what the model would see.
  expect(text).not.toContain('"notes"');
  expect(text).not.toContain('"serialNumber"');

  // The regrouped structure is really there, at the extraction paths the
  // mapping names.
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const at = (...keys: (string | number)[]): Record<string, unknown> => {
    let node: unknown = rendered;
    for (const key of keys) node = record(node)[key];
    return record(node);
  };
  expect(Object.keys(at("properties", "vessel", "properties", "papers", "properties"))).toEqual([
    "yearOfBuild",
  ]);
  // A moved leaf rehangs at its destination position — after the leaves that
  // did not move, in declaration order.
  expect(Object.keys(at("properties", "vessel", "properties", "dimensions", "properties"))).toEqual(
    ["beamM", "loa"],
  );

  // And the retyped leaves render their new kind — the envelope's value member
  // is the nullable union over it.
  expect(
    at(
      "properties",
      "vessel",
      "properties",
      "papers",
      "properties",
      "yearOfBuild",
      "properties",
      "value",
    ).anyOf,
  ).toEqual([{ type: "number" }, { type: "null" }]);

  // The row group's leaves are PLAIN (no envelope) — the nullable union is the
  // leaf itself, exactly what reversal reads and the patch expects.
  expect(at("properties", "engines", "items", "properties", "ratingKw").anyOf).toEqual([
    { type: "number" },
    { type: "null" },
  ]);
});
