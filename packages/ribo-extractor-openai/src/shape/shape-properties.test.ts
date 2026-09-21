import { enveloped } from "@azx/ribo-core";
import { z } from "zod";
import { expect, test } from "vitest";

import { deriveExtractionShape } from "./shape-operations.js";
import { assertShapeMapping, retypeToPatchValue } from "./shape-mapping.js";
import type { ShapeMapping } from "./shape-mapping.js";
import { generateShapedValue } from "./shape-generate.js";
import { reverseShapedFields } from "./shape-reverse.js";
import type { ProvenanceGranularity } from "@azx/ribo-core";

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
 *     dropped paths absent and every envelope member intact. The pairing is
 *     asserted EXHAUSTIVELY, one check per mapping entry (`expectFaithfulReverse`),
 *     not at hand-picked leaves: a hand-picked set is exactly what a consistent
 *     wrong permutation slips between. It cannot catch an applier that writes a
 *     wrong extraction SCHEMA while emitting a self-consistent mapping.
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

const readChild = (node: unknown, key: string): unknown =>
  typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined;

/**
 * Every leaf instance a path walk reaches, keyed by the array indices crossed,
 * in order. Schema-time paths are element-relative and reversal distributes the
 * same array crossings on both sides of an entry, so the index keys pair up.
 * An array may sit anywhere along the path — including at the top, for a
 * collection group — so an array node distributes before its next segment.
 */
const collectLeafInstances = (
  node: unknown,
  rest: readonly string[],
  indices: readonly number[],
  out: Map<string, unknown>,
): void => {
  if (Array.isArray(node)) {
    node.forEach((element, i) => collectLeafInstances(element, rest, [...indices, i], out));
    return;
  }
  if (rest.length === 0) {
    out.set(indices.join("."), node);
    return;
  }
  collectLeafInstances(readChild(node, rest[0]!), rest.slice(1), indices, out);
};

/**
 * The exhaustive pairing property: for EVERY entry in the mapping, the reversed
 * value at `source` equals the generated value at the entry's extraction path —
 * value (retyped when the entry says so), and, under `"leaf"` provenance,
 * `confidence` and `sourceSpan` verbatim. The mapping enumerates the pairs, so
 * nothing here is hand-picked; a five-leaf spot check is exactly what a
 * consistent wrong permutation slips between.
 *
 * This is a property of reversal RELATIVE TO the mapping. It is deliberately
 * also run against the swapped hand-written mapping below, where it passes:
 * faithful reversal satisfies it for any bijective mapping, right or wrong. The
 * pairing itself is only wrong when set against the intended pairing — see the
 * typo test.
 */
const expectFaithfulReverse = (
  generated: Record<string, unknown>,
  reversed: Record<string, unknown>,
  mapping: ShapeMapping,
): void => {
  for (const [extractionPath, entry] of Object.entries(mapping.leaves)) {
    const top = extractionPath.split(".")[0]!;
    const granularity: ProvenanceGranularity = mapping.provenance[top] ?? "leaf";
    const atGenerated: Map<string, unknown> = new Map();
    collectLeafInstances(generated[top], extractionPath.split(".").slice(1), [], atGenerated);
    const atReversed: Map<string, unknown> = new Map();
    collectLeafInstances(reversed[top], entry.source.split(".").slice(1), [], atReversed);
    for (const [indices, gValue] of atGenerated) {
      const where =
        `the entry "${extractionPath}" <- "${entry.source}"` +
        (indices === "" ? "" : ` [element ${indices}]`);
      expect(
        atReversed.has(indices),
        `${where}: no reversed value — the extraction data carries ${String(atGenerated.size)} ` +
          `instance(s) at this leaf, the reversed data ${String(atReversed.size)}`,
      ).toBe(true);
      const rValue = atReversed.get(indices);
      if (granularity === "leaf") {
        const envelope = gValue as Record<string, unknown>;
        expect(rValue, where).toEqual({
          value:
            entry.retype === undefined
              ? envelope.value
              : retypeToPatchValue(envelope.value as number | null),
          confidence: envelope.confidence,
          sourceSpan: envelope.sourceSpan,
        });
      } else {
        expect(rValue, where).toEqual(
          entry.retype === undefined ? gValue : retypeToPatchValue(gValue as number | null),
        );
      }
    }
  }
};

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

    // THE pairing property, exhaustive: for every mapping entry, the reversed
    // value at `source` is the generated value at the entry's extraction path —
    // retyped when the entry says so, with `confidence` and `sourceSpan`
    // travelling verbatim under "leaf" provenance. This one call replaces the
    // hand-picked leaf checks the property used to make; a consistent wrong
    // permutation cannot slip between five spot checks when every entry is
    // checked.
    expectFaithfulReverse(generated, reversed, shape.mapping);

    // A row group's citation landed back on the patch's rows — including the
    // nested array's elements, which are rows of their own. (Span placement is
    // a structural rule of reversal, not a mapping pairing — pinned at one top
    // level element and one nested element.)
    const generatedEngine = (generated.engines as Record<string, unknown>[])[0]!;
    expect(engine.sourceSpan).toBe(generatedEngine.sourceSpan);
    const reading = (engine.readings as unknown[])[0] as Record<string, unknown>;
    expect(reading.sourceSpan).toBe(
      (generatedEngine.readings as Record<string, unknown>[])[0]!.sourceSpan,
    );

    // A "none" group carries plain values and no span anywhere.
    const inspections = reversed.inspections as Record<string, unknown>;
    const hull = inspections.hull as Record<string, unknown>;
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

test("a hand-written mapping with two sources swapped passes construction — the pairing only fails against the intended pairing", () => {
  // The reproduced counterexample: a source typo that swaps two same-kind
  // string leaves of one array element. Both paths are real, the
  // correspondence is bijective, kinds and array paths agree — so it passes
  // every construction-time check, and reversal is FAITHFUL to it: each
  // envelope is written, whole, at the leaf the mapping declares. The result
  // parses, and review would render a confident, verbatim-span, grounded
  // envelope on the wrong leaf with no signal that anything is off.
  const leaf = z.string().nullable().optional();
  const patchSchema = z.object({
    g: z.object({ arr: z.array(z.object({ f1: leaf, f2: leaf })) }),
  });
  const extractionSchema = enveloped(patchSchema, { provenance: {} });
  const swapped: ShapeMapping = {
    leaves: {
      "g.arr.f1": { source: "g.arr.f2" },
      "g.arr.f2": { source: "g.arr.f1" },
    },
    provenance: {},
  };
  const intended: ShapeMapping = {
    leaves: {
      "g.arr.f1": { source: "g.arr.f1" },
      "g.arr.f2": { source: "g.arr.f2" },
    },
    provenance: {},
  };

  // Pinned: construction accepts it. assertShapeMapping checks existence and
  // bijectivity, never the pairing — a same-kind swap is indistinguishable at
  // construction from an intended regroup, because the mapping is the only
  // carrier of that intent. See shape-mapping.ts's header.
  expect(() => assertShapeMapping(swapped, extractionSchema, patchSchema)).not.toThrow();

  const generated = generateShapedValue(extractionSchema) as Record<string, unknown>;
  const reversed = reverseShapedFields(generated, swapped);

  // Pinned: the output parses — the auditor has no signal from the data alone.
  const typoOutput = enveloped(patchSchema, { provenance: {} });
  const parsed = typoOutput.safeParse(reversed);
  expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);

  // Pinned: the exhaustive property HOLDS for the swap — it is a property of
  // reversal relative to the mapping, and reversal is faithful to any bijective
  // mapping, right or wrong.
  expect(() => expectFaithfulReverse(generated, reversed, swapped)).not.toThrow();

  // The pairing fails only against the INTENDED pairing — the one thing a
  // hand-written mapping carries nowhere. That is the gap this suite documents:
  // neither construction nor any mapping-relative property can catch it.
  expect(() => expectFaithfulReverse(generated, reversed, intended)).toThrowError(
    /the entry "g\.arr\.f1" <- "g\.arr\.f1"/,
  );
});

test("the exhaustive property has teeth: one corrupted leaf fails it, naming the entry", () => {
  const generated = generateShapedValue(shape.extractionSchema) as Record<string, unknown>;
  const reversed = reverseShapedFields(generated, shape.mapping);

  // Corrupt one leaf reversal wrote — the boat name's envelope — the way a
  // broken reversal would: value replaced, confidence and span gone.
  const vessel = reversed.vessel as Record<string, unknown>;
  const identification = vessel.identification as Record<string, unknown>;
  identification.name = { value: "corrupted", confidence: 0, sourceSpan: null };

  expect(() => expectFaithfulReverse(generated, reversed, shape.mapping)).toThrowError(
    /the entry "vessel\.identification\.name" <- "vessel\.identification\.name"/,
  );
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
