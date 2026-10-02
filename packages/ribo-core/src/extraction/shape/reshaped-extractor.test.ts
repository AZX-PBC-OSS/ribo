import { enveloped } from "../../provenance/enveloped.js";
import type { Enveloped, NoProvenance } from "../../provenance/enveloped.js";
import type { Extractor } from "../extractor.js";
import type { ChatClient, ChatRequest } from "../../phases/chat-client.js";
import type { Transcript } from "../../capture/transcript.js";
import { z } from "zod";
import { expect, test } from "vitest";

import { schemaExtractor } from "../strategies/schema-extractor.js";
import { reshapedExtractor } from "./reshaped-extractor.js";
import type { EnvelopedSchemaExtractorOptions } from "../strategies/schema-extractor.js";
import { assertShapeMapping } from "./shape-mapping.js";
import type { ShapeMapping } from "./shape-mapping.js";
import { reverseShapedFields } from "./shape-reverse.js";
import type { DerivedExtractionShape } from "./derived-shape.js";
import { deriveExtractionShape } from "./shape-operations.js";
import { buildReviewRequest } from "../../review/review.js";

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
  partitions: {},
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

test("a cross-top entry is allowed in the nest case: a top-level leaf under a new synthetic group", () => {
  // The exact shape the derivation emits for a `nest` operation, written by
  // hand so the relaxation is pinned at the mapping layer itself: a top-level
  // patch leaf moved under a NEW top-level group in the extraction schema.
  // Both tops are "leaf"-granular and the extraction top names no patch key.
  const leaf = z.string().nullable().optional();
  const patchSchema = z.object({ yearBuilt: leaf });
  const extractionSchema = enveloped(z.object({ construction: z.object({ yearBuilt: leaf }) }));
  const nested: ShapeMapping = {
    leaves: { "construction.yearBuilt": { source: "yearBuilt" } },
    provenance: {},
  };
  expect(() => assertShapeMapping(nested, extractionSchema, patchSchema)).not.toThrow();
});

test("a cross-top entry under a row-provenanced extraction group is refused", () => {
  // Clause 2, extraction side: the extraction top is not "leaf"-granular, so
  // reversal would write this leaf's bare value where the patch expects an
  // envelope. The extraction schema is a REAL row group here — plain leaves,
  // row span — so nothing but the boundary check can fire.
  const leaf = z.string().nullable().optional();
  const patchSchema = z.object({ yearBuilt: leaf });
  const extractionSchema = enveloped(z.object({ construction: z.object({ yearBuilt: leaf }) }), {
    provenance: { construction: "row" },
  });
  const crossed: ShapeMapping = {
    leaves: { "construction.yearBuilt": { source: "yearBuilt" } },
    provenance: { construction: "row" },
  };
  expect(() => assertShapeMapping(crossed, extractionSchema, patchSchema)).toThrow(
    /may not cross a top-level boundary/,
  );
  expect(() => assertShapeMapping(crossed, extractionSchema, patchSchema)).toThrow(
    /"construction" is "row"-provenanced/,
  );
});

test("a cross-top entry whose source's own top-level key is none-provenanced is refused", () => {
  // Clause 2, source side — the hole a hand-written mapping opens:
  // `validateProvenance` refuses only "row" on a leaf, never "none", so this
  // is legal input. Reversal reads the granularity from the EXTRACTION top
  // ("leaf"), writes an envelope at `yearBuilt`, and the combinator's output
  // schema — `enveloped(patch, { yearBuilt: "none" })` — wants a plain
  // nullable: every extract would throw a retryable SchemaParseError.
  const leaf = z.string().nullable().optional();
  const patchSchema = z.object({ yearBuilt: leaf });
  const extractionSchema = enveloped(z.object({ construction: z.object({ yearBuilt: leaf }) }));
  const crossed: ShapeMapping = {
    leaves: { "construction.yearBuilt": { source: "yearBuilt" } },
    provenance: { yearBuilt: "none" },
  };
  expect(() => assertShapeMapping(crossed, extractionSchema, patchSchema)).toThrow(
    /may not cross a top-level boundary/,
  );
  expect(() => assertShapeMapping(crossed, extractionSchema, patchSchema)).toThrow(
    /"yearBuilt" is "none"-provenanced/,
  );
});

test("a cross-top entry whose extraction top is ALSO a patch key is accepted — a group named after its anchor leaf", () => {
  // The retired third conjunct. An earlier draft required the extraction top
  // to be absent from the patch, so that "this is the nest case" would be
  // literally true. A live proposer run retired it: the model names a group
  // after the leaf that anchors it — `pool` holding `pool`, `poolSize`,
  // `poolPumpType` — so `pool` is a group of the extraction schema AND a leaf
  // of the patch at the same time, and that is the natural shape, not an
  // error. Both remaining conjuncts hold and the entry reverses correctly.
  const leaf = z.string().nullable().optional();
  const patchSchema = z.object({ pool: leaf, poolSize: leaf });
  const extractionSchema = enveloped(z.object({ pool: z.object({ present: leaf, size: leaf }) }));
  const crossed: ShapeMapping = {
    leaves: {
      // Same-top: the anchor leaf under the group that took its name.
      "pool.present": { source: "pool" },
      // Cross-top: extraction top `pool` IS a patch key. Legal now.
      "pool.size": { source: "poolSize" },
    },
    provenance: {},
  };
  expect(() => assertShapeMapping(crossed, extractionSchema, patchSchema)).not.toThrow();

  // And it reverses to the flat patch paths, envelopes intact.
  const reversed = reverseShapedFields(
    {
      pool: {
        present: { value: "yes", confidence: 0.9, sourceSpan: "there's a pool" },
        size: { value: "20000", confidence: 0.8, sourceSpan: "twenty thousand gallons" },
      },
    },
    crossed,
  );
  expect(reversed).toEqual({
    pool: { value: "yes", confidence: 0.9, sourceSpan: "there's a pool" },
    poolSize: { value: "20000", confidence: 0.8, sourceSpan: "twenty thousand gallons" },
  });
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
    partitions: {},
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

test("end to end through a nest: the model answers the grouped schema, review sees the flat patch", async () => {
  // The payoff, both halves of it. Extraction side: the derived schema carries
  // the new group, so the split and the prompt assembly see `construction` as
  // a subject. Patch side: review walks the derived patch, which a nest leaves
  // byte-identical — the moved leaf renders at its FLAT patch path, and no
  // attic card exists.
  const flatSchema = z.object({
    yearBuilt: z.string().describe("Year the home was constructed.").nullable().optional(),
    heatingType: z.enum(["gas", "oil", "electric"]).nullable().optional(),
  });
  const nestedShape = deriveExtractionShape(flatSchema, {
    operations: [{ op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } }],
  });

  const nestedResponse = (): Record<string, unknown> => ({
    construction: {
      yearBuilt: { value: "1972", confidence: 0.9, sourceSpan: "built in seventy-two" },
    },
    heatingType: { value: "gas", confidence: 0.95, sourceSpan: "gas heat" },
  });
  const { chat, requests } = fakeChat(nestedResponse);
  type PassthroughSchema = EnvelopedSchemaExtractorOptions<
    Record<string, unknown>
  >["extractionSchema"];
  const inner = schemaExtractor({
    // The same inference-vs-assignability assertion the row-group test above
    // makes: the runtime path uses the schema as-is.
    extractionSchema: nestedShape.extractionSchema as PassthroughSchema,
    name: "flat-nest",
    instructions: "Extract the home fields.",
    chat,
    model: "m",
  });
  const extractor = reshapedExtractor(inner, nestedShape);
  const text = "The home was built in seventy-two, with gas heat.";
  const { fields } = await extractor.extract({ text, annotations: {} });

  // The wire carried the GROUPED schema — the nest group is what the model was
  // asked about.
  const wireSchema = requests[0]!.response_format.json_schema.schema as {
    properties: Record<string, unknown>;
  };
  expect(Object.keys(wireSchema.properties).sort()).toEqual(["construction", "heatingType"]);

  // Reversal landed the moved leaf at its original top-level patch path, with
  // the whole envelope intact.
  expect(fields.yearBuilt).toEqual({
    value: "1972",
    confidence: 0.9,
    sourceSpan: "built in seventy-two",
  });
  expect(fields).not.toHaveProperty("construction");

  // Review renders the moved leaf at its FLAT patch path — a nest buys nothing
  // review-side, and this pins that honestly.
  const request = buildReviewRequest(
    fields,
    { recordingId: "rec-1", text, engine: "fake" },
    nestedShape.patchSchema,
  );
  expect(Object.keys(request.fields).sort()).toEqual(["heatingType", "yearBuilt"]);
  expect(request.fields.yearBuilt!.isGrounded).toBe(true);
});

test("a skip report crosses reversal in the patch's keys — a nest group's item names the flat leaves it feeds", async () => {
  const flatSchema = z.object({
    yearBuilt: z.string().nullable().optional(),
    heatingType: z.enum(["gas", "oil", "electric"]).nullable().optional(),
  });
  const nestedShape = deriveExtractionShape(flatSchema, {
    operations: [{ op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } }],
  });
  const abstained = { value: null, confidence: 0, sourceSpan: null };
  const skipping: Extractor<Enveloped<Record<string, unknown>, NoProvenance>> = {
    extract: async () => ({
      fields: { construction: { yearBuilt: abstained }, heatingType: abstained },
      usage: { calls: 1 },
      skippedItems: [{ phaseId: "fill", key: "construction", instance: 1, instances: 1 }],
    }),
  };

  const result = await reshapedExtractor(skipping, nestedShape).extract({
    text: "nothing useful",
    annotations: {},
  });

  expect(result.skippedItems).toEqual([{ phaseId: "fill", key: "yearBuilt" }]);
});
