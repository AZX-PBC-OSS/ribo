import { z } from "zod";
import { expect, test } from "vitest";

import { deriveExtractionShape } from "./shape-operations.js";
import type { ShapeOperation } from "./shape-operations.js";
import { stripOptionalNullable } from "@azx/ribo-core";

/**
 * @file STAGE 1 — the operation set and the applier.
 *
 * The applier is the model-free half of the derivation: a caller's schema plus
 * explicit operations in, the derived artifact out — extraction schema, derived
 * patch, mapping, provenance, declarations. These tests pin the operations
 * individually, the composition rule (a set, with collisions refused), and the
 * refusals the derivation owes: a scalar array, a union, a record, a retype
 * whose source kind is outside the closed set, a move that crosses a
 * collection or resurrects a drop, and a declaration naming a leaf the
 * operations removed.
 */

const Condition = z.enum(["Good", "Fair", "Poor"]);

/** A fixture the library has never seen: nested sub-objects, not flat prefixed leaves. */
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
    }),
  ),
});

test("no operations: pure normalization — the identity mapping, the patch, the enveloped schema", () => {
  const shape = deriveExtractionShape(surveySchema);

  // The derived patch is the caller's schema in patch form: same grouping, same
  // kinds, every leaf `.nullable().optional()`, top-level keys optional.
  const patchSample = {
    vessel: { identification: { name: "Alma", buildYear: null }, dimensions: { lengthM: 31 } },
  };
  expect(shape.patchSchema.parse(patchSample)).toEqual(patchSample);
  // And a fully-empty patch parses — every top-level key is optional.
  expect(() => shape.patchSchema.parse({})).not.toThrow();

  // The extraction schema is the shaped schema enveloped.
  expect(
    shape.extractionSchema.parse(
      shape.extractionSchema.parse({
        vessel: {
          identification: {
            name: { value: "Alma", confidence: 1, sourceSpan: "Alma" },
            buildYear: { value: null, confidence: 1, sourceSpan: null },
          },
          dimensions: {
            lengthM: { value: 31, confidence: 1, sourceSpan: null },
            beamM: { value: null, confidence: 1, sourceSpan: null },
          },
          notes: { value: null, confidence: 1, sourceSpan: null },
        },
        engines: [],
      }),
    ),
  ).toBeDefined();

  // The mapping is the identity bijection over the patch's leaves.
  expect(
    Object.entries(shape.mapping.leaves)
      .map(([key, entry]) => `${key}<-${entry.source}`)
      .sort(),
  ).toEqual([
    "engines.make<-engines.make",
    "engines.ratingKw<-engines.ratingKw",
    "engines.serialNumber<-engines.serialNumber",
    "vessel.dimensions.beamM<-vessel.dimensions.beamM",
    "vessel.dimensions.lengthM<-vessel.dimensions.lengthM",
    "vessel.identification.buildYear<-vessel.identification.buildYear",
    "vessel.identification.name<-vessel.identification.name",
    "vessel.notes<-vessel.notes",
  ]);
  expect(shape.mapping.provenance).toEqual({});
});

test("drop: the leaf leaves both schemas and the mapping", () => {
  const shape = deriveExtractionShape(surveySchema, {
    operations: [{ op: "drop", path: "vessel.notes" }],
  });

  expect(shape.patchSchema.shape.vessel).toBeDefined();
  const vesselJson = JSON.stringify(z.toJSONSchema(shape.patchSchema));
  expect(vesselJson).not.toContain('"notes"');
  const extractionJson = JSON.stringify(z.toJSONSchema(shape.extractionSchema));
  expect(extractionJson).not.toContain('"notes"');
  expect(Object.values(shape.mapping.leaves).map((entry) => entry.source)).not.toContain(
    "vessel.notes",
  );
});

test("retype: the extraction leaf is a number, the patch leaf stays a string", () => {
  const shape = deriveExtractionShape(surveySchema, {
    operations: [
      { op: "retype", path: "vessel.identification.buildYear", to: "number" },
      { op: "retype", path: "engines.ratingKw", to: "number" },
    ],
  });

  const extractionJson = JSON.stringify(z.toJSONSchema(shape.extractionSchema));
  // What the model would see: numbers where the retypes were declared...
  expect(extractionJson).toContain('"buildYear"');
  expect(shape.mapping.leaves["vessel.identification.buildYear"]!.retype).toEqual({
    extraction: "number",
    patch: "string",
  });
  // ...and the patch leaf still behaves as the string the caller declared —
  // it accepts null (an unmentioned field reverses to null, and the sentinel
  // acceptance at review depends on that parsing) and refuses a number.
  const vessel = stripOptionalNullable(shape.patchSchema.shape.vessel as z.ZodType) as z.ZodObject;
  const identification = vessel.shape.identification as z.ZodObject;
  const buildYear = identification.shape.buildYear as z.ZodType;
  expect(buildYear.safeParse(null).success).toBe(true);
  expect(buildYear.safeParse("1972").success).toBe(true);
  expect(buildYear.safeParse(1972).success).toBe(false);
});

test("regroup: deepen, flatten and rename within a top-level key", () => {
  const shape = deriveExtractionShape(surveySchema, {
    operations: [
      {
        op: "regroup",
        group: "vessel",
        moves: {
          // Deepen a flat leaf into a new sub-object.
          notes: "surveyor.notes",
          // Rename a nested leaf.
          "identification.buildYear": "identification.yearOfBuild",
        },
      },
    ],
  });

  const extractionJson = JSON.stringify(z.toJSONSchema(shape.extractionSchema));
  expect(extractionJson).toContain('"surveyor"');
  expect(extractionJson).toContain('"yearOfBuild"');

  // The mapping pairs every moved leaf with its caller path.
  expect(shape.mapping.leaves["vessel.surveyor.notes"]!.source).toBe("vessel.notes");
  expect(shape.mapping.leaves["vessel.identification.yearOfBuild"]!.source).toBe(
    "vessel.identification.buildYear",
  );
  // And an untouched leaf stays put.
  expect(shape.mapping.leaves["vessel.identification.name"]!.source).toBe(
    "vessel.identification.name",
  );
});

test("regroup: two moved subtrees may land under one new parent", () => {
  const shape = deriveExtractionShape(surveySchema, {
    operations: [
      {
        // The whole identification subtree moves under `papers` — a rename,
        // and the case two per-leaf moves cannot fake (they would empty the
        // source object, which the applier refuses).
        op: "regroup",
        group: "vessel",
        moves: { identification: "papers" },
      },
    ],
  });

  expect(shape.mapping.leaves["vessel.papers.name"]!.source).toBe("vessel.identification.name");
  expect(shape.mapping.leaves["vessel.papers.buildYear"]!.source).toBe(
    "vessel.identification.buildYear",
  );
});

test("drop a whole group, and keep provenance honest about it", () => {
  const shape = deriveExtractionShape(surveySchema, {
    operations: [{ op: "drop", path: "engines" }],
  });

  expect(shape.patchSchema.shape.engines).toBeUndefined();
  expect(shape.extractionSchema.shape.engines).toBeUndefined();
  expect(shape.mapping.provenance).toEqual({});
});

test("provenance granularity is validated and carried", () => {
  const shape = deriveExtractionShape(surveySchema, {
    operations: [{ op: "drop", path: "vessel.notes" }],
    provenance: { engines: "row" },
  });
  expect(shape.mapping.provenance).toEqual({ engines: "row" });
  expect(shape.provenance).toEqual({ engines: "row" });

  // A granularity naming a dropped group is refused by the derivation.
  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [{ op: "drop", path: "engines" }],
      provenance: { engines: "row" },
    }),
  ).toThrow(/provenance names group "engines"/);
});

test("refusals: the shapes the pipeline cannot serve, named at the path", () => {
  const scalarArray = z.object({ tags: z.array(z.string()).optional() });
  expect(() => deriveExtractionShape(scalarArray)).toThrow(/"tags".*scalar array/);

  const unionLeaf = z.object({ amount: z.union([z.string(), z.number()]).optional() });
  expect(() => deriveExtractionShape(unionLeaf)).toThrow(/unsupported shape at "amount"/);

  const recordLeaf = z.object({ meta: z.record(z.string(), z.unknown()) });
  expect(() => deriveExtractionShape(recordLeaf)).toThrow(/unsupported shape at "meta"/);
});

test("refusals: a retype whose source kind is outside the closed set", () => {
  // A number patch leaf has no retype to make — the closed set is string→number.
  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [{ op: "retype", path: "vessel.dimensions.lengthM", to: "number" }],
    }),
  ).toThrow(/needs a string patch leaf/);
  // An enum cannot retype — no canonical inverse exists for a widened vocabulary.
  const withEnum = z.object({ state: Condition.nullable().optional() });
  expect(() =>
    deriveExtractionShape(withEnum, {
      operations: [{ op: "retype", path: "state", to: "number" }],
    }),
  ).toThrow(/needs a string patch leaf/);
  // And a retype naming a dropped path is refused as not-found.
  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [
        { op: "retype", path: "vessel.notes", to: "number" },
        { op: "drop", path: "vessel.notes" },
      ],
    }),
  ).toThrow(/is not a leaf of the schema/);
});

test("refusals: the composition rule makes ambiguity unreachable", () => {
  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [
        { op: "drop", path: "vessel.notes" },
        { op: "drop", path: "vessel.notes" },
      ],
    }),
  ).toThrow(/names "vessel.notes" twice/);

  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [
        { op: "retype", path: "vessel.identification.buildYear", to: "number" },
        { op: "retype", path: "vessel.identification.buildYear", to: "number" },
      ],
    }),
  ).toThrow(/names "vessel.identification.buildYear" twice/);

  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [
        { op: "regroup", group: "vessel", moves: { notes: "surveyor.notes" } },
        { op: "regroup", group: "vessel", moves: { dimensions: "d" } },
      ],
    }),
  ).toThrow(/names group "vessel" twice/);
});

test("refusals: moves that cross collections, overlap, or resurrect drops", () => {
  const nested = z.object({
    log: z.object({
      periods: z.array(z.object({ bill: z.number().nullable().optional() })),
      name: z.string().nullable().optional(),
    }),
  });
  // A move into a nested array's interior is refused.
  expect(() =>
    deriveExtractionShape(nested, {
      operations: [{ op: "regroup", group: "log", moves: { name: "periods.name" } }],
    }),
  ).toThrow(/may not cross a collection boundary/);
  // And so is a move out of one.
  expect(() =>
    deriveExtractionShape(nested, {
      operations: [{ op: "regroup", group: "log", moves: { "periods.bill": "bill" } }],
    }),
  ).toThrow(/may not cross a collection boundary/);

  // Overlapping sources.
  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [
        {
          op: "regroup",
          group: "vessel",
          moves: { identification: "id", "identification.name": "id.theName" },
        },
      ],
    }),
  ).toThrow(/sources must not overlap/);

  // Destinations, one under the other.
  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [
        {
          op: "regroup",
          group: "vessel",
          moves: { notes: "surveyor", "identification.name": "surveyor.name" },
        },
      ],
    }),
  ).toThrow(/the insert order would decide the shape/);

  // A destination that resurrects a dropped path.
  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [
        { op: "drop", path: "vessel.notes" },
        { op: "regroup", group: "vessel", moves: { "identification.name": "notes.theName" } },
      ],
    }),
  ).toThrow(/may not resurrect or rehang/);
});

test("refusals: a drop that empties an object, and a move that empties one", () => {
  const small = z.object({ only: z.object({ leaf: z.string().nullable().optional() }) });
  expect(() =>
    deriveExtractionShape(small, { operations: [{ op: "drop", path: "only.leaf" }] }),
  ).toThrow(/has no fields left/);
  expect(() =>
    deriveExtractionShape(small, {
      operations: [{ op: "regroup", group: "only", moves: { leaf: "moved.leaf" } }],
    }),
  ).not.toThrow(); // the move re-hangs the leaf under `only`, so nothing empties
});

test("declarations: carried through, and refused when the operations removed what they name", () => {
  const shape = deriveExtractionShape(surveySchema, {
    operations: [{ op: "drop", path: "engines.serialNumber" }],
    requiredOnCreate: { engines: ["make"] },
    identifyingFields: { engines: ["make"] },
  });
  expect(shape.requiredOnCreate).toEqual({ engines: ["make"] });
  expect(shape.identifyingFields).toEqual({ engines: ["make"] });

  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [{ op: "drop", path: "engines.serialNumber" }],
      requiredOnCreate: { engines: ["serialNumber"] },
    }),
  ).toThrow(/does not carry/);

  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [{ op: "drop", path: "engines" }],
      requiredOnCreate: { engines: ["make"] },
    }),
  ).toThrow(/is not a group of the derived patch/);
});

test("collection-ness is preserved: a collection group stays one on both sides", () => {
  const shape = deriveExtractionShape(surveySchema, { provenance: { engines: "row" } });
  expect(stripOptionalNullable(shape.patchSchema.shape.engines as z.ZodType)).toBeInstanceOf(
    z.ZodArray,
  );
  expect(stripOptionalNullable(shape.extractionSchema.shape.engines as z.ZodType)).toBeInstanceOf(
    z.ZodArray,
  );
  // And the extraction side's element carries the row span.
  const extractionJson = JSON.stringify(z.toJSONSchema(shape.extractionSchema));
  expect(extractionJson).toContain('"sourceSpan"');
});

test("strictness is preserved on the derived patch", () => {
  const looseCaller = z.looseObject({ name: z.string().nullable().optional() });
  const loose = deriveExtractionShape(looseCaller);
  // A loose caller's patch keeps unknown keys, a plain one strips them...
  expect(loose.patchSchema.parse({ name: "x", stray: 1 })).toEqual({ name: "x", stray: 1 });

  const plainCaller = z.object({ name: z.string().nullable().optional() });
  const plain = deriveExtractionShape(plainCaller);
  expect(plain.patchSchema.parse({ name: "x", stray: 1 })).toEqual({ name: "x" });

  // ...and a strict one refuses them.
  const strictCaller = z.object({ name: z.string().nullable().optional() }).strict();
  const strict = deriveExtractionShape(strictCaller);
  expect(() => strict.patchSchema.parse({ name: "x", stray: 1 })).toThrow();
});

test("the retype keeps the leaf's description on the new kind", () => {
  const described = z.object({
    year: z.string().describe("Year of build, as stated.").nullable().optional(),
  });
  const shape = deriveExtractionShape(described, {
    operations: [{ op: "retype", path: "year", to: "number" }],
  });
  const extractionJson = JSON.stringify(z.toJSONSchema(shape.extractionSchema));
  expect(extractionJson).toContain("Year of build, as stated.");
});

test("an operation path with instance-key brackets is refused", () => {
  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [{ op: "drop", path: "engines[k1].make" }],
    }),
  ).toThrow(/not a plain dotted object path/);
});

test("a retype and a move compose on the same leaf", () => {
  const shape: ReturnType<typeof deriveExtractionShape> = deriveExtractionShape(surveySchema, {
    operations: [
      { op: "retype", path: "vessel.identification.buildYear", to: "number" },
      {
        op: "regroup",
        group: "vessel",
        moves: { "identification.buildYear": "papers.yearOfBuild" },
      },
    ],
  });
  expect(shape.mapping.leaves["vessel.papers.yearOfBuild"]).toEqual({
    source: "vessel.identification.buildYear",
    retype: { extraction: "number", patch: "string" },
  });
});

test("the operations type is a discriminated union a caller can switch on", () => {
  const ops: ShapeOperation[] = [
    { op: "drop", path: "vessel.notes" },
    { op: "retype", path: "engines.ratingKw", to: "number" },
    { op: "regroup", group: "vessel", moves: { notes: "surveyor.notes" } },
  ];
  for (const operation of ops) {
    if (operation.op === "drop") expect(operation.path).toBeTruthy();
    if (operation.op === "retype") expect(operation.to).toBe("number");
    if (operation.op === "regroup") expect(Object.keys(operation.moves)).toBeTruthy();
  }
});
