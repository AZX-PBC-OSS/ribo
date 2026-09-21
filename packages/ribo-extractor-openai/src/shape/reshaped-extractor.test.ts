import { enveloped } from "@azx/ribo-core";
import type { ChatClient, ChatRequest, Transcript } from "@azx/ribo-core";
import { z } from "zod";
import { expect, test } from "vitest";

import { schemaExtractor } from "../strategies/schema-extractor.js";
import { reshapedExtractor } from "./reshaped-extractor.js";
import type { EnvelopedSchemaExtractorOptions } from "../strategies/schema-extractor.js";
import { assertShapeMapping } from "./shape-mapping.js";
import type { ShapeMapping } from "./shape-mapping.js";
import type { DerivedExtractionShape } from "./derived-shape.js";
import { buildReviewRequest } from "@azx/ribo-core";

/**
 * @file STAGE 0 — the seam, with a hand-written mapping and no operation set.
 *
 * The riskiest claims here are integration claims, so this file makes them
 * first: a hand-written mapping (a drop, a retype, one within-group regroup)
 * slots its extraction schema through `schemaExtractor`'s `extractionSchema`
 * passthrough — used as-is, no second derivation — and the reversal combinator
 * hands `buildReviewRequest` review cards with REAL grounded envelopes, not the
 * silent `{ value: null, confidence: 0 }` sentinel a reversal that dropped
 * envelope members would produce.
 *
 * The fixture is a pilot-SHAPED slice rebuilt locally — an extractor package
 * cannot import a tool adapter, and the seam must hold over fields shaped like
 * the pilot's: a flat singleton group, a collection group, a spec-string field
 * that extracts as a number, and a field worth dropping.
 */

const HvacSystemEquipmentType = z.enum([
  "Boiler",
  "Furnace with standalone ducts",
  "Central AC with standalone ducts",
]);
const HvacHeatingEnergySource = z.enum(["Electricity", "Natural Gas", "Fuel Oil", "None"]);

/**
 * The DERIVED patch — what review walks and the write parses. The hand-written
 * stage has already applied its one drop, so `houseLength` is absent: a dropped
 * leaf is in neither schema and on no review card, which is what the mapping's
 * bijectivity check enforces.
 */
const derivedPatch = z
  .object({
    basedata: z
      .object({
        // The spec's form-input string — the retype's patch side.
        yearBuilt: z.string().nullable().optional(),
        conditionedArea: z.number().nullable().optional(),
        numberOfOccupants: z.number().nullable().optional(),
      })
      .strict()
      .optional(),
    hvac: z
      .array(
        z.object({
          hvacSystemEquipmentType: HvacSystemEquipmentType.nullable().optional(),
          hvacHeatingEnergySource: HvacHeatingEnergySource.nullable().optional(),
        }),
      )
      .optional(),
  })
  .strict();

type PilotPatchValues = z.infer<typeof derivedPatch>;
type PilotShapedValues = z.infer<typeof shapedSchema>;

/** The shaped schema, hand-written: the drop, the retype and the regroup applied. */
const shapedSchema = z
  .object({
    basedata: z
      .object({
        yearBuilt: z.number().nullable().optional(), // retyped: extracts as what it means
        conditionedArea: z.number().nullable().optional(),
        // The regroup: occupants re-nested for extraction, mapped back below.
        occupancy: z.object({ numberOfOccupants: z.number().nullable().optional() }),
      })
      .strict()
      .optional(),
    hvac: z
      .array(
        z.object({
          hvacSystemEquipmentType: HvacSystemEquipmentType.nullable().optional(),
          hvacHeatingEnergySource: HvacHeatingEnergySource.nullable().optional(),
        }),
      )
      .optional(),
  })
  .strict();

/** The hand-written mapping back — a drop, a retype, one within-group regroup. */
const mapping: ShapeMapping = {
  leaves: {
    "basedata.yearBuilt": {
      source: "basedata.yearBuilt",
      retype: { extraction: "number", patch: "string" },
    },
    "basedata.conditionedArea": { source: "basedata.conditionedArea" },
    "basedata.occupancy.numberOfOccupants": { source: "basedata.numberOfOccupants" },
    "hvac.hvacSystemEquipmentType": { source: "hvac.hvacSystemEquipmentType" },
    "hvac.hvacHeatingEnergySource": { source: "hvac.hvacHeatingEnergySource" },
  },
  provenance: {},
};

// `satisfies` checks the artifact's shape while keeping the precise inferred
// member types — the erased interface is what the applier returns; a
// hand-written stage-0 artifact can be more precise than it.
const shape = {
  extractionSchema: enveloped(shapedSchema),
  patchSchema: derivedPatch,
  mapping,
  provenance: {},
  requiredOnCreate: {},
  identifyingFields: {},
} satisfies DerivedExtractionShape;

/** A ChatClient that records requests and answers with a canned enveloped payload. */
function fakeChat(respond: (request: ChatRequest) => unknown): {
  chat: ChatClient;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  return {
    chat: {
      complete: (request) => {
        requests.push(request);
        return Promise.resolve({
          content: JSON.stringify(respond(request)),
          finishReason: "stop" as const,
        });
      },
    },
    requests,
  };
}

/** What the model emits — in the SHAPED space, per the extraction schema. */
const shapedResponse = (): Record<string, unknown> => ({
  basedata: {
    yearBuilt: { value: 1972, confidence: 0.9, sourceSpan: "built in seventy-two" },
    conditionedArea: {
      value: 2100,
      confidence: 0.9,
      sourceSpan: "twenty-one hundred square feet",
    },
    occupancy: {
      numberOfOccupants: { value: 4, confidence: 0.9, sourceSpan: "family of four" },
    },
  },
  hvac: [
    {
      hvacSystemEquipmentType: { value: "Boiler", confidence: 0.9, sourceSpan: "an oil boiler" },
      hvacHeatingEnergySource: { value: "Fuel Oil", confidence: 0.9, sourceSpan: "an oil boiler" },
    },
  ],
});

const TEXT =
  "The house was built in seventy-two, twenty-one hundred square feet of living area, for a " +
  "family of four. There is an oil boiler.";

const transcript: Transcript = { recordingId: "rec-1", text: TEXT, engine: "fake" };

test("the seam: a hand-written mapping through the passthrough and the combinator", async () => {
  const { chat, requests } = fakeChat(shapedResponse);
  const inner = schemaExtractor<PilotShapedValues>({
    extractionSchema: shape.extractionSchema,
    name: "pilot",
    instructions: "Extract the pilot fields.",
    chat,
    model: "m",
  });
  const extractor = reshapedExtractor<PilotShapedValues, PilotPatchValues>(inner, shape);

  const { fields } = await extractor.extract({ text: TEXT, annotations: {} });

  // The passthrough used the DERIVED schema as-is: one call, carrying the
  // regrouped structure the model was asked for — not a second derivation.
  expect(requests).toHaveLength(1);
  const wireSchema = requests[0]!.response_format.json_schema.schema as {
    properties: Record<string, { properties: Record<string, unknown> }>;
  };
  const basedataKeys = Object.keys(wireSchema.properties.basedata!.properties);
  expect(basedataKeys).toContain("occupancy");
  expect(basedataKeys).not.toContain("numberOfOccupants");

  // Reversal landed back in the derived patch's space.
  expect(enveloped(derivedPatch).parse(fields)).toEqual(fields);

  // The retype reversed through the pinned encoding: 1972 → "1972".
  expect(fields.basedata.yearBuilt).toEqual({
    value: "1972",
    confidence: 0.9,
    sourceSpan: "built in seventy-two",
  });
  // The regroup reversed: the envelope landed at the caller's original path.
  expect(fields.basedata.numberOfOccupants).toEqual({
    value: 4,
    confidence: 0.9,
    sourceSpan: "family of four",
  });
  // The drop stayed dropped.
  expect(fields.basedata).not.toHaveProperty("houseLength");
  // The collection survived with its envelope.
  expect(fields.hvac[0]!.hvacSystemEquipmentType).toEqual({
    value: "Boiler",
    confidence: 0.9,
    sourceSpan: "an oil boiler",
  });
});

test("review cards carry real grounded envelopes, not sentinels", async () => {
  const { chat } = fakeChat(shapedResponse);
  const inner = schemaExtractor<PilotShapedValues>({
    extractionSchema: shape.extractionSchema,
    name: "pilot",
    instructions: "Extract the pilot fields.",
    chat,
    model: "m",
  });
  const extractor = reshapedExtractor<PilotShapedValues, PilotPatchValues>(inner, shape);
  const { fields } = await extractor.extract({ text: TEXT, annotations: {} });

  const request = buildReviewRequest(fields, transcript, derivedPatch);

  // Every leaf the patch declares — minus the dropped one — is on the card.
  expect(Object.keys(request.fields).sort()).toEqual([
    "basedata.conditionedArea",
    "basedata.numberOfOccupants",
    "basedata.yearBuilt",
    "hvac[k1].hvacHeatingEnergySource",
    "hvac[k1].hvacSystemEquipmentType",
  ]);

  for (const field of Object.values(request.fields)) {
    // The sentinel is confidence 0 with a null span; a real envelope carried
    // the model's confidence and a verbatim quote through the reversal.
    expect(field.extracted.confidence).toBe(0.9);
    expect(field.extracted.sourceSpan).not.toBeNull();
    expect(field.isGrounded).toBe(true);
  }
  // And the retyped leaf's card shows the patch-space value a reviewer edits.
  expect(request.fields["basedata.yearBuilt"]!.extracted.value).toBe("1972");
});

test("a hand-written mapping that misses the schemas is refused at construction", () => {
  const extractionSchema = shape.extractionSchema;
  expect(() =>
    assertShapeMapping(
      {
        leaves: {
          // Missing basedata.conditionedArea — reversal would drop its data.
          "basedata.yearBuilt": {
            source: "basedata.yearBuilt",
            retype: { extraction: "number", patch: "string" },
          },
        },
        provenance: {},
      },
      extractionSchema,
      derivedPatch,
    ),
  ).toThrow(/has no mapping entry/);

  expect(() =>
    assertShapeMapping(
      {
        leaves: {
          ...mapping.leaves,
          "basedata.typo": { source: "basedata.yearBuilt" },
        },
        provenance: {},
      },
      extractionSchema,
      derivedPatch,
    ),
  ).toThrow(/is not a leaf of the extraction schema/);

  expect(() =>
    assertShapeMapping(
      {
        leaves: {
          ...mapping.leaves,
          "hvac.hvacHeatingEnergySource": { source: "hvac.nonexistent" },
        },
        provenance: {},
      },
      extractionSchema,
      derivedPatch,
    ),
  ).toThrow(/not a leaf of the derived patch/);
});

test("a mapping that crosses a top-level boundary is refused", () => {
  expect(() =>
    assertShapeMapping(
      {
        leaves: {
          ...mapping.leaves,
          // The regroup the design refuses: an extraction leaf under `hvac`
          // sourced from `basedata` — a row span would have nowhere to land.
          "hvac.hvacSystemEquipmentType": { source: "basedata.conditionedArea" },
        },
        provenance: {},
      },
      shape.extractionSchema,
      derivedPatch,
    ),
  ).toThrow(/may not cross a top-level boundary/);
});

test("a row-granularity group reverses through the combinator: plain leaves, the row's citation", async () => {
  // A row-granularity derived shape. The passthrough is TYPED for leaf
  // granularity — `EnvelopedSchemaExtractorOptions` fixes `Enveloped<V,
  // NoProvenance>`, and a row group's plain leaves plus row span is a
  // different type — so the schema crosses with a cast, named here: the
  // runtime path is identical (the schema is used as-is), and fixing the type
  // would widen `schemaExtractor`'s public surface, which the plan freezes.
  const rowShaped = z.object({
    rooms: z.array(
      z.object({
        name: z.string().nullable().optional(),
        heatingLoad: z.number().nullable().optional(),
      }),
    ),
  });
  const rowExtractionSchema = enveloped(rowShaped, { provenance: { rooms: "row" } });
  const rowShape = {
    extractionSchema: rowExtractionSchema,
    patchSchema: rowShaped,
    mapping: {
      leaves: {
        "rooms.name": { source: "rooms.name" },
        "rooms.heatingLoad": { source: "rooms.heatingLoad" },
      },
      provenance: { rooms: "row" as const },
    },
    provenance: { rooms: "row" as const },
    requiredOnCreate: {},
    identifyingFields: {},
  } satisfies DerivedExtractionShape;

  const rowResponse = () => ({
    rooms: [
      {
        name: "L1.Bathrm",
        heatingLoad: 47,
        sourceSpan: "L1.Bathrm | 47 | 1521",
      },
    ],
  });
  const { chat } = fakeChat(rowResponse);
  type PassthroughSchema = EnvelopedSchemaExtractorOptions<
    Record<string, unknown>
  >["extractionSchema"];
  const inner = schemaExtractor({
    // The assertion is for the overload's INFERENCE, not assignability: with
    // the assertion, V infers as the erased record; without it, V infers from
    // the row-space shape and `Enveloped<V, NoProvenance>` cannot describe a
    // row-granularity schema, so the typecheck fails. The rule does not model
    // overload inference, hence the disable — narrowest scope, this line.
    extractionSchema: rowExtractionSchema as PassthroughSchema, // eslint-disable-line @typescript-eslint/no-unnecessary-type-assertion -- inference, not assignability; see above
    name: "rooms",
    instructions: "Extract the rooms.",
    chat,
    model: "m",
  });

  const extractor = reshapedExtractor(inner, rowShape);
  const { fields } = await extractor.extract({
    text: "L1.Bathrm | 47 | 1521",
    annotations: {},
  });

  // The row's leaves are plain values, and the citation landed on the row.
  const room = (fields.rooms as unknown[])[0] as Record<string, unknown>;
  expect(room.name).toBe("L1.Bathrm");
  expect(room.heatingLoad).toBe(47);
  expect(room.sourceSpan).toBe("L1.Bathrm | 47 | 1521");

  // And review presents the row's leaves with the row's span.
  const request = buildReviewRequest(
    fields,
    { recordingId: "rec-1", text: "L1.Bathrm | 47 | 1521", engine: "fake" },
    rowShaped,
    { provenance: { rooms: "row" } },
  );
  expect(request.fields["rooms[k1].name"]!.extracted.sourceSpan).toBe("L1.Bathrm | 47 | 1521");
  expect(request.fields["rooms[k1].heatingLoad"]!.isGrounded).toBe(true);
});
