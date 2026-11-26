import { expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "../provenance/enveloped.js";
import type { ExtractionTarget } from "./extractor.js";
import { parseWithSchema } from "./parse-with-schema.js";
import { SchemaParseError } from "./schema-parse-error.js";
import { SCHEMA_PLAN_CONTRACT_VERSION } from "./schema-plan.js";
import type { SchemaPlan, SchemaPlanPiece } from "./schema-plan.js";
import { projectPlannedTargets } from "./schema/planned-projection.js";

import { createPlannedMerge } from "./planned-merge.js";

const envelope = (value: unknown, sourceSpan: string | null = "quoted text") => ({
  value,
  confidence: 0.75,
  sourceSpan,
});

const piece = (name: string, key: string, paths: readonly string[]): SchemaPlanPiece => ({
  name,
  description: `${name} description.`,
  key,
  paths: [...paths],
});

const makePlan = (pieces: readonly SchemaPlanPiece[]): SchemaPlan => ({
  version: SCHEMA_PLAN_CONTRACT_VERSION,
  schemaFingerprint: "a".repeat(64),
  fieldPaths: pieces.flatMap((entry) => entry.paths),
  pieces: [...pieces],
  provenance: {
    model: "stub-model",
    backend: "stub-backend",
    createdAt: "2026-09-21T12:00:00.000Z",
  },
});

const makeTarget = (
  extractionSchema: z.ZodObject,
  fields: Record<string, unknown>,
): ExtractionTarget<Record<string, unknown>> =>
  ({
    name: "planned-merge",
    extractionSchema,
    instructions: "Extract the planned fields.",
    examples: [{ transcript: "example transcript", fields }],
  }) as unknown as ExtractionTarget<Record<string, unknown>>;

const mergeValue = (
  schema: z.ZodObject,
  key: string,
  existing: unknown,
  incoming: unknown,
): unknown => createPlannedMerge(schema)(existing, incoming, key);

/** Merge the examples after the same projection that owns each row citation. */
const mergeProjectedExamples = (
  target: ExtractionTarget<Record<string, unknown>>,
  plan: SchemaPlan,
  key: string,
): unknown => {
  const projections = projectPlannedTargets(target, plan);
  const merge = createPlannedMerge(target.extractionSchema);
  const values = projections.map((projection) => {
    const fields = projection.target.examples?.[0]?.fields as Record<string, unknown>;
    return fields[key];
  });
  return values.slice(1).reduce<unknown>((merged, value) => merge(merged, value, key), values[0]);
};

test("nested singleton branches recombine while sole-owner leaf envelopes stay verbatim", () => {
  const schema = enveloped(
    z.object({
      building: z.object({
        details: z.object({
          year: z.number().nullable().optional(),
          color: z.string().nullable().optional(),
        }),
      }),
    }),
  );
  const year = envelope(1984, "built in 1984");
  const color = envelope("red", "red siding");

  const merged = mergeValue(schema, "building", { details: { year } }, { details: { color } }) as {
    details: { year: unknown; color: unknown };
  };

  expect(merged).toEqual({ details: { year, color } });
  expect(merged.details.year).toBe(year);
  expect(merged.details.color).toBe(color);
});

test("nested collection branches recombine by element index with exactly one citation per row", () => {
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

  const merged = mergeValue(
    schema,
    "systems",
    [
      {
        sourceSpan: "system row",
        components: [{ sourceSpan: "component row", name: "boiler" }],
      },
    ],
    [{ components: [{ serial: "A-1" }] }],
  );

  expect(merged).toEqual([
    {
      sourceSpan: "system row",
      components: [{ sourceSpan: "component row", name: "boiler", serial: "A-1" }],
    },
  ]);
  const rows = merged as { sourceSpan: unknown; components: { sourceSpan: unknown }[] }[];
  expect(Object.keys(rows[0]!).filter((key) => key === "sourceSpan")).toHaveLength(1);
  expect(Object.keys(rows[0]!.components[0]!).filter((key) => key === "sourceSpan")).toHaveLength(
    1,
  );
});

test("a null owner citation remains null when a non-owner nested piece arrives", () => {
  const schema = enveloped(
    z.object({
      systems: z.array(
        z.object({
          name: z.string().nullable().optional(),
          serial: z.string().nullable().optional(),
        }),
      ),
    }),
    { provenance: { systems: "row" } },
  );

  const merged = mergeValue(
    schema,
    "systems",
    [{ sourceSpan: null, name: "boiler" }],
    [{ serial: "A-1" }],
  );

  expect(merged).toEqual([{ sourceSpan: null, name: "boiler", serial: "A-1" }]);
});

test("a later direct-leaf owner beats an earlier nested-only piece without duplicating the parent citation", () => {
  const schema = enveloped(
    z.object({
      audit: z.object({
        nested: z.object({ note: z.string().nullable().optional() }),
        direct: z.string().nullable().optional(),
      }),
    }),
    { provenance: { audit: "row" } },
  );
  const fields = {
    audit: { nested: { note: "note" }, direct: "direct", sourceSpan: "row citation" },
  };
  const plan = makePlan([
    piece("nested first", "audit", ["audit.nested.note"]),
    piece("direct later", "audit", ["audit.direct"]),
  ]);

  const merged = mergeProjectedExamples(makeTarget(schema, fields), plan, "audit");

  expect(merged).toEqual(fields.audit);
  expect(
    Object.keys(merged as Record<string, unknown>).filter((key) => key === "sourceSpan"),
  ).toHaveLength(1);
});

test("the earliest direct-leaf piece owns the parent citation when direct pieces are split", () => {
  const schema = enveloped(
    z.object({
      audit: z.object({
        first: z.string().nullable().optional(),
        second: z.string().nullable().optional(),
      }),
    }),
    { provenance: { audit: "row" } },
  );
  const fields = { audit: { first: "first", second: "second", sourceSpan: "row citation" } };
  const plan = makePlan([
    piece("first direct", "audit", ["audit.first"]),
    piece("second direct", "audit", ["audit.second"]),
  ]);

  const merged = mergeProjectedExamples(makeTarget(schema, fields), plan, "audit");

  expect(merged).toEqual(fields.audit);
  expect(
    Object.keys(merged as Record<string, unknown>).filter((key) => key === "sourceSpan"),
  ).toHaveLength(1);
});

test("a direct-leaf-free parent keeps the earliest nested piece's citation through the merge", () => {
  const schema = enveloped(
    z.object({
      audit: z.object({
        left: z.object({ first: z.string().nullable().optional() }),
        right: z.object({ second: z.string().nullable().optional() }),
      }),
    }),
    { provenance: { audit: "row" } },
  );
  const fields = {
    audit: {
      left: { first: "first" },
      right: { second: "second" },
      sourceSpan: "row citation",
    },
  };
  const plan = makePlan([
    piece("left nested", "audit", ["audit.left.first"]),
    piece("right nested", "audit", ["audit.right.second"]),
  ]);

  const merged = mergeProjectedExamples(makeTarget(schema, fields), plan, "audit");

  expect(merged).toEqual(fields.audit);
  expect(
    Object.keys(merged as Record<string, unknown>).filter((key) => key === "sourceSpan"),
  ).toHaveLength(1);
});

test("a partial nested element retains its owner's citation without losing or repeating it", () => {
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
  const fields = {
    systems: [
      {
        sourceSpan: "system row",
        components: [{ sourceSpan: "component row", name: "boiler", serial: "A-1" }],
      },
    ],
  };
  const plan = makePlan([
    piece("names", "systems", ["systems.components.name"]),
    piece("serials", "systems", ["systems.components.serial"]),
  ]);

  const merged = mergeProjectedExamples(makeTarget(schema, fields), plan, "systems");

  expect(merged).toEqual(fields.systems);
  const rows = merged as { components: Record<string, unknown>[] }[];
  expect(Object.keys(rows[0]!.components[0]!).filter((key) => key === "sourceSpan")).toHaveLength(
    1,
  );
});

test("an envelope-valued duplicate is refused by path rather than deep-merged", () => {
  const schema = enveloped(
    z.object({
      building: z.object({
        details: z.object({ year: z.number().nullable().optional() }),
      }),
    }),
  );

  expect(() =>
    mergeValue(
      schema,
      "building",
      { details: { year: envelope(1984) } },
      { details: { year: envelope(2001) } },
    ),
  ).toThrow(/duplicate.*building\.details\.year/);
});

test("scalar and null duplicates are values refused by their full paths", () => {
  const schema = enveloped(
    z.object({
      audit: z.object({
        scalar: z.string().nullable().optional(),
        absent: z.string().nullable().optional(),
      }),
    }),
    { provenance: { audit: "none" } },
  );

  expect(() => mergeValue(schema, "audit", { scalar: "first" }, { scalar: "second" })).toThrow(
    /duplicate.*audit\.scalar/,
  );
  expect(() => mergeValue(schema, "audit", { absent: null }, { absent: null })).toThrow(
    /duplicate.*audit\.absent/,
  );
});

test("a duplicate inside nested collections names the full dotted and indexed path", () => {
  const schema = enveloped(
    z.object({
      systems: z.array(
        z.object({
          components: z.array(z.object({ name: z.string().nullable().optional() })),
        }),
      ),
    }),
    { provenance: { systems: "row" } },
  );

  expect(() =>
    mergeValue(
      schema,
      "systems",
      [{ components: [{ name: "first" }] }],
      [{ components: [{ name: "second" }] }],
    ),
  ).toThrow(/duplicate.*systems\[0\]\.components\[0\]\.name/);
});

test("sole-owner scalar and null values are not treated as branches", () => {
  const schema = enveloped(
    z.object({
      audit: z.object({
        scalar: z.string().nullable().optional(),
        absent: z.string().nullable().optional(),
        other: z.string().nullable().optional(),
      }),
    }),
    { provenance: { audit: "none" } },
  );

  expect(mergeValue(schema, "audit", { scalar: "kept", absent: null }, { other: "other" })).toEqual(
    { scalar: "kept", absent: null, other: "other" },
  );
});

test("unequal collection lengths retain the longer partial output for the authoritative closing parse", () => {
  const schema = enveloped(
    z.object({
      systems: z.array(
        z.object({
          name: z.string().nullable().optional(),
          serial: z.string().nullable().optional(),
        }),
      ),
    }),
    { provenance: { systems: "row" } },
  );

  const merged = mergeValue(
    schema,
    "systems",
    [
      { sourceSpan: "first row", name: "boiler" },
      { sourceSpan: "second row", name: "pump" },
    ],
    [{ serial: "A-1" }],
  );

  expect(merged).toEqual([
    { sourceSpan: "first row", name: "boiler", serial: "A-1" },
    { sourceSpan: "second row", name: "pump" },
  ]);
  expect(() => parseWithSchema(schema, { systems: merged }, "planned merge test")).toThrow(
    SchemaParseError,
  );
});
