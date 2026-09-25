import { enveloped } from "../../provenance/enveloped.js";
import type { ExtractionTarget } from "../extractor.js";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { MAX_NULLABLE_UNIONS_PER_CALL, splitExtractionSchema } from "../schema/split-schema.js";
import { prepareGroups } from "./instance-fill.js";
import { perGroupPlan } from "../strategies/per-group.js";
import { singleShotExtractor } from "../single-shot.js";

/**
 * @file `prepareGroups` — the exported prepared-groups builder — and the
 * wire-safe name guard.
 *
 * `PreparedGroup` used to have exactly one production construction site: an
 * inline `.map` inside `scopedInstanceExtractor`. Lifting it into an exported
 * function means a host composing its own phase list builds the same groups the
 * preset builds, and the test fixtures below build them the same way, so the
 * "one construction site" claim cannot drift.
 *
 * The wire-name guard is the second trap a newcomer meets: a structured-output
 * schema name is constrained to `[A-Za-z0-9_-]` by at least one platform route
 * (Helix rejects a colon with a generic `400 validation_failed`, which reads
 * identically to an over-cap schema and costs an afternoon to tell apart). The
 * guard runs where the name is built, at construction — never on the wire.
 */

const widgetValues = z
  .object({
    color: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
  })
  .strict();

const patch = z
  .object({
    widgets: z.array(widgetValues).optional(),
    house: z.object({ name: z.string().nullable().optional() }).strict().optional(),
  })
  .strict();

type PatchValues = z.infer<typeof patch>;

const target: ExtractionTarget<PatchValues> = {
  name: "demo",
  extractionSchema: enveloped(patch),
  instructions: "Demo extraction instructions.",
  examples: [],
};

describe("prepareGroups", () => {
  test("a collection group's piece schema is ONE instance, not an array", () => {
    const groups = splitExtractionSchema(target.extractionSchema, MAX_NULLABLE_UNIONS_PER_CALL);
    const prepared = prepareGroups(target, groups);

    const widgets = prepared.find((p) => p.key === "widgets")!;
    expect(widgets.isCollection).toBe(true);
    const shape = (widgets.schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodType>;
    // The fill call is constrained to a single instance — never the array.
    expect(shape.widgets).not.toBeInstanceOf(z.ZodArray);
    expect(shape.widgets).toBeInstanceOf(z.ZodObject);
  });

  test("jsonSchema matches the narrowed schema, not the raw group schema", () => {
    const groups = splitExtractionSchema(target.extractionSchema, MAX_NULLABLE_UNIONS_PER_CALL);
    const prepared = prepareGroups(target, groups);

    const widgets = prepared.find((p) => p.key === "widgets")!;
    expect(widgets.jsonSchema).toEqual(z.toJSONSchema(widgets.schema, { target: "draft-2020-12" }));
    // And it is NOT the JSON of the raw (array-carrying) group schema the split handed over.
    const raw = groups.find((g) => g.key === "widgets")!;
    expect(widgets.jsonSchema).not.toEqual(z.toJSONSchema(raw.schema, { target: "draft-2020-12" }));
  });

  test("a singleton group keeps the group object as its fill schema", () => {
    const groups = splitExtractionSchema(target.extractionSchema, MAX_NULLABLE_UNIONS_PER_CALL);
    const prepared = prepareGroups(target, groups);

    const house = prepared.find((p) => p.key === "house")!;
    expect(house.isCollection).toBe(false);
    expect(house.schema).toBe(groups.find((g) => g.key === "house")!.schema);
  });

  test("a partitioned group's pieces get distinct wire-safe names and leafKeys matching each piece's schema", () => {
    // 2 enveloped leaves = 4 unions; a cap of 3 partitions the group into two
    // 1-leaf pieces sharing the key.
    const systemsPatch = z.object({ systems: z.array(widgetValues).optional() }).strict();
    type SystemsValues = z.infer<typeof systemsPatch>;
    const systemsTarget: ExtractionTarget<SystemsValues> = {
      name: "demo",
      extractionSchema: enveloped(systemsPatch),
      instructions: "Demo extraction instructions.",
    };
    const pieces = splitExtractionSchema(systemsTarget.extractionSchema, {
      maxNullableUnionsPerGroup: 3,
    });
    expect(pieces).toHaveLength(2);

    const prepared = prepareGroups(systemsTarget, pieces);
    expect(prepared.map((p) => p.name)).toEqual(["demo-systems-fill-0", "demo-systems-fill-1"]);

    for (const piece of prepared) {
      expect(piece.part).toBeDefined();
      expect(piece.leafKeys).toBeDefined();
      // leafKeys are read back out of the piece's own schema — exactly what the
      // piece asks the model for, never a parallel declaration that can drift.
      const shape = (piece.schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodType>;
      const element = shape.systems as z.ZodObject;
      expect([...Object.keys(element.shape)]).toEqual(piece.leafKeys);
    }
  });

  test("a partitioned flat schema's pieces get distinct wire-safe names AND distinct contexts — pieces sharing the empty key would otherwise be unidentifiable on the wire", () => {
    // Long enum values inflate the flat schema's serialized form well past a
    // tight byte cap; splitExtractionSchema returns several pieces sharing
    // key === "" with part/parts distinguishing them. Prepare them and assert
    // each carries a name and a context tied to its part — the wire-side
    // identifier a route-side error would cite.
    const flatEnumPatch = z
      .object({
        a: z.enum(["option-alpha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]),
        b: z.enum(["option-bravo-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]),
        c: z.enum(["option-charlie-cccccccccccccccccccccccccccccc"]),
        d: z.enum(["option-delta-dddddddddddddddddddddddddddddddddd"]),
        e: z.enum(["option-echo-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"]),
        f: z.enum(["option-foxtrot-ffffffffffffffffffffffffffffffffff"]),
      })
      .strict();
    type FlatValues = z.infer<typeof flatEnumPatch>;
    const flatTarget: ExtractionTarget<FlatValues> = {
      name: "demo-flat",
      extractionSchema: enveloped(flatEnumPatch),
      instructions: "Extract leaves.",
    };
    const pieces = splitExtractionSchema(flatTarget.extractionSchema, {
      maxSerializedCharsPerGroup: 1500,
    });
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.key === "")).toBe(true);

    const prepared = prepareGroups(flatTarget, pieces);
    expect(prepared.map((p) => p.name).sort()).toEqual(
      pieces.map((p) => `demo-flat-fill-${p.part}`).sort(),
    );
    // Every name is unique — without the part suffix they would all be
    // "demo-flat-fill", and a route-side error could not say which piece failed.
    expect(new Set(prepared.map((p) => p.name)).size).toBe(prepared.length);
    // Every context is unique for the same reason the name must be: a parse
    // failure on piece 2 of a 3-piece flat schema is otherwise indistinguishable
    // from the piece-1 failure that just preceded it.
    expect(new Set(prepared.map((p) => p.context)).size).toBe(prepared.length);
    for (const piece of prepared) {
      expect(piece.context).toMatch(/^scopedInstanceExtractor: fill for "demo-flat"/);
      if (piece.part !== undefined) {
        expect(piece.context).toContain(`(part ${piece.part + 1}/${piece.parts})`);
      }
    }
  });
});

describe("prepareGroups — a mixed split", () => {
  /**
   * A collection group beside a loose leaf — `splitExtractionSchema`'s mixed
   * branch. Verify-only (mixed-schema-split design §3 row 13, §8 step 4): the
   * loose piece must flow the same `""` arm the flat fallback always used —
   * no array unwrap, the fill name without the group infix, the piece schema
   * by identity. No prepareGroups code changed for the mixed case.
   */
  const mixedPatch = z
    .object({
      widgets: z.array(widgetValues).optional(),
      note: z.string().nullable().optional(),
    })
    .strict();
  type MixedValues = z.infer<typeof mixedPatch>;
  const mixedTarget: ExtractionTarget<MixedValues> = {
    name: "demo-mixed",
    extractionSchema: enveloped(mixedPatch),
    instructions: "Demo extraction instructions.",
    examples: [],
  };

  test('the loose piece is prepared by the existing "" arm, after the groups', () => {
    const pieces = splitExtractionSchema(
      mixedTarget.extractionSchema,
      MAX_NULLABLE_UNIONS_PER_CALL,
    );
    expect(pieces.map((p) => p.key)).toEqual(["widgets", ""]);

    const prepared = prepareGroups(mixedTarget, pieces);

    expect(prepared.map((p) => [p.key, p.name])).toEqual([
      ["widgets", "demo-mixed-widgets-fill"],
      ["", "demo-mixed-fill"],
    ]);
    const loose = prepared[1]!;
    // No unwrap: the loose piece's schema IS the split piece's schema — a
    // strict object of the loose leaves, not a one-instance narrowing.
    expect(loose.isCollection).toBe(false);
    expect(loose.schema).toBe(pieces[1]!.schema);
    expect(Object.keys((loose.schema as z.ZodObject).shape)).toEqual(["note"]);
    // Unpartitioned: no leafKeys narrowing, no part suffix in the context.
    expect(loose.leafKeys).toBeUndefined();
    expect(loose.context).toBe('scopedInstanceExtractor: fill for "demo-mixed"');
  });
});

describe("the wire-safe name guard", () => {
  const colonTarget: ExtractionTarget<PatchValues> = {
    ...target,
    name: "de:mo",
  };

  test("perGroupPlan refuses a target name carrying a colon, naming the character", () => {
    const plan = (): unknown =>
      perGroupPlan({ target: colonTarget, chat: {} as never, model: "m" });
    expect(plan).toThrow(Error);
    expect(plan).toThrow(/de:mo/);
    expect(plan).toThrow(/":" /);
  });

  test("singleShotExtractor refuses it too — the name goes to the wire as-is there", () => {
    const build = (): unknown =>
      singleShotExtractor({ target: colonTarget, chat: {} as never, model: "m" });
    expect(build).toThrow(Error);
    expect(build).toThrow(/":" /);
  });

  test("prepareGroups refuses it where the fill name is built", () => {
    const groups = splitExtractionSchema(
      colonTarget.extractionSchema,
      MAX_NULLABLE_UNIONS_PER_CALL,
    );
    const build = (): unknown => prepareGroups(colonTarget, groups);
    expect(build).toThrow(Error);
    expect(build).toThrow(/":" /);
  });

  test("a colon arriving through a SCHEMA PROPERTY is refused as well — it lands in the piece name", () => {
    const colonKeyPatch = z.object({
      "hvac:system": z.object({ fuel: z.string().nullable().optional() }).strict().optional(),
    });
    type ColonValues = z.infer<typeof colonKeyPatch>;
    const colonKeyTarget: ExtractionTarget<ColonValues> = {
      name: "demo",
      extractionSchema: enveloped(colonKeyPatch),
      instructions: "Demo extraction instructions.",
    };
    const plan = (): unknown =>
      perGroupPlan({ target: colonKeyTarget, chat: {} as never, model: "m" });
    expect(plan).toThrow(/":" /);
  });
});
