import { z } from "zod";
import { describe, expect, test } from "vitest";

import { enveloped } from "../../provenance/enveloped.js";
import type { ChatClient, ChatRequest } from "../../phases/chat-client.js";
import type { ExtractionTarget } from "../extractor.js";
import { perGroupExtractor } from "../strategies/per-group.js";
import { describeExtraction } from "./describe-extraction.js";
import { partitionLabelLine, serializedCharCount, splitExtractionSchema } from "./split-schema.js";
import type { ExtractionGroup } from "./split-schema.js";

/**
 * @file The split cuts a group along its partition's parts (spec §5): one subset
 * per label, packed by the same packer the group would otherwise use, numbered
 * across the whole key, each piece carrying its part's `label`. A group without
 * an entry is split exactly as before.
 */

const leaf = (description: string) => z.string().nullable().optional().describe(description);

const patch = z
  .object({
    basedata: z
      .object({
        yearBuilt: leaf("when the house was built"),
        storeys: leaf("number of storeys"),
        externalWall: leaf("external wall construction"),
        floorType: leaf("ground floor type"),
      })
      .strict()
      .optional(),
    systems: z
      .array(
        z
          .object({
            make: leaf("system make"),
            fuel: leaf("system fuel"),
            ratingKw: leaf("output rating in kW"),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const schema = enveloped(patch);

// Seven enveloped leaves = 14 nullable unions, so the whole schema fits under
// the default 16-union cap — the fixture for the single-shot-forcing tests.

/** The value a piece's schema carries under its group key (array or group object). */
const groupValueOf = (piece: ExtractionGroup): z.ZodType => {
  const shape = (piece.schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodType>;
  return shape[piece.key]!;
};

/** The group's (or element's) property names one piece's schema asks for. */
const pieceFields = (piece: ExtractionGroup): readonly string[] => {
  const value = groupValueOf(piece);
  const candidate = value instanceof z.ZodArray ? value.element : value;
  return Object.keys((candidate as z.ZodObject).shape);
};

const shapeRecord = schema.shape as Record<string, z.ZodType>;
const basedataObject = shapeRecord["basedata"]! as z.ZodObject;
const basedataLeaf = (key: string): z.ZodType =>
  (basedataObject.shape as Record<string, z.ZodType>)[key]!;
/** A one-piece schema carrying exactly `keys` of basedata — for measuring caps. */
const basedataPiece = (keys: readonly string[]): z.ZodType =>
  z.strictObject({
    basedata: z.strictObject(Object.fromEntries(keys.map((k) => [k, basedataLeaf(k)]))),
  });

const TWO_PARTS = {
  basedata: { envelope: ["yearBuilt", "storeys"], comfort: ["externalWall", "floorType"] },
} as const;

/** Envelope values for the named leaves — extraction responses parse with these. */
const leaves = (...names: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(names.map((name) => [name, { value: null, sourceSpan: null, confidence: 1 }]));

describe("splitExtractionSchema — partitions", () => {
  test("2.1 two parts, no caps: two pieces, labels in record order, each piece's schema holding exactly its part's fields", () => {
    const groups = splitExtractionSchema(schema, { partitions: TWO_PARTS });

    const pieces = groups.filter((g) => g.key === "basedata");
    expect(pieces).toHaveLength(2);
    expect(pieces.map((g) => g.label)).toEqual(["envelope", "comfort"]);
    expect(pieces.map((g) => [g.part, g.parts])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(pieceFields(pieces[0]!)).toEqual(["yearBuilt", "storeys"]);
    expect(pieceFields(pieces[1]!)).toEqual(["externalWall", "floorType"]);

    // A group without an entry keeps today's single piece, and no label.
    const systems = groups.filter((g) => g.key === "systems");
    expect(systems).toHaveLength(1);
    expect(systems[0]!.label).toBeUndefined();
    expect(systems[0]!.part).toBeUndefined();
  });

  test("2.2 under a byte cap a part too large for one piece becomes several pieces with the same label; numbering is continuous across the key", () => {
    // Measured so a three-leaf part cannot fit one piece while any one-leaf
    // piece can — the cut must not depend on serialized sizes staying put.
    const cap = serializedCharCount(basedataPiece(["yearBuilt", "storeys", "externalWall"])) - 1;
    const groups = splitExtractionSchema(schema, {
      maxSerializedCharsPerGroup: cap,
      partitions: {
        basedata: { big: ["yearBuilt", "storeys", "externalWall"], small: ["floorType"] },
      },
    });

    const pieces = groups.filter((g) => g.key === "basedata");
    expect(pieces).toHaveLength(3);
    expect(pieces.map((g) => g.label)).toEqual(["big", "big", "small"]);
    expect(pieces.map((g) => g.part)).toEqual([0, 1, 2]);
    expect(pieces.every((g) => g.parts === 3)).toBe(true);
    // The oversized part split inside itself; the small part stayed whole.
    const bigFields = ["yearBuilt", "storeys", "externalWall"];
    expect(pieceFields(pieces[0]!).every((f) => bigFields.includes(f))).toBe(true);
    expect(pieceFields(pieces[1]!).every((f) => bigFields.includes(f))).toBe(true);
    expect(pieceFields(pieces[2]!)).toEqual(["floorType"]);
    for (const piece of pieces) {
      expect(serializedCharCount(piece.schema)).toBeLessThanOrEqual(cap);
    }
  });

  test("2.3 a group whose whole schema fits under the caps is still cut into one piece per part", () => {
    const cap = serializedCharCount(schema) + 1_000;
    const groups = splitExtractionSchema(schema, {
      maxSerializedCharsPerGroup: cap,
      partitions: TWO_PARTS,
    });

    const pieces = groups.filter((g) => g.key === "basedata");
    expect(pieces).toHaveLength(2);
    expect(pieces.map((g) => g.label)).toEqual(["envelope", "comfort"]);
    expect(pieces.map((g) => [g.part, g.parts])).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  test("2.4 a collection partition: every piece's value is an array whose element holds only that part's fields", () => {
    const groups = splitExtractionSchema(schema, {
      partitions: { systems: { identity: ["make", "fuel"], output: ["ratingKw"] } },
    });

    const pieces = groups.filter((g) => g.key === "systems");
    expect(pieces).toHaveLength(2);
    expect(pieces.map((g) => g.label)).toEqual(["identity", "output"]);
    const expected: readonly (readonly string[])[] = [["make", "fuel"], ["ratingKw"]];
    for (const [index, piece] of pieces.entries()) {
      const value = groupValueOf(piece);
      expect(value).toBeInstanceOf(z.ZodArray);
      const element = (value as z.ZodArray).element as z.ZodObject;
      expect(Object.keys(element.shape as Record<string, z.ZodType>)).toEqual(expected[index]);
    }
  });

  test("2.5 no piece mixes two parts: every piece's fields are a subset of exactly one part", () => {
    // The cap lets the schema's first two leaves share a piece — so a cut that
    // ignored parts would pack p1's and p2's fields together and fail here.
    const cap = serializedCharCount(basedataPiece(["yearBuilt", "storeys"]));
    const parts = {
      p1: ["yearBuilt"],
      p2: ["storeys", "externalWall"],
      p3: ["floorType"],
    } as const;
    const groups = splitExtractionSchema(schema, {
      maxSerializedCharsPerGroup: cap,
      partitions: { basedata: parts },
    });

    const pieces = groups.filter((g) => g.key === "basedata");
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    const partLists: readonly (readonly string[])[] = Object.values(parts);
    for (const piece of pieces) {
      const fields = pieceFields(piece);
      expect(fields.length).toBeGreaterThan(0);
      const hosting = partLists.filter((part) => fields.every((f) => part.includes(f)));
      expect(hosting, `piece fields [${fields.join(", ")}]`).toHaveLength(1);
    }
  });

  test("2.6 a group with no entry in partitions is split exactly as without the option (regression pin)", () => {
    // A cap under which the unpartitioned systems group really splits, so the
    // comparison has partitioned output to compare, not two single pieces.
    const systemsArray = shapeRecord["systems"]! as z.ZodArray;
    const cap = serializedCharCount(z.strictObject({ systems: systemsArray })) - 1;

    const without = splitExtractionSchema(schema, { maxSerializedCharsPerGroup: cap });
    const withOption = splitExtractionSchema(schema, {
      maxSerializedCharsPerGroup: cap,
      partitions: { basedata: { all: ["yearBuilt", "storeys", "externalWall", "floorType"] } },
    });

    const before = without.filter((g) => g.key === "systems");
    const after = withOption.filter((g) => g.key === "systems");
    expect(before.length).toBeGreaterThan(1);
    expect(after.map((g) => [g.key, g.part, g.parts])).toEqual(
      before.map((g) => [g.key, g.part, g.parts]),
    );
    // No entry, no label — asserted on its own, not only against `before`,
    // where both sides could be absent and the comparison would be vacuous.
    expect(after.every((g) => g.label === undefined)).toBe(true);
    expect(after.map((g) => z.toJSONSchema(g.schema))).toEqual(
      before.map((g) => z.toJSONSchema(g.schema)),
    );
  });

  test("2.10 describeExtraction reports per-group, not single-shot, for a fitting schema given a non-empty partitions record", () => {
    // The contrast first: without the record this schema is single-shot.
    expect(describeExtraction({ schema: patch }).callShape).toBe("single-shot");

    const description = describeExtraction({ schema: patch, partitions: TWO_PARTS });
    expect(description.refusal).toBeUndefined();
    expect(description.callShape).toBe("per-group");
  });

  test("2.11 under fieldDescriptions: prompt, a labelled per-group request has the label line before the field-guidance block", async () => {
    // Served by piece name, so a body parses whether or not the group was cut;
    // before the split honours partitions the part names never appear and the
    // find below fails.
    const bodies: Record<string, string> = {
      "demo-basedata-0": JSON.stringify({ basedata: leaves("yearBuilt", "storeys") }),
      "demo-basedata-1": JSON.stringify({ basedata: leaves("externalWall", "floorType") }),
      "demo-systems": JSON.stringify({ systems: [leaves("make", "fuel", "ratingKw")] }),
    };
    const requests: ChatRequest[] = [];
    const chat: ChatClient = {
      complete: (request) => {
        requests.push(request);
        return Promise.resolve({
          content: bodies[request.response_format.json_schema.name] ?? "{}",
          finishReason: "stop",
        });
      },
    };
    const target: ExtractionTarget<z.infer<typeof patch>> = {
      name: "demo",
      extractionSchema: schema,
      instructions: "Extract the fields.",
      examples: [],
    };

    await perGroupExtractor({
      target,
      chat,
      model: "m",
      groupInstructions: (key) => `Base instructions for ${key}.`,
      fieldDescriptions: "prompt",
      partitions: TWO_PARTS,
    }).extract({ text: "the transcript", annotations: {} });

    const piece = requests.find((r) => r.response_format.json_schema.name === "demo-basedata-0");
    expect(piece).toBeDefined();
    const system = piece!.messages[0]!.content;
    const base = system.indexOf("Base instructions for basedata.");
    const label = system.indexOf(partitionLabelLine("basedata", "envelope"));
    const guidance = system.indexOf("### Field guidance");
    expect(base).toBeGreaterThanOrEqual(0);
    expect(label).toBeGreaterThan(base);
    expect(guidance).toBeGreaterThan(label);
  });
});

describe("splitExtractionSchema — the fields other calls cover", () => {
  test("each labelled piece names the group's fields not in it, in declaration order, including a same-part sibling piece's", () => {
    const cap = serializedCharCount(basedataPiece(["yearBuilt", "storeys", "externalWall"])) - 1;
    const groups = splitExtractionSchema(schema, {
      maxSerializedCharsPerGroup: cap,
      partitions: {
        basedata: { big: ["yearBuilt", "storeys", "externalWall"], small: ["floorType"] },
      },
    });

    const pieces = groups.filter((g) => g.key === "basedata");
    const all = ["yearBuilt", "storeys", "externalWall", "floorType"];
    for (const piece of pieces) {
      const own = pieceFields(piece);
      expect(piece.elsewhere, piece.label).toEqual(all.filter((field) => !own.includes(field)));
    }
    // An unpartitioned group's piece carries no list, so its request is unchanged.
    expect(groups.find((g) => g.key === "systems")!.elsewhere).toBeUndefined();
  });
});
