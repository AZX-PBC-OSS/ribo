import { z } from "zod";
import { describe, expect, test } from "vitest";

import { assertShapeMapping } from "./shape-mapping.js";
import type { ShapeOperation } from "./shape-operation.js";
import { deriveExtractionShape, deriveExtractionShapePartially } from "./shape-operations.js";

/**
 * @file The partial-derivation surface: `deriveExtractionShapePartially`
 * collects every refusal the applier can find in one pass — classified
 * `local` / `consequential` / `set`, with the consequential culprits named —
 * and applies the operations that survive. `deriveExtractionShape` is the
 * thin throwing wrapper over it: same inputs, same messages, thrown from the
 * canonically-first refusal.
 *
 * The fixture story is the live run in `nest-live-run-evidence.md` §2: one
 * bad operation out of 91 zeroed fourteen good nests, and the refusal named
 * the victim (a retype) rather than the culprit (the drop). These tests pin
 * the two changes that answer it: collect every refusal, and apply the rest.
 */

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

/** A flat schema — the shape the live proposer run nested fourteen ways. */
const flatSchema = z.object({
  yearBuilt: z.string().nullable().optional(),
  squareMeters: z.number().nullable().optional(),
  heatingType: z.enum(["gas", "oil", "electric"]).nullable().optional(),
  hasGarage: z.boolean().nullable().optional(),
  address: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

/** One real group and one collection beside flat leaves, for nest collisions. */
const mixedSchema = z.object({
  client: z.object({
    name: z.string().nullable().optional(),
  }),
  systems: z.array(z.object({ fuel: z.string().nullable().optional() })),
  yearBuilt: z.string().nullable().optional(),
  squareMeters: z.number().nullable().optional(),
});

/** The shape's identity for comparison: both schemas serialized, plus the mapping. */
const artifactJson = (shape: ReturnType<typeof deriveExtractionShape>): string =>
  JSON.stringify({
    extraction: z.toJSONSchema(shape.extractionSchema),
    patch: z.toJSONSchema(shape.patchSchema),
    mapping: shape.mapping,
  });

describe("partial application — the two changes", () => {
  test("five good operations plus two bad ones: the good five apply, both refusals are reported", () => {
    // Must-fail 1. The live incident's shape in miniature: 7 operations, 2
    // bad — today the first throw zeroes all 7.
    const goodOps: ShapeOperation[] = [
      { op: "drop", path: "notes" },
      { op: "retype", path: "yearBuilt", to: "number" },
      { op: "nest", group: "construction", moves: { squareMeters: "footprint.squareMeters" } },
      { op: "nest", group: "location", moves: { address: "address" } },
      { op: "drop", path: "hasGarage" },
    ];
    const badDrop: ShapeOperation = { op: "drop", path: "ghost" };
    const badRetype: ShapeOperation = { op: "retype", path: "squareMeters", to: "number" };
    const operations: ShapeOperation[] = [...goodOps, badDrop, badRetype];

    const { shape, refusals } = deriveExtractionShapePartially(flatSchema, { operations });

    // The artifact is exactly what the five good operations derive alone.
    expect(artifactJson(shape)).toBe(
      artifactJson(deriveExtractionShape(flatSchema, { operations: goodOps })),
    );

    // Exactly two refusals — the caller's verbatim operations, their indexes,
    // class local, and the applier's own messages.
    expect(refusals).toHaveLength(2);
    const byIndex = new Map(refusals.map((refusal) => [refusal.index, refusal]));
    const dropRefusal = byIndex.get(5)!;
    expect(dropRefusal.operation).toBe(badDrop);
    expect(dropRefusal.class).toBe("local");
    expect(dropRefusal.reason).toBe(
      'deriveExtractionShape(): drop names "ghost", which is not a path of the schema.',
    );
    const retypeRefusal = byIndex.get(6)!;
    expect(retypeRefusal.operation).toBe(badRetype);
    expect(retypeRefusal.class).toBe("local");
    expect(retypeRefusal.reason).toContain('retype at "squareMeters" needs a string patch leaf');

    // The throwing surface still throws on the same input, naming one of the two.
    expect(() => deriveExtractionShape(flatSchema, { operations })).toThrow(
      /drop names "ghost"|needs a string patch leaf/,
    );
  });

  test("the cascade: a retype bad only because of a drop is consequential, with the drop named as cause", () => {
    // Must-fail 2 — the live incident itself: the refusal must name the
    // culprit (the drop), not just the victim (the retype).
    const schema = z.object({
      a: z.object({
        b: z.object({
          c: z.string().nullable().optional(),
          d: z.string().nullable().optional(),
        }),
        also: z.string().nullable().optional(),
      }),
      e: z.string().nullable().optional(),
      f: z.string().nullable().optional(),
      g: z.string().nullable().optional(),
    });
    const drop: ShapeOperation = { op: "drop", path: "a.b" };
    const otherGood: ShapeOperation[] = [
      { op: "retype", path: "e", to: "number" },
      { op: "drop", path: "f" },
      { op: "nest", group: "h", moves: { g: "g" } },
    ];
    const operations: ShapeOperation[] = [
      drop,
      { op: "retype", path: "a.b.c", to: "number" },
      ...otherGood,
    ];

    const { shape, refusals } = deriveExtractionShapePartially(schema, { operations });

    // The drop is not itself refused; the artifact is the good set's artifact.
    expect(refusals).toHaveLength(1);
    expect(artifactJson(shape)).toBe(
      artifactJson(deriveExtractionShape(schema, { operations: [drop, ...otherGood] })),
    );

    const refusal = refusals[0]!;
    expect(refusal.class).toBe("consequential");
    expect(refusal.operation).toEqual({ op: "retype", path: "a.b.c", to: "number" });
    expect(refusal.index).toBe(1);
    expect(refusal.reason).toContain('retype names "a.b.c", which is not a leaf of the schema');
    // The culprit is named: the applied drop that removed the target.
    expect(refusal.cause).toEqual({ kind: "operation", operation: drop, index: 0 });
  });

  test("the reverse cascade: a drop refused for emptiness revives the retype under it", () => {
    // Must-fail 3. The drop is refused as set (it empties its parent), the
    // retype APPLIES — later passes validate against the final applied drop
    // set, so a restored leaf is a live target again.
    const schema = z.object({
      only: z.object({ leaf: z.string().nullable().optional() }),
      other: z.string().nullable().optional(),
    });
    const drop: ShapeOperation = { op: "drop", path: "only.leaf" };
    const retype: ShapeOperation = { op: "retype", path: "only.leaf", to: "number" };

    const { shape, refusals } = deriveExtractionShapePartially(schema, {
      operations: [drop, retype],
    });

    expect(refusals).toHaveLength(1);
    const refusal = refusals[0]!;
    expect(refusal.class).toBe("set");
    expect(refusal.operation).toBe(drop);
    expect(refusal.reason).toContain('the object at "only" has no fields left');

    // The retype applied: the leaf survives, extracted as a number.
    expect(shape.mapping.leaves["only.leaf"]).toEqual({
      source: "only.leaf",
      retype: { extraction: "number", patch: "string" },
    });
    expect(artifactJson(shape)).toBe(
      artifactJson(deriveExtractionShape(schema, { operations: [retype] })),
    );
  });

  test('drop "a" plus drop "a.b" is order-independent: same refusals, byte-identical artifacts', () => {
    // Must-fail 4 — pins the fix to today's live order-dependence, where the
    // parent-first order throws not-found and the nested-first order applies
    // both. The operations are a set; both orders now split the same way.
    const schema = z.object({
      a: z.object({
        b: z.string().nullable().optional(),
        c: z.string().nullable().optional(),
      }),
      z: z.string().nullable().optional(),
    });
    const outer: ShapeOperation = { op: "drop", path: "a" };
    const nested: ShapeOperation = { op: "drop", path: "a.b" };

    const forward = deriveExtractionShapePartially(schema, { operations: [outer, nested] });
    const reverse = deriveExtractionShapePartially(schema, { operations: [nested, outer] });

    // Same split either way: the outer drop applies, the nested one is a
    // consequential refusal naming it. (The `index` field necessarily differs
    // between the two submissions — the set does not.)
    for (const result of [forward, reverse]) {
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0]!.class).toBe("consequential");
    }
    expect(forward.refusals[0]!.operation).toEqual(nested);
    expect(reverse.refusals[0]!.operation).toEqual(nested);
    expect(forward.refusals[0]!.cause).toMatchObject({ kind: "operation", operation: outer });
    expect(reverse.refusals[0]!.cause).toMatchObject({ kind: "operation", operation: outer });
    expect(artifactJson(forward.shape)).toBe(artifactJson(reverse.shape));
    expect(artifactJson(forward.shape)).toBe(
      artifactJson(deriveExtractionShape(schema, { operations: [outer] })),
    );
  });

  test("drops that together empty a two-leaf parent: both refused, the parent intact, the rest applied", () => {
    // Must-fail 5. No single drop is at fault — symmetric blame: every drop
    // under the emptied path is refused, each reason naming the emptied path.
    const schema = z.object({
      pair: z.object({
        x: z.string().nullable().optional(),
        y: z.string().nullable().optional(),
      }),
      keep: z.string().nullable().optional(),
    });
    const dropX: ShapeOperation = { op: "drop", path: "pair.x" };
    const dropY: ShapeOperation = { op: "drop", path: "pair.y" };
    const retype: ShapeOperation = { op: "retype", path: "keep", to: "number" };

    const { shape, refusals } = deriveExtractionShapePartially(schema, {
      operations: [dropX, dropY, retype],
    });

    expect(refusals).toHaveLength(2);
    for (const refusal of refusals) {
      expect(refusal.class).toBe("set");
      expect(refusal.reason).toContain('the object at "pair" has no fields left');
    }
    expect(refusals.map((refusal) => refusal.operation)).toEqual(
      expect.arrayContaining([dropX, dropY]),
    );

    // The parent is intact and the unrelated retype applied.
    expect(shape.mapping.leaves["pair.x"]).toEqual({ source: "pair.x" });
    expect(shape.mapping.leaves["pair.y"]).toEqual({ source: "pair.y" });
    expect(shape.mapping.leaves["keep"]).toEqual({
      source: "keep",
      retype: { extraction: "number", patch: "string" },
    });
  });

  test("duplicates: a drop applies once with one set refusal; duplicate regroups are BOTH refused", () => {
    // Must-fail 6. A duplicated drop is redundancy, not conflict: one instance
    // applies. Duplicate regroups carry two move sets — not mergeable, so both
    // are refused with today's merge-the-moves message.
    const duplicated = deriveExtractionShapePartially(surveySchema, {
      operations: [
        { op: "drop", path: "vessel.notes" },
        { op: "drop", path: "vessel.notes" },
      ],
    });
    expect(duplicated.refusals).toHaveLength(1);
    expect(duplicated.refusals[0]!.class).toBe("set");
    expect(duplicated.refusals[0]!.index).toBe(1);
    expect(duplicated.refusals[0]!.reason).toBe(
      'deriveExtractionShape(): drop names "vessel.notes" twice.',
    );
    expect(artifactJson(duplicated.shape)).toBe(
      artifactJson(
        deriveExtractionShape(surveySchema, { operations: [{ op: "drop", path: "vessel.notes" }] }),
      ),
    );

    const regroups = deriveExtractionShapePartially(surveySchema, {
      operations: [
        { op: "regroup", group: "vessel", moves: { notes: "surveyor.notes" } },
        { op: "regroup", group: "vessel", moves: { dimensions: "d" } },
      ],
    });
    expect(regroups.refusals).toHaveLength(2);
    for (const refusal of regroups.refusals) {
      expect(refusal.class).toBe("set");
      expect(refusal.reason).toBe(
        'deriveExtractionShape(): regroup names group "vessel" twice — ' +
          "merge the moves into one operation.",
      );
    }
    // Neither applied: the artifact is pure normalization.
    expect(artifactJson(regroups.shape)).toBe(artifactJson(deriveExtractionShape(surveySchema)));
  });

  test("a pre-existing empty object is a hard refusal in both surfaces, message unchanged", () => {
    // Must-fail 7. Schema defects abort the derivation — no operation subset
    // repairs them, so no partial artifact can exist.
    const schema = z.object({ empty: z.object({}), keep: z.string().nullable().optional() });
    expect(() => deriveExtractionShape(schema)).toThrow(/the object at "empty" has no fields left/);
    expect(() => deriveExtractionShapePartially(schema)).toThrow(
      /the object at "empty" has no fields left/,
    );
  });

  test("a regroup with one array-crossing move is refused whole; another group's regroup applies", () => {
    // Must-fail 8. A regroup is one operation: refusing half its moves would
    // invent a nesting the model never proposed. Atomic per regroup.
    const schema = z.object({
      log: z.object({
        periods: z.array(z.object({ bill: z.number().nullable().optional() })),
        name: z.string().nullable().optional(),
      }),
      vessel: z.object({
        name: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
      }),
    });
    const badRegroup: ShapeOperation = {
      op: "regroup",
      group: "log",
      moves: { name: "periods.name" },
    };
    const goodRegroup: ShapeOperation = {
      op: "regroup",
      group: "vessel",
      moves: { notes: "surveyor.notes" },
    };

    const { shape, refusals } = deriveExtractionShapePartially(schema, {
      operations: [badRegroup, goodRegroup],
    });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.operation).toBe(badRegroup);
    expect(refusals[0]!.class).toBe("local");
    expect(refusals[0]!.reason).toContain(
      'regroup on "log" moves "name" to a destination that passes through or lands on an array',
    );
    // The other group's regroup applied untouched.
    expect(shape.mapping.leaves["vessel.surveyor.notes"]).toEqual({ source: "vessel.notes" });
    expect(shape.mapping.leaves["log.name"]).toEqual({ source: "log.name" });
  });

  test("a declaration the operations violate refuses the DROP (consequential); an unexplained one throws", () => {
    // Must-fail 9. The declaration is the caller's invariant; the drop is the
    // revisable input — so the drop takes the refusal, with the declaration
    // named as cause. A declaration the schema never had is a hard throw in
    // both surfaces: no operation subset repairs it.
    const drop: ShapeOperation = { op: "drop", path: "engines.serialNumber" };
    const { shape, refusals } = deriveExtractionShapePartially(surveySchema, {
      operations: [drop],
      requiredOnCreate: { engines: ["serialNumber"] },
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.operation).toBe(drop);
    expect(refusals[0]!.class).toBe("consequential");
    expect(refusals[0]!.cause).toEqual({
      kind: "declaration",
      declaration: "requiredOnCreate",
      group: "engines",
      leaf: "serialNumber",
    });
    // The leaf survives in the artifact.
    expect(shape.mapping.leaves["engines.serialNumber"]).toEqual({
      source: "engines.serialNumber",
    });
    expect(shape.requiredOnCreate).toEqual({ engines: ["serialNumber"] });

    // The throwing wrapper carries the declaration's own message.
    expect(() =>
      deriveExtractionShape(surveySchema, {
        operations: [drop],
        requiredOnCreate: { engines: ["serialNumber"] },
      }),
    ).toThrow(/does not carry/);

    // A leaf the schema never had: a hard throw, in both surfaces.
    expect(() =>
      deriveExtractionShapePartially(surveySchema, {
        operations: [],
        requiredOnCreate: { engines: ["ghost"] },
      }),
    ).toThrow(/does not carry/);
    expect(() =>
      deriveExtractionShape(surveySchema, {
        operations: [],
        requiredOnCreate: { engines: ["ghost"] },
      }),
    ).toThrow(/does not carry/);
  });

  test("wrapper equivalence: the thrown message is the canonically-first refusal's reason, byte for byte", () => {
    // Must-fail 10.
    const cases: { schema: z.ZodObject; operations: ShapeOperation[] }[] = [
      // Two bad ops, one refusal each.
      {
        schema: flatSchema,
        operations: [
          { op: "drop", path: "ghost" },
          { op: "retype", path: "squareMeters", to: "number" },
        ],
      },
      // A consequential pair: both reported, the wrapper throws one.
      {
        schema: flatSchema,
        operations: [
          { op: "drop", path: "yearBuilt" },
          { op: "retype", path: "yearBuilt", to: "number" },
        ],
      },
      // Duplicates.
      {
        schema: flatSchema,
        operations: [
          { op: "drop", path: "notes" },
          { op: "drop", path: "notes" },
        ],
      },
      // An emptying set.
      {
        schema: z.object({ only: z.object({ leaf: z.string().nullable().optional() }) }),
        operations: [{ op: "drop", path: "only.leaf" }],
      },
    ];
    for (const { schema, operations } of cases) {
      const { refusals } = deriveExtractionShapePartially(schema, { operations });
      expect(refusals.length).toBeGreaterThan(0);
      let thrown: unknown;
      try {
        deriveExtractionShape(schema, { operations });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(refusals[0]!.reason);
    }

    // The assertion above is TRUE BY CONSTRUCTION once the wrapper throws
    // `first.reason` — it pins that the wrapper does what it says, and nothing
    // about whether that text is what the pre-partial applier threw. A review
    // caught it passing for the wrong reason. So pin one case against the
    // literal text, copied from the throwing applier before this change: a
    // regression that altered the message would satisfy the loop above and fail
    // here. The broad byte-equivalence guarantee is carried by the ~38
    // `.toThrow(/…/)` assertions in `shape-operations.test.ts`, which all pass
    // untouched; this is the one that cannot drift with the implementation.
    expect(() =>
      deriveExtractionShape(flatSchema, { operations: [{ op: "drop", path: "ghost" }] }),
    ).toThrow('deriveExtractionShape(): drop names "ghost", which is not a path of the schema.');
  });

  test("every partial artifact passes assertShapeMapping — no refusal path skips the post-condition", () => {
    // Must-fail 13. A partially-applied artifact is a full
    // DerivedExtractionShape, never a schema with holes.
    const cases: { schema: z.ZodObject; operations: ShapeOperation[] }[] = [
      {
        schema: flatSchema,
        operations: [
          { op: "drop", path: "ghost" },
          { op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } },
        ],
      },
      {
        schema: surveySchema,
        operations: [
          { op: "drop", path: "vessel" },
          { op: "regroup", group: "vessel", moves: { notes: "n" } },
          { op: "retype", path: "engines.ratingKw", to: "number" },
        ],
      },
      {
        schema: mixedSchema,
        operations: [
          { op: "nest", group: "client", moves: { yearBuilt: "built" } },
          { op: "nest", group: "meta", moves: { systems: "systems" } },
          { op: "drop", path: "squareMeters" },
        ],
      },
    ];
    for (const { schema, operations } of cases) {
      const { shape, refusals } = deriveExtractionShapePartially(schema, { operations });
      expect(refusals.length).toBeGreaterThan(0);
      // The post-condition runs inside the derivation; re-asserting it here
      // pins that a partial artifact satisfies it as a whole artifact.
      assertShapeMapping(shape.mapping, shape.extractionSchema, shape.patchSchema);
    }
  });
});

describe("partial application — nest refusals, classified", () => {
  test("a nest group naming a dropped key is consequential, the drop named as cause", () => {
    const drop: ShapeOperation = { op: "drop", path: "hasGarage" };
    const nest: ShapeOperation = {
      op: "nest",
      group: "hasGarage",
      moves: { yearBuilt: "yearBuilt" },
    };
    const { shape, refusals } = deriveExtractionShapePartially(flatSchema, {
      operations: [drop, nest],
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.operation).toBe(nest);
    expect(refusals[0]!.class).toBe("consequential");
    expect(refusals[0]!.cause).toEqual({ kind: "operation", operation: drop, index: 0 });
    expect(refusals[0]!.reason).toContain('nest names group "hasGarage", which a drop removed');
    expect(artifactJson(shape)).toBe(
      artifactJson(deriveExtractionShape(flatSchema, { operations: [drop] })),
    );
  });

  test("a nest source naming a dropped leaf is consequential; a never-present source is local", () => {
    const drop: ShapeOperation = { op: "drop", path: "yearBuilt" };
    const droppedSource: ShapeOperation = {
      op: "nest",
      group: "meta",
      moves: { yearBuilt: "yearBuilt" },
    };
    const neverThere: ShapeOperation = { op: "nest", group: "meta", moves: { nope: "nope" } };

    const consequential = deriveExtractionShapePartially(flatSchema, {
      operations: [drop, droppedSource],
    });
    expect(consequential.refusals).toHaveLength(1);
    expect(consequential.refusals[0]!.class).toBe("consequential");
    expect(consequential.refusals[0]!.cause).toEqual({
      kind: "operation",
      operation: drop,
      index: 0,
    });
    expect(consequential.refusals[0]!.reason).toContain(
      'nest on "meta" moves "yearBuilt", which is not a top-level leaf of the schema',
    );

    const local = deriveExtractionShapePartially(flatSchema, { operations: [neverThere] });
    expect(local.refusals).toHaveLength(1);
    expect(local.refusals[0]!.class).toBe("local");
  });

  test("a nest group shadowing a surviving top-level key is local", () => {
    const { shape, refusals } = deriveExtractionShapePartially(mixedSchema, {
      operations: [{ op: "nest", group: "client", moves: { yearBuilt: "built" } }],
    });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.class).toBe("local");
    expect(refusals[0]!.reason).toContain(
      'nest names group "client", which is already a top-level key of the schema and stays one',
    );
    expect(artifactJson(shape)).toBe(artifactJson(deriveExtractionShape(mixedSchema)));
  });

  test("duplicate nests and doubly-moved sources refuse BOTH nests, set class", () => {
    const duplicates = deriveExtractionShapePartially(flatSchema, {
      operations: [
        { op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } },
        { op: "nest", group: "construction", moves: { squareMeters: "squareMeters" } },
      ],
    });
    expect(duplicates.refusals).toHaveLength(2);
    for (const refusal of duplicates.refusals) {
      expect(refusal.class).toBe("set");
      expect(refusal.reason).toBe(
        'deriveExtractionShape(): nest names group "construction" twice — ' +
          "merge the moves into one operation.",
      );
    }

    const contested = deriveExtractionShapePartially(flatSchema, {
      operations: [
        { op: "nest", group: "construction", moves: { yearBuilt: "yearBuilt" } },
        { op: "nest", group: "location", moves: { yearBuilt: "yearBuilt" } },
      ],
    });
    expect(contested.refusals).toHaveLength(2);
    for (const refusal of contested.refusals) {
      expect(refusal.class).toBe("set");
      expect(refusal.reason).toBe(
        'deriveExtractionShape(): nests "construction" and "location" both move "yearBuilt" — ' +
          "a source may be moved by at most one nest.",
      );
    }
    // Neither nest applied: the artifact is pure normalization.
    expect(artifactJson(contested.shape)).toBe(artifactJson(deriveExtractionShape(flatSchema)));
  });

  test("intrinsic nest defects are local: unusable group name, empty moves, bad destinations", () => {
    const cases: { nest: ShapeOperation; reason: RegExp }[] = [
      {
        nest: { op: "nest", group: "a.b", moves: { yearBuilt: "yearBuilt" } },
        reason: /is not a usable top-level object key/,
      },
      {
        nest: { op: "nest", group: "construction", moves: {} },
        reason: /with an empty moves record/,
      },
      {
        nest: { op: "nest", group: "construction", moves: { yearBuilt: "" } },
        reason: /to an empty destination/,
      },
      {
        nest: {
          op: "nest",
          group: "construction",
          moves: { yearBuilt: "a", squareMeters: "a" },
        },
        reason: /to the same destination/,
      },
      {
        nest: { op: "nest", group: "meta", moves: { systems: "systems" } },
        reason: /is a collection, not a top-level leaf/,
      },
      {
        nest: { op: "nest", group: "meta", moves: { "client.name": "name" } },
        reason: /a nest source is one segment/,
      },
    ];
    for (const { nest, reason } of cases) {
      const { refusals } = deriveExtractionShapePartially(mixedSchema, { operations: [nest] });
      expect(refusals).toHaveLength(1);
      expect(refusals[0]!.class).toBe("local");
      expect(refusals[0]!.reason).toMatch(reason);
    }
  });

  test("the freed-name cascade: a nest whose name a refused nest would have freed is refused too", () => {
    // The dependency the drop-only design did not have: nest B's group name is
    // free only while nest A (which moves that leaf away) applies. Refusing A
    // un-frees the name, so B must be refused as well — a bounded cascade over
    // the nest set, not a fixpoint over batches.
    const nestA: ShapeOperation = {
      op: "nest",
      group: "construction",
      moves: { yearBuilt: "built", ghost: "ghost" }, // `ghost` is absent: A is refused
    };
    const nestB: ShapeOperation = { op: "nest", group: "yearBuilt", moves: { squareMeters: "sm" } };

    for (const operations of [
      [nestA, nestB],
      [nestB, nestA],
    ]) {
      const { shape, refusals } = deriveExtractionShapePartially(mixedSchema, { operations });
      expect(refusals).toHaveLength(2);
      const byOp = new Map(refusals.map((refusal) => [refusal.operation, refusal]));
      expect(byOp.get(nestA)!.class).toBe("local");
      expect(byOp.get(nestA)!.reason).toContain(
        'nest on "construction" moves "ghost", which is not a top-level leaf of the schema',
      );
      expect(byOp.get(nestB)!.class).toBe("local");
      expect(byOp.get(nestB)!.reason).toContain(
        'nest names group "yearBuilt", which is already a top-level key of the schema and stays one',
      );
      // Nothing nested: the artifact is pure normalization.
      expect(artifactJson(shape)).toBe(artifactJson(deriveExtractionShape(mixedSchema)));
    }
  });

  test("provenance naming a nest-moved leaf refuses the nest; naming a dropped group refuses the drop", () => {
    // Declarations are the caller's invariants; the operations take the
    // refusal. After the nest is refused the leaf is a top-level leaf again,
    // where "none" is legal.
    const nest: ShapeOperation = {
      op: "nest",
      group: "construction",
      moves: { yearBuilt: "yearBuilt" },
    };
    const moved = deriveExtractionShapePartially(flatSchema, {
      operations: [nest],
      provenance: { yearBuilt: "none" },
    });
    expect(moved.refusals).toHaveLength(1);
    expect(moved.refusals[0]!.operation).toBe(nest);
    expect(moved.refusals[0]!.class).toBe("consequential");
    expect(moved.refusals[0]!.cause).toEqual({
      kind: "declaration",
      declaration: "provenance",
      group: "yearBuilt",
    });
    expect(moved.refusals[0]!.reason).toMatch(
      /provenance names group "yearBuilt".*moved into a nest group/,
    );
    expect(moved.shape.mapping.leaves["yearBuilt"]).toEqual({ source: "yearBuilt" });
    expect(moved.shape.provenance).toEqual({ yearBuilt: "none" });

    const drop: ShapeOperation = { op: "drop", path: "engines" };
    const dropped = deriveExtractionShapePartially(surveySchema, {
      operations: [drop],
      provenance: { engines: "row" },
    });
    expect(dropped.refusals).toHaveLength(1);
    expect(dropped.refusals[0]!.operation).toBe(drop);
    expect(dropped.refusals[0]!.class).toBe("consequential");
    expect(dropped.refusals[0]!.cause).toEqual({
      kind: "declaration",
      declaration: "provenance",
      group: "engines",
    });
    expect(dropped.refusals[0]!.reason).toMatch(/provenance names group "engines"/);
    expect(dropped.shape.mapping.leaves["engines.make"]).toEqual({ source: "engines.make" });
    expect(dropped.shape.provenance).toEqual({ engines: "row" });
  });

  test("provenance naming a nest group is a hard refusal in both surfaces — no operation explains it", () => {
    const nest: ShapeOperation = {
      op: "nest",
      group: "construction",
      moves: { yearBuilt: "yearBuilt" },
    };
    for (const surface of [deriveExtractionShape, deriveExtractionShapePartially]) {
      expect(() =>
        surface(flatSchema, { operations: [nest], provenance: { construction: "row" } }),
      ).toThrow(/provenance names group "construction", which a nest creates/);
    }
  });
});
