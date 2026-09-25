import { z } from "zod";
import { expect, test } from "vitest";

import { deriveExtractionShape } from "./shape-operations.js";
import type { ShapeOperation } from "./shape-operation.js";
import { reverseShapedFields } from "./shape-reverse.js";
import { splitExtractionSchema } from "../schema/split-schema.js";
import { stripOptionalNullable } from "../../provenance/field-path.js";

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

  // Two moves to the SAME destination: isPrefixOf says equal arrays prefix one
  // another, so without an independent same-destination check the error would
  // blame the prefix rule. The rule is its own line in shape-operation.ts's
  // header and rejected with its own message — listing both moves and the
  // destination collision — so the schema author can see the failure is not
  // about ordering but about ambiguous ownership of the destination.
  expect(() =>
    deriveExtractionShape(surveySchema, {
      operations: [
        {
          op: "regroup",
          group: "vessel",
          moves: {
            "identification.name": "papers.name",
            "dimensions.lengthM": "papers.name",
          },
        },
      ],
    }),
  ).toThrow(/moves "identification\.name" and "dimensions\.lengthM" to the same destination/);

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
    { op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } },
  ];
  for (const operation of ops) {
    if (operation.op === "drop") expect(operation.path).toBeTruthy();
    if (operation.op === "retype") expect(operation.to).toBe("number");
    if (operation.op === "regroup") expect(Object.keys(operation.moves)).toBeTruthy();
    if (operation.op === "nest") expect(Object.keys(operation.moves)).toBeTruthy();
  }
});

/** A flat schema — the shape spike 0009 probed: every leaf at the root, no groups. */
const flatSchema = z.object({
  yearBuilt: z.string().describe("Year the home was constructed.").nullable().optional(),
  squareMeters: z.number().nullable().optional(),
  heatingType: z.enum(["gas", "oil", "electric"]).nullable().optional(),
  hasGarage: z.boolean().nullable().optional(),
});

/** One real group and one collection beside the flat leaves, for collisions and bad sources. */
const mixedSchema = z.object({
  client: z.object({
    name: z.string().nullable().optional(),
  }),
  systems: z.array(z.object({ fuel: z.string().nullable().optional() })),
  yearBuilt: z.string().nullable().optional(),
  squareMeters: z.number().nullable().optional(),
});

test("nest: top-level leaves move under a new group; the patch schema is unchanged", () => {
  const shape = deriveExtractionShape(flatSchema, {
    operations: [
      {
        op: "nest",
        group: "construction",
        moves: { yearBuilt: "yearBuilt", squareMeters: "area.squareMeters" },
      },
    ],
  });

  // The patch is byte-identical to an unshaped derivation's — review and the
  // write see the caller's own flat shape.
  const unshaped = deriveExtractionShape(flatSchema);
  expect(JSON.stringify(z.toJSONSchema(shape.patchSchema))).toBe(
    JSON.stringify(z.toJSONSchema(unshaped.patchSchema)),
  );

  // The extraction schema carries the new group with the moved leaves under it.
  expect(Object.keys(shape.extractionSchema.shape).sort()).toEqual([
    "construction",
    "hasGarage",
    "heatingType",
  ]);
  const construction = stripOptionalNullable(
    shape.extractionSchema.shape.construction as z.ZodType,
  ) as z.ZodObject;
  expect(construction).toBeInstanceOf(z.ZodObject);
  expect(Object.keys(construction.shape)).toEqual(["yearBuilt", "area"]);

  // The mapping pairs every moved leaf with its original top-level path.
  expect(shape.mapping.leaves["construction.yearBuilt"]!.source).toBe("yearBuilt");
  expect(shape.mapping.leaves["construction.area.squareMeters"]!.source).toBe("squareMeters");
  // The unmoved leaves stay at the top level of both spaces.
  expect(shape.mapping.leaves["heatingType"]!.source).toBe("heatingType");
  expect(shape.mapping.leaves["hasGarage"]!.source).toBe("hasGarage");

  // Descriptions survive the move.
  const extractionJson = JSON.stringify(z.toJSONSchema(shape.extractionSchema));
  expect(extractionJson).toContain("Year the home was constructed.");
});

test("a nest and a retype compose on the same leaf", () => {
  const shape = deriveExtractionShape(flatSchema, {
    operations: [
      { op: "retype", path: "yearBuilt", to: "number" },
      { op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } },
    ],
  });
  expect(shape.mapping.leaves["construction.yearBuilt"]).toEqual({
    source: "yearBuilt",
    retype: { extraction: "number", patch: "string" },
  });
});

test("two nests create two groups from one flat schema, leaving a leaf at top level", () => {
  const shape = deriveExtractionShape(flatSchema, {
    operations: [
      { op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } },
      { op: "nest", group: "amenities", moves: { hasGarage: "hasGarage" } },
    ],
  });
  expect(Object.keys(shape.extractionSchema.shape).sort()).toEqual([
    "amenities",
    "construction",
    "heatingType",
    "squareMeters",
  ]);
  expect(shape.mapping.leaves["construction.yearBuilt"]!.source).toBe("yearBuilt");
  expect(shape.mapping.leaves["amenities.hasGarage"]!.source).toBe("hasGarage");
  expect(shape.mapping.leaves["squareMeters"]!.source).toBe("squareMeters");
});

test("a nest that moves every top-level leaf succeeds — the shaped root holds the new groups", () => {
  // `refuseEmptyObjects` must not fire: the root is not empty, it holds the
  // new groups.
  const shape = deriveExtractionShape(flatSchema, {
    operations: [
      {
        op: "nest",
        group: "construction",
        moves: { yearBuilt: "yearBuilt", squareMeters: "squareMeters" },
      },
      {
        op: "nest",
        group: "amenities",
        moves: { heatingType: "heatingType", hasGarage: "hasGarage" },
      },
    ],
  });
  expect(Object.keys(shape.extractionSchema.shape).sort()).toEqual(["amenities", "construction"]);
});

test("a nested leaf reverses to its original top-level patch path — value, confidence and sourceSpan verbatim", () => {
  const shape = deriveExtractionShape(flatSchema, {
    operations: [{ op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } }],
  });
  const reversed = reverseShapedFields(
    {
      construction: {
        yearBuilt: { value: "1972", confidence: 0.9, sourceSpan: "built in seventy-two" },
      },
      squareMeters: { value: 210, confidence: 0.8, sourceSpan: "two ten" },
      heatingType: { value: "gas", confidence: 0.7, sourceSpan: "gas heat" },
      hasGarage: { value: true, confidence: 1, sourceSpan: "a garage" },
    },
    shape.mapping,
  );
  expect(reversed.yearBuilt).toEqual({
    value: "1972",
    confidence: 0.9,
    sourceSpan: "built in seventy-two",
  });
  // Nothing is written under the synthetic group — it exists only in the
  // extraction space.
  expect(reversed).not.toHaveProperty("construction");
  // The unmoved leaves reverse as themselves.
  expect(reversed.squareMeters).toEqual({ value: 210, confidence: 0.8, sourceSpan: "two ten" });
});

test("the payoff: splitExtractionSchema groups a nest-derived extraction schema by the new group", () => {
  // Nesting gives the split something to split on: the new group becomes its
  // own call with its own prompt assembly, instead of one flat request.
  const shape = deriveExtractionShape(mixedSchema, {
    operations: [
      {
        op: "nest",
        group: "construction",
        moves: { yearBuilt: "yearBuilt", squareMeters: "squareMeters" },
      },
    ],
  });
  const groups = splitExtractionSchema(shape.extractionSchema);
  expect(groups.map((group) => group.key).sort()).toEqual(["client", "construction", "systems"]);
});

test("the payoff is unconditional: one unmoved top-level leaf rides the loose piece", () => {
  // ADR 0022 pinned the limit: the split's gate was `everyKeyIsGroup`, so a
  // nest group earned its own call only when the nests covered every top-level
  // key. ADR 0023 lifts it: a partially nested schema splits into one entry
  // per group plus the unmoved leaves as the unwrapped portion, keyed "".
  const shape = deriveExtractionShape(mixedSchema, {
    operations: [
      // `squareMeters` is deliberately left at the top level.
      { op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } },
    ],
  });
  expect(Object.keys(shape.extractionSchema.shape)).toContain("construction");
  const groups = splitExtractionSchema(shape.extractionSchema);
  // Groups first in declaration order, the loose piece last, carrying exactly
  // the unmoved leaf.
  expect(groups.map((group) => group.key)).toEqual(["client", "systems", "construction", ""]);
  expect(Object.keys((groups.at(-1)!.schema as z.ZodObject).shape)).toEqual(["squareMeters"]);
});

test("a partially nested schema whose nest group exceeds a cap splits — the group partitions, the loose leaf rides", () => {
  // The sharp end of ADR 0022's conditional payoff, and the reason it called
  // the mixed-schema splitter work the immediate next piece: the flat fallback
  // partitioned over top-level keys and treated each as ATOMIC, so a top-level
  // key that was itself an oversized GROUP had nowhere to go. Measured on the
  // live vendor proposal: the flat schema split into 38 pieces, the same
  // schema carrying the model's nests would not split at all. ADR 0023 is
  // that work: the oversized group partitions within itself exactly as it does
  // on the all-group path, and the loose leaf packs as the unwrapped portion.
  const leaf = (description: string) => z.string().describe(description).nullable().optional();
  const wide: Record<string, z.ZodType> = { loose: leaf("a top-level leaf no nest moves") };
  for (let i = 0; i < 24; i++)
    wide[`f${i}`] = leaf(`Field number ${i}, with prose to spend bytes.`);

  const shape = deriveExtractionShape(z.object(wide), {
    operations: [
      {
        op: "nest",
        group: "wide",
        moves: Object.fromEntries(
          Object.keys(wide)
            .filter((key) => key !== "loose")
            .map((key) => [key, key]),
        ),
      },
    ],
  });
  const split = splitExtractionSchema(shape.extractionSchema, {
    maxNullableUnionsPerGroup: 16,
    maxSerializedCharsPerGroup: 19_000,
  });
  // The oversized group partitions within itself — 24 enveloped leaves is 48
  // unions against a cap of 16 — and the loose leaf rides one "" piece last.
  expect(split.filter((piece) => piece.key === "wide").length).toBeGreaterThan(1);
  expect(split.at(-1)!.key).toBe("");
  expect(Object.keys((split.at(-1)!.schema as z.ZodObject).shape)).toEqual(["loose"]);

  // Nest the leftover leaf too and every top-level key is a group, so the
  // per-group path partitions the oversized group within itself.
  const total = deriveExtractionShape(z.object(wide), {
    operations: [
      {
        op: "nest",
        group: "wide",
        moves: Object.fromEntries(
          Object.keys(wide)
            .filter((key) => key !== "loose")
            .map((key) => [key, key]),
        ),
      },
      { op: "nest", group: "rest", moves: { loose: "loose" } },
    ],
  });
  const pieces = splitExtractionSchema(total.extractionSchema, {
    maxNullableUnionsPerGroup: 16,
    maxSerializedCharsPerGroup: 19_000,
  });
  expect(pieces.filter((piece) => piece.key === "wide").length).toBeGreaterThan(1);
});

test("refusals: a nest group collides with a surviving top-level key, or resurrects a dropped one", () => {
  expect(() =>
    deriveExtractionShape(mixedSchema, {
      operations: [{ op: "nest", group: "client", moves: { yearBuilt: "yearBuilt" } }],
    }),
  ).toThrow(/nest names group "client", which is already a top-level key/);

  // A name the caller deliberately removed reappearing as a synthetic group is
  // confusing at review — refused on the same ground as regroup's
  // no-resurrection rule.
  expect(() =>
    deriveExtractionShape(flatSchema, {
      operations: [
        { op: "drop", path: "hasGarage" },
        { op: "nest", group: "hasGarage", moves: { yearBuilt: "yearBuilt" } },
      ],
    }),
  ).toThrow(/nest names group "hasGarage", which a drop removed/);
});

test("a nest group may take a name some nest frees — its own anchor leaf, or another nest's source", () => {
  // The rule `regroup` already follows for destinations: a name freed by the
  // removal is legal. A live proposer run is why — the model names a group
  // after the leaf that anchors it.
  const anchored = deriveExtractionShape(mixedSchema, {
    operations: [
      // `yearBuilt` is both the group's name and one of its own sources.
      { op: "nest", group: "yearBuilt", moves: { yearBuilt: "stated", squareMeters: "area" } },
    ],
  });
  expect(Object.keys(anchored.extractionSchema.shape)).toContain("yearBuilt");
  expect(anchored.mapping.leaves["yearBuilt.stated"]!.source).toBe("yearBuilt");
  expect(anchored.mapping.leaves["yearBuilt.area"]!.source).toBe("squareMeters");
  // The patch is untouched: both leaves stay flat where the caller declared them.
  expect(Object.keys(anchored.patchSchema.shape).sort()).toEqual(
    Object.keys(mixedSchema.shape).sort(),
  );

  // And across two nests — which is why the applier detaches every source
  // before creating any group.
  const across = deriveExtractionShape(mixedSchema, {
    operations: [
      { op: "nest", group: "construction", moves: { yearBuilt: "built" } },
      { op: "nest", group: "yearBuilt", moves: { squareMeters: "sm" } },
    ],
  });
  expect(across.mapping.leaves["construction.built"]!.source).toBe("yearBuilt");
  expect(across.mapping.leaves["yearBuilt.sm"]!.source).toBe("squareMeters");
});

test("the nest set is order-independent: the same operations in either order derive the same shape", () => {
  // The applier owns the ordering. Reversing the operations array must not
  // change the result, or the "operations are a SET" rule would be a fiction —
  // and a group taking a freed name is exactly where a one-nest-at-a-time
  // applier would become order-sensitive.
  const ops: ShapeOperation[] = [
    { op: "nest", group: "construction", moves: { yearBuilt: "built" } },
    { op: "nest", group: "yearBuilt", moves: { squareMeters: "sm" } },
  ];
  const forward = deriveExtractionShape(mixedSchema, { operations: ops });
  const reverse = deriveExtractionShape(mixedSchema, { operations: [...ops].reverse() });
  expect(Object.keys(forward.extractionSchema.shape).sort()).toEqual(
    Object.keys(reverse.extractionSchema.shape).sort(),
  );
  expect(forward.mapping.leaves).toEqual(reverse.mapping.leaves);
});

test("refusals: a nest group shadowing a top-level key that SURVIVES is refused", () => {
  // The freed-name allowance is exactly that: freed. `client` is a group no
  // nest moves, so a nest group by that name would be two things at one path.
  expect(() =>
    deriveExtractionShape(mixedSchema, {
      operations: [{ op: "nest", group: "client", moves: { yearBuilt: "built" } }],
    }),
  ).toThrow(
    /nest names group "client", which is already a top-level key of the schema and stays one/,
  );
});

test("refusals: duplicate nests and doubly-moved sources are refused at bucketing", () => {
  expect(() =>
    deriveExtractionShape(flatSchema, {
      operations: [
        { op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } },
        { op: "nest", group: "construction", moves: { squareMeters: "squareMeters" } },
      ],
    }),
  ).toThrow(/nest names group "construction" twice/);

  expect(() =>
    deriveExtractionShape(flatSchema, {
      operations: [
        { op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } },
        { op: "nest", group: "location", moves: { yearBuilt: "yearBuilt" } },
      ],
    }),
  ).toThrow(/nests "construction" and "location" both move "yearBuilt"/);
});

test("refusals: an empty moves record — a nest creates its target, so there is nothing to create it from", () => {
  // A `regroup` with no moves is a silent no-op; a `nest` cannot inherit that,
  // because the group it names exists only if a move puts something in it.
  // Without its own refusal this would surface from `refuseEmptyObjects` as
  // "the object at … has no fields left", naming the wrong thing.
  expect(() =>
    deriveExtractionShape(flatSchema, {
      operations: [{ op: "nest", group: "construction", moves: {} }],
    }),
  ).toThrow(/nest names group "construction" with an empty moves record/);
});

test("refusals: a nest source must be a top-level leaf — not a group, a collection, a nested path, or nothing", () => {
  // An object group.
  expect(() =>
    deriveExtractionShape(mixedSchema, {
      operations: [{ op: "nest", group: "meta", moves: { client: "client" } }],
    }),
  ).toThrow(/nest on "meta" moves "client", which is a group, not a top-level leaf/);
  // A collection.
  expect(() =>
    deriveExtractionShape(mixedSchema, {
      operations: [{ op: "nest", group: "meta", moves: { systems: "systems" } }],
    }),
  ).toThrow(/nest on "meta" moves "systems", which is a collection, not a top-level leaf/);
  // A nested (multi-segment) path.
  expect(() =>
    deriveExtractionShape(mixedSchema, {
      operations: [{ op: "nest", group: "meta", moves: { "client.name": "name" } }],
    }),
  ).toThrow(/nest on "meta" moves "client\.name" — a nest source is one segment/);
  // Nothing at all.
  expect(() =>
    deriveExtractionShape(mixedSchema, {
      operations: [{ op: "nest", group: "meta", moves: { nope: "nope" } }],
    }),
  ).toThrow(/nest on "meta" moves "nope", which is not a top-level leaf of the schema/);
  // A path a drop removed.
  expect(() =>
    deriveExtractionShape(mixedSchema, {
      operations: [
        { op: "drop", path: "yearBuilt" },
        { op: "nest", group: "meta", moves: { yearBuilt: "yearBuilt" } },
      ],
    }),
  ).toThrow(/nest on "meta" moves "yearBuilt", which is not a top-level leaf of the schema/);
});

test("refusals: a nest group name must be a usable top-level object key", () => {
  for (const group of ["", "7", "a.b", "a[0]"]) {
    expect(() =>
      deriveExtractionShape(flatSchema, {
        operations: [{ op: "nest", group, moves: { yearBuilt: "yearBuilt" } }],
      }),
    ).toThrow(/nest names group .* which is not a usable top-level object key/);
  }
});

test("refusals: nest destinations are non-empty, pairwise distinct, and none prefixes another", () => {
  expect(() =>
    deriveExtractionShape(flatSchema, {
      operations: [{ op: "nest", group: "construction", moves: { yearBuilt: "" } }],
    }),
  ).toThrow(/nest on "construction" moves "yearBuilt" to an empty destination/);

  expect(() =>
    deriveExtractionShape(flatSchema, {
      operations: [
        {
          op: "nest",
          group: "construction",
          moves: { yearBuilt: "a", squareMeters: "a" },
        },
      ],
    }),
  ).toThrow(/moves "yearBuilt" and "squareMeters" to the same destination/);

  expect(() =>
    deriveExtractionShape(flatSchema, {
      operations: [
        {
          op: "nest",
          group: "construction",
          moves: { yearBuilt: "a", squareMeters: "a.b" },
        },
      ],
    }),
  ).toThrow(/to destinations, one under the other/);
});

test("refusals: provenance may not name a nest group — it exists in the extraction schema only", () => {
  // `mapping.provenance` is applied to BOTH schemas (the extraction schema at
  // derivation, the patch at the combinator's construction), and a nest group
  // exists in only one. Tested at "row" AND "none": an implementation that
  // special-cases "row" would pass the first alone.
  expect(() =>
    deriveExtractionShape(flatSchema, {
      operations: [{ op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } }],
      provenance: { construction: "row" },
    }),
  ).toThrow(/provenance names group "construction", which a nest creates/);
  expect(() =>
    deriveExtractionShape(flatSchema, {
      operations: [{ op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } }],
      provenance: { construction: "none" },
    }),
  ).toThrow(/provenance names group "construction", which a nest creates/);
});

test("refusals: provenance may not name a leaf a nest moved away", () => {
  // "none" is the only non-default granularity a top-level leaf can legally
  // carry; nesting the leaf forces the caller to remove the declaration, and
  // the refusal names both the key and why it vanished.
  expect(() =>
    deriveExtractionShape(flatSchema, {
      operations: [{ op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } }],
      provenance: { yearBuilt: "none" },
    }),
  ).toThrow(/provenance names group "yearBuilt".*moved into a nest group/);
});
