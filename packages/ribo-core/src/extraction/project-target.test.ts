import { describe, expect, test } from "vitest";
import { z } from "zod";

import { enveloped } from "../provenance/enveloped.js";
import type { Enveloped } from "../provenance/enveloped.js";
import type { ExtractionTarget } from "./extractor.js";
import type { ToolAdapterExample } from "../write/adapter.js";

import { buildGroupMessages, buildMessages } from "./extraction-common.js";
import { projectTarget } from "./project-target.js";

/**
 * @file Tests for {@link projectTarget}: the pure projection of an extraction
 * target onto one top-level group key.
 */

// --- Fixtures ----------------------------------------------------------------

const groupedPatch = z
  .object({
    hvac: z
      .object({
        equipmentType: z.string().nullable().optional(),
        fuel: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
    attic: z
      .object({
        insulationDepth: z.string().nullable().optional(),
        insulationRValue: z.number().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const groupedExtraction = enveloped(groupedPatch);
type GroupedValues = z.infer<typeof groupedPatch>;
type GroupedExtraction = Enveloped<GroupedValues>;

const groupedExample: ToolAdapterExample<GroupedExtraction> = {
  transcript: "The unit is a boiler, natural gas. Attic has about ten inches, R-30.",
  fields: {
    hvac: {
      equipmentType: { value: "Boiler", confidence: 0.9, sourceSpan: "The unit is a boiler" },
      fuel: { value: "Natural Gas", confidence: 0.8, sourceSpan: "natural gas" },
    },
    attic: {
      insulationDepth: { value: "10-12", confidence: 0.9, sourceSpan: "about ten inches" },
      insulationRValue: { value: 30, confidence: 0.7, sourceSpan: "R-30" },
    },
  },
};

const groupedTarget: ExtractionTarget<GroupedValues> = {
  name: "demo-grouped",
  extractionSchema: groupedExtraction,
  instructions: "Extract the hvac and attic fields. Emit a null for anything you cannot ground.",
  examples: [groupedExample],
};

const collectionPatch = z
  .object({
    hvac: z
      .array(
        z
          .object({
            equipmentType: z.string().nullable().optional(),
            fuel: z.string().nullable().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const collectionExtraction = enveloped(collectionPatch);
type CollectionValues = z.infer<typeof collectionPatch>;
type CollectionExtraction = Enveloped<CollectionValues>;

const collectionExample: ToolAdapterExample<CollectionExtraction> = {
  transcript: "There are two units: a boiler and a heat pump.",
  fields: {
    hvac: [
      {
        equipmentType: { value: "Boiler", confidence: 0.9, sourceSpan: "a boiler" },
        fuel: { value: "Natural Gas", confidence: 0.8, sourceSpan: "natural gas" },
      },
      {
        equipmentType: { value: "Heat Pump", confidence: 0.9, sourceSpan: "a heat pump" },
        fuel: { value: "Electricity", confidence: 0.8, sourceSpan: "electric" },
      },
    ],
  },
};

const collectionTarget: ExtractionTarget<CollectionValues> = {
  name: "demo-collection",
  extractionSchema: collectionExtraction,
  instructions: "Extract each hvac unit.",
  examples: [collectionExample],
};

// --- Tests -----------------------------------------------------------------

describe("projectTarget", () => {
  test("returns a one-key strict object schema for the requested group", () => {
    const projected = projectTarget(groupedTarget, "hvac");

    expect(projected.extractionSchema).toBeInstanceOf(z.ZodObject);
    const shape = (projected.extractionSchema as unknown as z.ZodObject).shape as Record<
      string,
      z.ZodType
    >;
    expect(Object.keys(shape)).toEqual(["hvac"]);
    expect(shape.hvac).toBeInstanceOf(z.ZodObject);
    expect(Object.keys((shape.hvac as unknown as z.ZodObject).shape)).toEqual([
      "equipmentType",
      "fuel",
    ]);
  });

  test("inherits the target's instructions when none are supplied", () => {
    const projected = projectTarget(groupedTarget, "hvac");
    expect(projected.instructions).toBe(groupedTarget.instructions);
  });

  test("uses supplied instructions in place of the target's", () => {
    const perGroupInstructions = "Only the hvac group.";
    const projected = projectTarget(groupedTarget, "hvac", { instructions: perGroupInstructions });
    expect(projected.instructions).toBe(perGroupInstructions);
  });

  test("projects examples to the requested key", () => {
    const projected = projectTarget(groupedTarget, "attic");
    expect(projected.examples).toHaveLength(1);
    expect(projected.examples![0]!.transcript).toBe(groupedExample.transcript);
    expect(Object.keys(projected.examples![0]!.fields)).toEqual(["attic"]);
    expect(projected.examples![0]!.fields.attic).toEqual(groupedExample.fields.attic);
  });

  test("skips examples that have no value for the requested key", () => {
    const noHvacExample = {
      transcript: "Attic only.",
      fields: {
        attic: {
          insulationDepth: { value: "10-12", confidence: 0.9, sourceSpan: "about ten inches" },
          insulationRValue: { value: 30, confidence: 0.7, sourceSpan: "R-30" },
        },
      },
    } as unknown as ToolAdapterExample<GroupedExtraction>;
    const projected = projectTarget(
      { ...groupedTarget, examples: [groupedExample, noHvacExample] },
      "hvac",
    );
    expect(projected.examples).toHaveLength(1);
  });

  test("singleton mode projects a collection to a single element", () => {
    const projected = projectTarget(collectionTarget, "hvac", { singleton: true });

    const shape = (projected.extractionSchema as unknown as z.ZodObject).shape as Record<
      string,
      z.ZodType
    >;
    expect(Object.keys(shape)).toEqual(["hvac"]);
    // Singleton narrows the array to its element schema.
    expect(shape.hvac).not.toBeInstanceOf(z.ZodArray);
    expect(shape.hvac).toBeInstanceOf(z.ZodObject);
    expect(Object.keys((shape.hvac as unknown as z.ZodObject).shape)).toEqual([
      "equipmentType",
      "fuel",
    ]);

    expect(projected.examples).toHaveLength(1);
    const fields = projected.examples![0]!.fields as Record<string, unknown>;
    const hvac = fields.hvac as Record<string, unknown>;
    expect(hvac).toEqual((collectionExample.fields.hvac as unknown[])[0]);
  });

  test("leafKeys narrows the projected schema and examples to those leaves", () => {
    const projected = projectTarget(groupedTarget, "hvac", { leafKeys: ["equipmentType"] });

    const shape = (projected.extractionSchema as unknown as z.ZodObject).shape as Record<
      string,
      z.ZodType
    >;
    expect(Object.keys((shape.hvac as unknown as z.ZodObject).shape)).toEqual(["equipmentType"]);

    const fields = projected.examples![0]!.fields as Record<string, unknown>;
    const hvac = fields.hvac as Record<string, unknown>;
    expect(Object.keys(hvac)).toEqual(["equipmentType"]);
    expect(hvac.equipmentType).toEqual(groupedExample.fields.hvac.equipmentType);
  });

  test("leafKeys narrows a collection's element schema when singleton is false", () => {
    const projected = projectTarget(collectionTarget, "hvac", { leafKeys: ["equipmentType"] });

    const shape = (projected.extractionSchema as unknown as z.ZodObject).shape as Record<
      string,
      z.ZodType
    >;
    expect(shape.hvac).toBeInstanceOf(z.ZodArray);
    const element = (shape.hvac as unknown as z.ZodArray).element as z.ZodType;
    expect(element).toBeInstanceOf(z.ZodObject);
    expect(Object.keys((element as unknown as z.ZodObject).shape)).toEqual(["equipmentType"]);

    const fields = projected.examples![0]!.fields as Record<string, unknown>;
    const hvac = fields.hvac as unknown[];
    expect(hvac).toHaveLength(2);
    expect(Object.keys(hvac[0]! as Record<string, unknown>)).toEqual(["equipmentType"]);
  });

  test("throws when the target schema is not a ZodObject", () => {
    const nonObjectTarget: ExtractionTarget<Record<string, unknown>> = {
      name: "demo-non-object",
      extractionSchema: z.array(z.string()) as unknown as z.ZodType<
        Enveloped<Record<string, unknown>>
      >,
      instructions: "Extract something.",
    };
    expect(() => projectTarget(nonObjectTarget, "x")).toThrow(
      /target "demo-non-object" extractionSchema is not a ZodObject/,
    );
  });

  test("throws when the key is not a top-level property of the schema", () => {
    expect(() => projectTarget(groupedTarget, "wall" as keyof GroupedValues)).toThrow(
      /target "demo-grouped" has no top-level key "wall"/,
    );
  });

  test("re-expressed buildGroupMessages is byte-identical for partitioned pieces", () => {
    const liveTranscript = "Live transcript for the test.";
    const groupInstructions = (key: string) => `Instructions for ${key}.`;

    const direct = buildGroupMessages(groupedTarget, "hvac", liveTranscript, groupInstructions);
    const viaProject = buildMessages(
      projectTarget(groupedTarget, "hvac", { instructions: groupInstructions("hvac") }),
      liveTranscript,
    );

    expect(direct).toEqual(viaProject);
  });

  test("re-expressed buildGroupMessages is byte-identical for singleton mode", () => {
    const liveTranscript = "Live transcript for the test.";
    const groupInstructions = (key: string) => `Instructions for ${key}.`;

    const direct = buildGroupMessages(
      collectionTarget,
      "hvac",
      liveTranscript,
      groupInstructions,
      true,
    );
    const viaProject = buildMessages(
      projectTarget(collectionTarget, "hvac", {
        instructions: groupInstructions("hvac"),
        singleton: true,
      }),
      liveTranscript,
    );

    expect(direct).toEqual(viaProject);
  });

  test("re-expressed buildGroupMessages is byte-identical for the non-grouped fallback", () => {
    const flatPatch = z
      .object({
        rValue: z.number().nullable().optional(),
        area: z.number().nullable().optional(),
      })
      .strict();
    type FlatValues = z.infer<typeof flatPatch>;
    type FlatExtraction = Enveloped<FlatValues>;
    const flatExample: ToolAdapterExample<FlatExtraction> = {
      transcript: "The wall is R-13, about four hundred square feet.",
      fields: {
        rValue: { value: 13, confidence: 0.9, sourceSpan: "R-13" },
        area: { value: 400, confidence: 0.8, sourceSpan: "four hundred square feet" },
      },
    };
    const flatTarget: ExtractionTarget<FlatValues> = {
      name: "demo-flat",
      extractionSchema: enveloped(flatPatch),
      instructions: "Extract the rValue and area.",
      examples: [flatExample],
    };

    const liveTranscript = "Live transcript for the test.";

    const direct = buildGroupMessages(flatTarget, "", liveTranscript);
    const viaBuildMessages = buildMessages(flatTarget, liveTranscript);

    expect(direct).toEqual(viaBuildMessages);
  });
});

// --- Type-level test: wrong key is a compile error -------------------------

describe("projectTarget type narrowing", () => {
  test("a wrong key is rejected at compile time", () => {
    // @ts-expect-error — "wall" is not a top-level key of GroupedValues.
    const attempt = () => projectTarget(groupedTarget, "wall");
    // Runtime still defends against a cast or JS caller.
    expect(attempt).toThrow(/has no top-level key "wall"/);
  });
});
