import { expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "../../provenance/enveloped.js";
import type { ProvenanceGranularity } from "../../provenance/enveloped.js";
import { isExtractedSchema } from "../../provenance/provenance.js";
import { SCHEMA_PLAN_CONTRACT_VERSION } from "../schema-plan.js";
import type { SchemaPlan, SchemaPlanPiece } from "../schema-plan.js";
import type { ExtractionTarget } from "../extractor.js";

import { projectPlannedTargets } from "./planned-projection.js";

const provenance = {
  model: "stub-model",
  backend: "stub-backend",
  createdAt: "2026-09-21T12:00:00.000Z",
};

const makePlan = (pieces: readonly SchemaPlanPiece[]): SchemaPlan => ({
  version: SCHEMA_PLAN_CONTRACT_VERSION,
  schemaFingerprint: "a".repeat(64),
  fieldPaths: pieces.flatMap((piece) => piece.paths),
  pieces: [...pieces],
  provenance,
});

const piece = (name: string, key: string, paths: readonly string[]): SchemaPlanPiece => ({
  name,
  description: `${name} description.`,
  key,
  paths: [...paths],
});

const makeTarget = (
  extractionSchema: z.ZodType,
  fields?: Record<string, unknown>,
): ExtractionTarget<Record<string, unknown>> =>
  ({
    name: "planned",
    extractionSchema,
    instructions: "Extract the planned fields.",
    examples: fields === undefined ? [] : [{ transcript: "example transcript", fields }],
  }) as unknown as ExtractionTarget<Record<string, unknown>>;

const envelope = (value: unknown, span = "quoted text") => ({
  value,
  confidence: 0.75,
  sourceSpan: span,
});

const schemaAt = (schema: z.ZodType, path: string): z.ZodType => {
  let current = schema;
  for (const segment of path.split(".")) {
    while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodType;
    }
    if (current instanceof z.ZodArray) current = current.element as z.ZodType;
    current = (current as z.ZodObject).shape[segment] as z.ZodType;
  }
  return current;
};

const objectShape = (schema: z.ZodType, path: string): Record<string, z.ZodType> => {
  let current = schemaAt(schema, path);
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current.unwrap() as z.ZodType;
  }
  if (current instanceof z.ZodArray) current = current.element as z.ZodType;
  return (current as z.ZodObject).shape;
};

const exampleFields = (
  projections: ReturnType<typeof projectPlannedTargets>,
  index: number,
): Record<string, unknown> => projections[index]!.target.examples![0]!.fields;

test("nested singleton and collection-element projection retains real leaves, arrays, descriptions and examples", () => {
  const values = z.object({
    building: z.object({
      details: z.object({
        year: z.number().describe("Construction year").nullable().optional(),
        color: z.string().nullable().optional(),
      }),
    }),
    systems: z.array(
      z.object({
        components: z.array(
          z.object({
            name: z.string().describe("Component name").nullable().optional(),
            serial: z.string().nullable().optional(),
          }),
        ),
      }),
    ),
  });
  const schema = enveloped(values);
  const plan = makePlan([
    piece("construction", "building", ["building.details.year"]),
    piece("finish", "building", ["building.details.color"]),
    piece("component names", "systems", ["systems.components.name"]),
    piece("component serials", "systems", ["systems.components.serial"]),
  ]);
  const fields = {
    building: {
      details: { year: envelope(1984, "built in 1984"), color: envelope("red") },
    },
    systems: [
      {
        components: [
          { name: envelope("boiler"), serial: envelope("A-1") },
          { name: envelope("pump"), serial: envelope("B-2") },
        ],
      },
    ],
  };

  const projections = projectPlannedTargets(makeTarget(schema, fields), plan);
  const construction = projections[0]!.target;
  const names = projections[2]!.target;

  expect(Object.keys(objectShape(construction.extractionSchema, "building"))).toEqual(["details"]);
  expect(Object.keys(objectShape(construction.extractionSchema, "building.details"))).toEqual([
    "year",
  ]);
  expect(schemaAt(construction.extractionSchema, "building.details.year")).toBe(
    schemaAt(schema, "building.details.year"),
  );
  expect(schemaAt(construction.extractionSchema, "building.details.year").description).toBe(
    schemaAt(schema, "building.details.year").description,
  );
  expect(
    schemaAt(construction.extractionSchema, "building.details.year").safeParse({
      value: null,
      confidence: 0.5,
      sourceSpan: null,
    }).success,
  ).toBe(true);

  expect(schemaAt(names.extractionSchema, "systems")).toBeInstanceOf(z.ZodArray);
  expect(schemaAt(names.extractionSchema, "systems.components")).toBeInstanceOf(z.ZodArray);
  expect(Object.keys(objectShape(names.extractionSchema, "systems.components"))).toEqual(["name"]);
  expect(exampleFields(projections, 0)).toEqual({
    building: { details: { year: envelope(1984, "built in 1984") } },
  });
  expect(exampleFields(projections, 2)).toEqual({
    systems: [
      {
        components: [{ name: envelope("boiler") }, { name: envelope("pump") }],
      },
    ],
  });
  expect(projections[0]!.target.examples![0]!.transcript).toBe("example transcript");
});

for (const granularity of [
  "leaf",
  "row",
  "none",
] as const satisfies readonly ProvenanceGranularity[]) {
  test(`projection preserves examples and envelope meaning under ${granularity} provenance`, () => {
    const values = z.object({
      audit: z.object({
        direct: z.string().nullable().optional(),
        nested: z.object({ note: z.string().nullable().optional() }),
      }),
    });
    const schema = enveloped(values, { provenance: { audit: granularity } });
    const directValue = granularity === "leaf" ? envelope("yes") : "yes";
    const noteValue = granularity === "leaf" ? envelope("nested") : "nested";
    const fields = {
      audit: {
        direct: directValue,
        nested: { note: noteValue },
        ...(granularity === "row" ? { sourceSpan: "audit row" } : {}),
      },
    };
    const plan = makePlan([
      piece("direct", "audit", ["audit.direct"]),
      piece("nested", "audit", ["audit.nested.note"]),
    ]);

    const projections = projectPlannedTargets(makeTarget(schema, fields), plan);
    const direct = projections[0]!.target;
    const nested = projections[1]!.target;

    expect(exampleFields(projections, 0)).toEqual({
      audit: {
        ...(granularity === "row" ? { sourceSpan: "audit row" } : {}),
        direct: directValue,
      },
    });
    expect(exampleFields(projections, 1)).toEqual({ audit: { nested: { note: noteValue } } });
    expect(Object.hasOwn(objectShape(direct.extractionSchema, "audit"), "sourceSpan")).toBe(
      granularity === "row",
    );
    expect(Object.hasOwn(objectShape(nested.extractionSchema, "audit"), "sourceSpan")).toBe(false);
    if (granularity === "leaf") {
      expect(isExtractedSchema(schemaAt(direct.extractionSchema, "audit.direct"))).toBe(true);
    } else {
      expect(schemaAt(direct.extractionSchema, "audit.direct").safeParse(null).success).toBe(true);
    }
  });
}

test("an absent planned path is refused by name", () => {
  const schema = enveloped(
    z.object({ audit: z.object({ present: z.string().nullable().optional() }) }),
  );
  const plan = makePlan([piece("missing", "audit", ["audit.absent"])]);

  expect(() => projectPlannedTargets(makeTarget(schema), plan)).toThrow(/audit\.absent/);
});

test("a later direct-leaf piece owns the parent citation over an earlier nested-only piece", () => {
  const schema = enveloped(
    z.object({
      audit: z.object({
        nested: z.object({ note: z.string().nullable().optional() }),
        direct: z.string().nullable().optional(),
      }),
    }),
    { provenance: { audit: "row" } },
  );
  const plan = makePlan([
    piece("nested first", "audit", ["audit.nested.note"]),
    piece("direct later", "audit", ["audit.direct"]),
  ]);
  const fields = {
    audit: { nested: { note: "note" }, direct: "direct", sourceSpan: "row citation" },
  };

  const projections = projectPlannedTargets(makeTarget(schema, fields), plan);

  expect(
    Object.hasOwn(objectShape(projections[0]!.target.extractionSchema, "audit"), "sourceSpan"),
  ).toBe(false);
  expect(Object.keys(objectShape(projections[1]!.target.extractionSchema, "audit"))).toEqual([
    "sourceSpan",
    "direct",
  ]);
  expect(exampleFields(projections, 0)).toEqual({ audit: { nested: { note: "note" } } });
  expect(exampleFields(projections, 1)).toEqual({
    audit: { sourceSpan: "row citation", direct: "direct" },
  });
});

test("several direct-leaf pieces give the parent citation to the earliest in plan order", () => {
  const schema = enveloped(
    z.object({
      audit: z.object({
        first: z.string().nullable().optional(),
        second: z.string().nullable().optional(),
      }),
    }),
    { provenance: { audit: "row" } },
  );
  const plan = makePlan([
    piece("first direct", "audit", ["audit.first"]),
    piece("second direct", "audit", ["audit.second"]),
  ]);

  const projections = projectPlannedTargets(makeTarget(schema), plan);

  expect(
    Object.hasOwn(objectShape(projections[0]!.target.extractionSchema, "audit"), "sourceSpan"),
  ).toBe(true);
  expect(
    Object.hasOwn(objectShape(projections[1]!.target.extractionSchema, "audit"), "sourceSpan"),
  ).toBe(false);
});

test("nested fallback gives a direct-leaf-free parent's citation to the earliest descendant piece", () => {
  const schema = enveloped(
    z.object({
      audit: z.object({
        left: z.object({ first: z.string().nullable().optional() }),
        right: z.object({ second: z.string().nullable().optional() }),
      }),
    }),
    { provenance: { audit: "row" } },
  );
  const plan = makePlan([
    piece("left nested", "audit", ["audit.left.first"]),
    piece("right nested", "audit", ["audit.right.second"]),
  ]);

  const projections = projectPlannedTargets(makeTarget(schema), plan);

  expect(
    Object.hasOwn(objectShape(projections[0]!.target.extractionSchema, "audit"), "sourceSpan"),
  ).toBe(true);
  expect(
    Object.hasOwn(objectShape(projections[1]!.target.extractionSchema, "audit"), "sourceSpan"),
  ).toBe(false);
});

test("a nested collection element split across pieces keeps exactly one element citation", () => {
  const schema = enveloped(
    z.object({
      systems: z.array(
        z.object({
          components: z.array(
            z.object({
              name: z.string().nullable().optional(),
              serial: z.string().nullable().optional(),
            }),
          ),
        }),
      ),
    }),
    { provenance: { systems: "row" } },
  );
  const plan = makePlan([
    piece("names", "systems", ["systems.components.name"]),
    piece("serials", "systems", ["systems.components.serial"]),
  ]);
  const fields = {
    systems: [
      {
        sourceSpan: "system row",
        components: [
          { name: "boiler", serial: "A-1", sourceSpan: "component row" },
          { name: "pump", serial: "B-2", sourceSpan: "second component row" },
        ],
      },
    ],
  };

  const projections = projectPlannedTargets(makeTarget(schema, fields), plan);

  expect(
    Object.keys(objectShape(projections[0]!.target.extractionSchema, "systems.components")),
  ).toEqual(["sourceSpan", "name"]);
  expect(
    Object.keys(objectShape(projections[1]!.target.extractionSchema, "systems.components")),
  ).toEqual(["serial"]);
  expect(exampleFields(projections, 0)).toEqual({
    systems: [
      {
        sourceSpan: "system row",
        components: [
          { sourceSpan: "component row", name: "boiler" },
          { sourceSpan: "second component row", name: "pump" },
        ],
      },
    ],
  });
  expect(exampleFields(projections, 1)).toEqual({
    systems: [{ components: [{ serial: "A-1" }, { serial: "B-2" }] }],
  });
});

test("a real enveloped leaf named sourceSpan remains an assigned field, not row metadata", () => {
  const schema = enveloped(
    z.object({
      audit: z.object({
        sourceSpan: z.string().describe("A genuine field").nullable().optional(),
        note: z.string().nullable().optional(),
      }),
    }),
  );
  const plan = makePlan([
    piece("literal source span field", "audit", ["audit.sourceSpan"]),
    piece("note", "audit", ["audit.note"]),
  ]);
  const fields = { audit: { sourceSpan: envelope("field value"), note: envelope("note") } };

  const projections = projectPlannedTargets(makeTarget(schema, fields), plan);
  const projectedLeaf = schemaAt(projections[0]!.target.extractionSchema, "audit.sourceSpan");

  expect(isExtractedSchema(projectedLeaf)).toBe(true);
  expect(projectedLeaf).toBe(schemaAt(schema, "audit.sourceSpan"));
  expect(exampleFields(projections, 0)).toEqual({
    audit: { sourceSpan: envelope("field value") },
  });
});
