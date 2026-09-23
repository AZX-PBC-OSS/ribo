import { enveloped, extractedSchema } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import {
  MAX_NULLABLE_UNIONS_PER_CALL,
  nullableUnionCount,
  splitExtractionSchema,
} from "./split-schema.js";

/**
 * @file The split of a MIXED schema: top-level keys that are groups beside
 * top-level keys that are loose leaves.
 *
 * The gate used to be `everyKeyIsGroup`: one loose top-level leaf collapsed the
 * whole schema to the flat fallback — one oversized or description-stripped
 * call, exactly the failure per-group extraction exists to remove (measured on
 * the live run in `nest-live-run-evidence.md` §3: 14 nests plus 47 loose
 * leaves could not split at all). The mixed branch emits one entry per group,
 * unchanged, plus the loose leaves carried as piece(s) keyed `""` — the
 * unwrapped portion — appended last (mixed-schema-split design §5.2).
 *
 * The all-group and all-flat paths are pinned unchanged by
 * `split-schema.test.ts`, `split-schema-unions.test.ts` and
 * `split-schema-bytes.test.ts`; what is pinned HERE is the mixed branch and
 * that its group pieces are the all-group path's pieces verbatim.
 */

// --- Fixtures ----------------------------------------------------------------

const leaf = (): z.ZodString => z.string();

/** One enum leaf with long values: many serialized bytes per leaf. */
const longEnumLeaf = (seed: number): z.ZodEnum =>
  z.enum([
    `option-alpha-${seed}-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    `option-bravo-${seed}-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
    `option-charlie-${seed}-cccccccccccccccccccccccccccccc`,
  ]);

/** A group of `count` enum leaves, before enveloping. */
const enumGroup = (count: number, seed = 0): z.ZodObject => {
  const shape: Record<string, z.ZodType> = {};
  for (let i = 0; i < count; i++) shape[`leaf${i}`] = longEnumLeaf(seed + i);
  return z.object(shape);
};

/**
 * The running mixed fixture: two groups (`hvac` singleton, `rooms` collection)
 * plus two loose leaves. `enveloped()` recurses into the groups and wraps the
 * loose leaves directly, so the extraction schema's top level is genuinely
 * mixed — two group objects and two leaf envelopes.
 */
const mixedPatch = z
  .object({
    hvac: z
      .object({
        equipmentType: leaf().nullable().optional(),
        fuel: leaf().nullable().optional(),
      })
      .strict()
      .optional(),
    rooms: z.array(z.object({ roomType: leaf().nullable().optional() }).strict()).optional(),
    note: leaf().nullable().optional(),
    yearBuilt: z.number().nullable().optional(),
  })
  .strict();

const mixedExtraction = enveloped(mixedPatch);

const serializedSize = (schema: z.ZodType): number =>
  JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12" })).length;

// --- Leaf enumeration (the same independent coverage walk split-schema.test.ts uses) ---

const ENVELOPE_KEYS = new Set(["value", "confidence", "sourceSpan"]);

function unwrapArray(schema: z.ZodType): z.ZodType {
  return schema instanceof z.ZodArray ? (schema.element as z.ZodType) : schema;
}

const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType => shape[key] as z.ZodType;

function enumerateLeaves(schema: z.ZodType, prefix = ""): string[] {
  const unwrapped = unwrapArray(schema);
  if (!(unwrapped instanceof z.ZodObject)) return [];
  const shape = unwrapped.shape;
  const keys = Object.keys(shape);
  if (keys.length === 3 && keys.every((k) => ENVELOPE_KEYS.has(k))) {
    return prefix ? [prefix] : [];
  }
  const leaves: string[] = [];
  for (const key of keys) {
    const child = unwrapArray(fieldAt(shape, key));
    if (child instanceof z.ZodObject) {
      leaves.push(...enumerateLeaves(child, prefix ? `${prefix}.${key}` : key));
    }
  }
  return leaves;
}

// --- Tests -------------------------------------------------------------------

describe("splitExtractionSchema — mixed schema, no caps", () => {
  test('one entry per group plus one trailing loose piece keyed "", in declaration order', () => {
    const groups = splitExtractionSchema(mixedExtraction);

    // Groups in schema declaration order, the loose piece LAST — the order the
    // plan's key-grouping preserves into the schedule (design §5.2, open
    // question 3).
    expect(groups.map((g) => g.key)).toEqual(["hvac", "rooms", ""]);

    // The group entries are today's grouped path verbatim: one-key strict
    // objects, no part/parts.
    for (const group of groups.slice(0, 2)) {
      expect(Object.keys((group.schema as z.ZodObject).shape)).toEqual([group.key]);
      expect(group.part).toBeUndefined();
      expect(group.parts).toBeUndefined();
    }

    // The loose piece is the flat fallback's under-cap shape narrowed to the
    // loose subset: a strict object of exactly the loose leaves, keyed "",
    // no part/parts.
    const loose = groups[2]!;
    expect(loose.part).toBeUndefined();
    expect(loose.parts).toBeUndefined();
    expect(Object.keys((loose.schema as z.ZodObject).shape)).toEqual(["note", "yearBuilt"]);
  });

  test("the loose piece narrows: it accepts the loose leaves and rejects a group key", () => {
    const groups = splitExtractionSchema(mixedExtraction);
    const loose = groups.find((g) => g.key === "")!;
    const hvac = groups.find((g) => g.key === "hvac")!;

    const looseData = {
      note: { value: "a note", confidence: 0.9, sourceSpan: "the note" },
      yearBuilt: { value: 1978, confidence: 0.8, sourceSpan: "built in 1978" },
    };
    expect(loose.schema.safeParse(looseData).success).toBe(true);
    // Strict: a group key is an extra key the loose piece refuses.
    expect(loose.schema.safeParse({ ...looseData, hvac: {} }).success).toBe(false);
    // And the group piece refuses a loose leaf the same way.
    const hvacData = {
      hvac: {
        equipmentType: { value: "Boiler", confidence: 0.9, sourceSpan: "boiler" },
        fuel: { value: "Natural Gas", confidence: 0.8, sourceSpan: "gas" },
      },
    };
    expect(hvac.schema.safeParse(hvacData).success).toBe(true);
    expect(hvac.schema.safeParse({ ...hvacData, note: looseData.note }).success).toBe(false);
  });

  test("every leaf of the original schema appears in exactly one piece, at its original path", () => {
    // The split-then-merge equivalence pin (design §10): the loose leaves keep
    // their top-level paths and the groups keep theirs — no invented group key
    // anywhere, which is what separates this from the sweep workaround.
    const groups = splitExtractionSchema(mixedExtraction);

    const originalLeaves = enumerateLeaves(mixedExtraction).sort();
    const pieceLeaves = groups.flatMap((g) => enumerateLeaves(g.schema)).sort();

    expect(pieceLeaves).toEqual(originalLeaves);
    expect(pieceLeaves).toContain("note");
    expect(pieceLeaves).toContain("yearBuilt");
    expect(new Set(pieceLeaves).size).toBe(pieceLeaves.length);
  });

  test('a mixed schema whose group fits the caps no longer packs atomically under ""', () => {
    // The evidence-§5 shape: today this schema is ONE "" entry carrying
    // everything (accepted); the mixed branch emits the group and the loose
    // remainder separately — which the widened GroupMap accepts.
    const small = enveloped(
      z
        .object({
          hvac: z.object({ fuel: leaf().nullable().optional() }).strict().optional(),
          note: leaf().nullable().optional(),
        })
        .strict(),
    );

    const groups = splitExtractionSchema(small, MAX_NULLABLE_UNIONS_PER_CALL);

    expect(groups.map((g) => g.key)).toEqual(["hvac", ""]);
  });
});

describe("splitExtractionSchema — mixed schema, union cap only", () => {
  test("an over-cap group partitions, and the loose portion partitions under the union cap too", () => {
    // 10 enveloped group leaves = 20 unions > 16, so hvac partitions. The 10
    // loose leaves are ALSO 20 unions — and the loose portion partitions too.
    // The asymmetry that survives is narrower than "the union cap does not
    // partition flat material": when the schema is ALL-flat the module
    // declines to split at all under the union cap alone and returns the
    // input, claiming nothing (`split-schema-unions.test.ts:96` pins that);
    // in a MIXED split the module is actively constructing pieces, so
    // everything it emits must satisfy the caps it was given.
    const looseShape: Record<string, z.ZodType> = {};
    for (let i = 0; i < 10; i++) looseShape[`loose${i}`] = leaf().nullable().optional();
    const groupShape: Record<string, z.ZodType> = {};
    for (let i = 0; i < 10; i++) groupShape[`g${i}`] = leaf().nullable().optional();
    const schema = enveloped(
      z
        .object({
          hvac: z.object(groupShape).strict().optional(),
          ...looseShape,
        })
        .strict(),
    );

    const groups = splitExtractionSchema(schema, MAX_NULLABLE_UNIONS_PER_CALL);

    const hvacPieces = groups.filter((g) => g.key === "hvac");
    expect(hvacPieces).toHaveLength(2);
    expect(hvacPieces.map((g) => [g.part, g.parts])).toEqual([
      [0, 2],
      [1, 2],
    ]);

    // The loose remainder packs greedily in declaration order through the same
    // flat machinery the byte cap uses: 8 enveloped leaves = 16 unions fills
    // piece 0, and the remaining 2 ride piece 1 — part/parts, sharing "".
    const loosePieces = groups.filter((g) => g.key === "");
    expect(loosePieces.map((g) => [g.part, g.parts])).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(loosePieces.map((g) => Object.keys((g.schema as z.ZodObject).shape))).toEqual([
      Array.from({ length: 8 }, (_, i) => `loose${i}`),
      ["loose8", "loose9"],
    ]);
    // Loose last, after every group piece.
    expect(groups.at(-1)!.key).toBe("");
  });

  test("the motivating shape — 14 groups plus 47 loose leaves — emits no piece over the caller's cap", () => {
    // The live run's shape (`nest-live-run-evidence.md` §3): 14 groups beside
    // 47 loose enveloped leaves, two unions each. Under the default options
    // (union cap 16, byte cap off) the loose portion used to stay ONE
    // 94-union piece — a provider 400 of exactly the kind ADR 0013 exists to
    // convert into a construction throw. Now every emitted piece satisfies
    // the cap it was given.
    const shape: Record<string, z.ZodType> = {};
    for (let i = 0; i < 14; i++) {
      shape[`group${i}`] = z.object({ leaf: leaf().nullable().optional() }).strict().optional();
    }
    for (let i = 0; i < 47; i++) shape[`loose${i}`] = leaf().nullable().optional();
    const schema = enveloped(z.object(shape).strict());

    const groups = splitExtractionSchema(schema, MAX_NULLABLE_UNIONS_PER_CALL);

    // 14 one-leaf groups (2 unions each, unpartitioned) plus the loose
    // portion partitioned into 6 pieces (47 leaves at 8 per piece: 5×8 + 7).
    const loosePieces = groups.filter((g) => g.key === "");
    expect(groups.filter((g) => g.key !== "")).toHaveLength(14);
    expect(loosePieces).toHaveLength(6);
    for (const piece of groups) {
      expect(nullableUnionCount(piece.schema)).toBeLessThanOrEqual(MAX_NULLABLE_UNIONS_PER_CALL);
    }
  });

  test("a loose portion that fits the union cap stays ONE piece with no part/parts", () => {
    // Partitioning is cap-driven, not shape-driven: under the cap the loose
    // remainder keeps the under-cap shape — one "" piece, no part/parts.
    const groups = splitExtractionSchema(mixedExtraction, MAX_NULLABLE_UNIONS_PER_CALL);

    const loosePieces = groups.filter((g) => g.key === "");
    expect(loosePieces).toHaveLength(1);
    expect(loosePieces[0]!.part).toBeUndefined();
    expect(loosePieces[0]!.parts).toBeUndefined();
    expect(Object.keys((loosePieces[0]!.schema as z.ZodObject).shape)).toEqual([
      "note",
      "yearBuilt",
    ]);
  });
});

describe("splitExtractionSchema — mixed schema, byte cap", () => {
  const mixedEnum = enveloped(
    z
      .object({
        alpha: enumGroup(4).optional(),
        looseA: longEnumLeaf(500).nullable().optional(),
        looseB: longEnumLeaf(501).nullable().optional(),
        looseC: longEnumLeaf(502).nullable().optional(),
        looseD: longEnumLeaf(503).nullable().optional(),
      })
      .strict(),
  );

  test("groups and loose leaves each pack under both caps; every piece fits", () => {
    const byteCap = 900;
    const groups = splitExtractionSchema(mixedEnum, { maxSerializedCharsPerGroup: byteCap });

    // The byte cap binds for both portions: alpha partitions AND the loose
    // leaves partition — more than one entry per portion.
    const alphaPieces = groups.filter((g) => g.key === "alpha");
    const loosePieces = groups.filter((g) => g.key === "");
    expect(alphaPieces.length).toBeGreaterThan(1);
    expect(loosePieces.length).toBeGreaterThan(1);

    for (const group of groups) {
      const size = serializedSize(group.schema);
      expect(size, `piece ${group.key}#${group.part ?? 0} = ${size} chars`).toBeLessThanOrEqual(
        byteCap,
      );
    }

    // The loose pieces share "" with the part/parts vocabulary, land last, and
    // partition the loose keys disjointly in declaration order.
    expect(loosePieces.map((g) => g.part)).toEqual(loosePieces.map((_, i) => i));
    expect(loosePieces.every((g) => g.parts === loosePieces.length)).toBe(true);
    expect(groups.slice(-loosePieces.length).every((g) => g.key === "")).toBe(true);
    const looseKeys = loosePieces.flatMap((g) => Object.keys((g.schema as z.ZodObject).shape));
    expect(looseKeys).toEqual(["looseA", "looseB", "looseC", "looseD"]);
  });

  test("a generous byte cap leaves the loose portion one piece with no part/parts", () => {
    const groups = splitExtractionSchema(mixedEnum, { maxSerializedCharsPerGroup: 100_000 });

    expect(groups.map((g) => [g.key, g.part, g.parts])).toEqual([
      ["alpha", undefined, undefined],
      ["", undefined, undefined],
    ]);
  });

  test("the mixed branch's group pieces are the all-group path's pieces verbatim", () => {
    // The all-group-unchanged pin (design §10): splitting the same groups with
    // no loose leaves produces the same entries — same keys, same partition
    // boundaries, same serialized schemas — under each cap regime.
    const allGroup = enveloped(
      z
        .object({
          alpha: enumGroup(4).optional(),
          beta: enumGroup(4, 100).optional(),
        })
        .strict(),
    );
    const mixed = enveloped(
      z
        .object({
          alpha: enumGroup(4).optional(),
          beta: enumGroup(4, 100).optional(),
          looseA: longEnumLeaf(500).nullable().optional(),
        })
        .strict(),
    );
    const summarize = (schema: z.ZodType, options?: Parameters<typeof splitExtractionSchema>[1]) =>
      splitExtractionSchema(schema, options)
        .filter((g) => g.key !== "")
        .map((g) => [g.key, g.part, g.parts, serializedSize(g.schema)]);

    expect(summarize(mixed)).toEqual(summarize(allGroup));
    expect(summarize(mixed, MAX_NULLABLE_UNIONS_PER_CALL)).toEqual(
      summarize(allGroup, MAX_NULLABLE_UNIONS_PER_CALL),
    );
    expect(summarize(mixed, { maxSerializedCharsPerGroup: 900 })).toEqual(
      summarize(allGroup, { maxSerializedCharsPerGroup: 900 }),
    );
    expect(
      summarize(mixed, { maxNullableUnionsPerGroup: 3, maxSerializedCharsPerGroup: 4_000 }),
    ).toEqual(
      summarize(allGroup, { maxNullableUnionsPerGroup: 3, maxSerializedCharsPerGroup: 4_000 }),
    );
  });

  test("a loose leaf that fits no piece throws ADR 0013's refusal — leaf, size, cap and option", () => {
    // The group fits the cap; only the loose leaf is overweight, so the refusal
    // comes from the loose packing, not the group's.
    const schema = enveloped(
      z
        .object({
          alpha: z.object({ fuel: leaf().nullable().optional() }).strict().optional(),
          huge: longEnumLeaf(900).nullable().optional(),
        })
        .strict(),
    );
    // alpha's one-leaf group piece measures 489 serialized characters; the
    // loose enum leaf's piece is ~620. The cap between them refuses the leaf
    // and passes the group.
    const byteCap = 550;
    const split = (): unknown =>
      splitExtractionSchema(schema, { maxSerializedCharsPerGroup: byteCap });
    expect(split).toThrow(Error);
    // The flat packer's phrasing — "schema has a property" — reads correctly
    // for a loose leaf: there is no enclosing group to anchor it to.
    expect(split).toThrow(/schema has a property "huge"/);
    expect(split).toThrow(/serialized characters/);
    expect(split).toThrow(new RegExp(String(byteCap)));
    expect(split).toThrow(/maxSerializedCharsPerGroup/);
  });
});

describe("splitExtractionSchema — mixed schema edge cases", () => {
  test("a key whose value is an array of envelopes is loose, and rides the loose piece", () => {
    // An array of leaf envelopes is NOT a group (the element is an envelope,
    // not a group object) — today it drags the whole schema into the fallback;
    // the mixed split carries it through the loose machinery instead (design
    // §5.1).
    const schema = z.strictObject({
      hvac: z.strictObject({ fuel: extractedSchema(z.string()) }),
      tags: z.array(extractedSchema(z.string())),
    });

    const groups = splitExtractionSchema(schema);

    expect(groups.map((g) => g.key)).toEqual(["hvac", ""]);
    expect(Object.keys((groups[1]!.schema as z.ZodObject).shape)).toEqual(["tags"]);
  });

  test('a single loose leaf beside groups yields exactly one "" piece', () => {
    const schema = enveloped(
      z
        .object({
          hvac: z.object({ fuel: leaf().nullable().optional() }).strict().optional(),
          attic: z.object({ depth: leaf().nullable().optional() }).strict().optional(),
          note: leaf().nullable().optional(),
        })
        .strict(),
    );

    const groups = splitExtractionSchema(schema);

    expect(groups.map((g) => g.key)).toEqual(["hvac", "attic", ""]);
  });
});
