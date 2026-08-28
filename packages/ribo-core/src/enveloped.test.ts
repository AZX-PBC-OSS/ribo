import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { enveloped, type Enveloped } from "./enveloped.js";
import { extractedSchema, type Extracted } from "./provenance.js";

describe("enveloped() — flat patch", () => {
  const patch = z.object({
    rValue: z.number().nullable().optional(),
    manufacturer: z.string().nullable().optional(),
  });

  test("wraps every leaf as { value, confidence, sourceSpan }", () => {
    const schema = enveloped(patch);

    const parsed = schema.parse({
      rValue: { value: 19, confidence: 0.9, sourceSpan: "R-19" },
      manufacturer: { value: null, confidence: 1, sourceSpan: null },
    });

    expect(parsed).toEqual({
      rValue: { value: 19, confidence: 0.9, sourceSpan: "R-19" },
      manufacturer: { value: null, confidence: 1, sourceSpan: null },
    });
  });
});

describe("enveloped() — stripping .optional()/.nullable() before wrapping", () => {
  // The property the whole refactor rests on (task brief): without the strip,
  // `X.nullable().optional()` becomes `value: X.nullable().nullable()` — a doubly-nullable leaf
  // that serializes to a NESTED `anyOf` in the JSON Schema. A zod-level `.parse()` assertion would
  // not catch this (a doubly-nullable value still parses `null` and a number identically), so
  // these assertions are on the generated JSON Schema itself.
  // Nested inside a wrapping object, matching the shape `z.toJSONSchema(schema).properties?.foo`
  // actually produces below — the top-level `$schema` key that `z.toJSONSchema` adds to a
  // document's root is not present on a nested `properties` entry, so comparing against the
  // top-level output directly would be an apples-to-oranges mismatch, not evidence of anything.
  const expectedLeafSchema = JSON.stringify(
    z.toJSONSchema(z.object({ leaf: extractedSchema(z.number()) })).properties?.leaf,
  );

  test("X.nullable().optional() produces the same JSON Schema as bare extractedSchema(X)", () => {
    const patch = z.object({ atticRValue: z.number().nullable().optional() });
    const schema = enveloped(patch);

    const leaf = z.toJSONSchema(schema).properties?.atticRValue;
    expect(JSON.stringify(leaf)).toBe(expectedLeafSchema);
  });

  test("X.optional().nullable() (the other wrapper order) produces the same JSON Schema", () => {
    const patch = z.object({ atticRValue: z.number().optional().nullable() });
    const schema = enveloped(patch);

    const leaf = z.toJSONSchema(schema).properties?.atticRValue;
    expect(JSON.stringify(leaf)).toBe(expectedLeafSchema);
  });

  test("the leaf's value is NOT doubly-nullable (no nested anyOf)", () => {
    const patch = z.object({ atticRValue: z.number().nullable().optional() });
    const schema = enveloped(patch);

    const leaf = z.toJSONSchema(schema).properties?.atticRValue as {
      properties: { value: unknown };
    };
    const valueSchema = leaf.properties.value;

    // A doubly-nullable value is `{ anyOf: [{ anyOf: [{type:"number"}, {type:"null"}] }, {type:"null"}] }`
    // — an `anyOf` branch that is ITSELF an `anyOf`. The correct, single-nullable value is
    // `{ anyOf: [{type:"number"}, {type:"null"}] }`, whose branches are both leaves.
    expect(valueSchema).toEqual({ anyOf: [{ type: "number" }, { type: "null" }] });
  });
});

describe("enveloped() — nested objects recurse instead of being wrapped whole", () => {
  // This is the defect R1.5 exists to prevent: a nested object must become a nested object of
  // per-leaf envelopes, not a single envelope whose `value` is the whole sub-object. The latter
  // would make a reviewer accept-or-reject the entire matrix as one unit.
  const patch = z.object({
    healthSafety: z
      .object({
        ambientCo: z.enum(["passed", "failed"]).nullable().optional(),
        venting: z.enum(["passed", "failed"]).nullable().optional(),
      })
      .optional(),
  });

  test("each nested leaf gets its own envelope, not one envelope over the whole object", () => {
    const schema = enveloped(patch);

    const parsed = schema.parse({
      healthSafety: {
        ambientCo: { value: "passed", confidence: 1, sourceSpan: "CO was clean" },
        venting: { value: null, confidence: 1, sourceSpan: null },
      },
    });

    expect(parsed.healthSafety.ambientCo.value).toBe("passed");
    expect(parsed.healthSafety.venting.value).toBeNull();

    // If the whole object had been wrapped as one envelope, `healthSafety` itself would carry a
    // top-level `value`/`confidence`/`sourceSpan` instead of the two named tests.
    expect(Object.keys(parsed.healthSafety).sort()).toEqual(["ambientCo", "venting"]);
  });

  test("the nested object's JSON Schema has one envelope per named field, not one over the object", () => {
    const schema = enveloped(patch);
    const jsonSchema = z.toJSONSchema(schema);
    const nested = jsonSchema.properties?.healthSafety as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(Object.keys(nested.properties).sort()).toEqual(["ambientCo", "venting"]);
    // Each named test is itself an envelope (has its own `value`/`confidence`/`sourceSpan`), which
    // a single whole-object envelope would not.
    const ambientCo = nested.properties.ambientCo as { properties: Record<string, unknown> };
    expect(Object.keys(ambientCo.properties).sort()).toEqual(["confidence", "sourceSpan", "value"]);
  });
});

describe("enveloped() — output is fully required and closed, even though the input was not", () => {
  const patch = z.object({
    rValue: z.number().nullable().optional(),
    nested: z.object({ leaf: z.string().nullable().optional() }).optional(),
  });
  const schema = enveloped(patch);

  const validTopLevel = {
    rValue: { value: 19, confidence: 1, sourceSpan: null },
    nested: { leaf: { value: "x", confidence: 1, sourceSpan: null } },
  };

  test("the source patch tolerates a missing key (it is a patch) — sanity check on the fixture", () => {
    expect(patch.safeParse({}).success).toBe(true);
  });

  test("rejects a MISSING top-level key (patch's .optional() did not survive)", () => {
    const { nested } = validTopLevel;
    expect(schema.safeParse({ nested }).success).toBe(false);
  });

  test("rejects a MISSING nested key", () => {
    expect(schema.safeParse({ rValue: validTopLevel.rValue, nested: {} }).success).toBe(false);
  });

  test("rejects an EXTRA top-level key (patch's openness did not survive)", () => {
    expect(schema.safeParse({ ...validTopLevel, extra: 1 }).success).toBe(false);
  });

  test("rejects an EXTRA nested key", () => {
    expect(
      schema.safeParse({
        ...validTopLevel,
        nested: { ...validTopLevel.nested, extra: 1 },
      }).success,
    ).toBe(false);
  });

  test("accepts the fully-specified, closed shape", () => {
    expect(schema.safeParse(validTopLevel).success).toBe(true);
  });
});

describe("enveloped() — arrays recurse into elements, not one envelope for the whole array", () => {
  const elementSchema = z.object({
    systemType: z.string().nullable().optional(),
    capacity: z.number().nullable().optional(),
  });
  const patch = z.object({
    hvac: z.array(elementSchema).optional(),
  });

  test("array element leaves are individually enveloped, not wrapped as one array envelope", () => {
    const schema = enveloped(patch);
    const jsonSchema = z.toJSONSchema(schema);

    const hvac = jsonSchema.properties?.hvac as {
      type: "array";
      items: { properties: Record<string, unknown>; required: string[] };
    };
    expect(hvac.type).toBe("array");
    expect(Object.keys(hvac.items.properties).sort()).toEqual(["capacity", "systemType"]);
    expect(hvac.items.required.sort()).toEqual(["capacity", "systemType"]);

    // A whole-array envelope would have `value`/`confidence`/`sourceSpan` at the top of `hvac`,
    // and no `items.properties`. Instead each leaf carries its own envelope.
    for (const leaf of Object.values(hvac.items.properties)) {
      const envelope = leaf as { properties: Record<string, unknown>; required: string[] };
      expect(Object.keys(envelope.properties).sort()).toEqual([
        "confidence",
        "sourceSpan",
        "value",
      ]);
      expect(envelope.required.sort()).toEqual(["confidence", "sourceSpan", "value"]);
    }

    // Two instances parse with per-leaf envelopes.
    const parsed = schema.parse({
      hvac: [
        {
          systemType: { value: "furnace", confidence: 1, sourceSpan: "furnace" },
          capacity: { value: null, confidence: 1, sourceSpan: null },
        },
        {
          systemType: { value: "ac", confidence: 1, sourceSpan: "ac" },
          capacity: { value: 3, confidence: 1, sourceSpan: "3 tons" },
        },
      ],
    });
    expect(parsed.hvac).toHaveLength(2);
    const first = parsed.hvac[0];
    const second = parsed.hvac[1];
    if (first === undefined || second === undefined) {
      throw new Error("expected two HVAC elements from the schema parse");
    }
    expect(first.systemType.value).toBe("furnace");
    expect(second.capacity.value).toBe(3);
  });

  test("property count does not grow with instance count", () => {
    const schema = enveloped(patch);
    const jsonSchema = z.toJSONSchema(schema);

    // Count the total number of `properties` maps across the schema. An array of objects adds one
    // `items` object with the same leaf count as a single element; expanding the array into N
    // named properties would multiply it.
    const countProperties = (node: unknown): number => {
      if (typeof node !== "object" || node === null) return 0;
      if (Array.isArray(node)) return node.reduce((sum, n) => sum + countProperties(n), 0);
      const obj = node as Record<string, unknown>;
      let sum = 0;
      if (typeof obj.properties === "object" && obj.properties !== null) {
        sum += Object.keys(obj.properties).length;
      }
      for (const value of Object.values(obj)) {
        sum += countProperties(value);
      }
      return sum;
    };

    const before = countProperties(jsonSchema);

    // The static schema is the same regardless of how many elements the data contains.
    schema.parse({ hvac: [] });
    schema.parse({
      hvac: [
        {
          systemType: { value: "furnace", confidence: 1, sourceSpan: "furnace" },
          capacity: { value: null, confidence: 1, sourceSpan: null },
        },
      ],
    });
    schema.parse({
      hvac: Array.from({ length: 100 }, (_, i) => ({
        systemType: { value: String(i), confidence: 1, sourceSpan: null },
        capacity: { value: i, confidence: 1, sourceSpan: null },
      })),
    });

    expect(countProperties(z.toJSONSchema(schema))).toBe(before);
  });

  test("nested arrays recurse uniformly through their element schemas", () => {
    const nestedPatch = z.object({
      matrix: z.array(z.array(z.string())).optional(),
    });
    const schema = enveloped(nestedPatch);

    const parsed = schema.parse({
      matrix: [
        [
          { value: "a", confidence: 1, sourceSpan: "a" },
          { value: "b", confidence: 1, sourceSpan: "b" },
        ],
        [{ value: "c", confidence: 1, sourceSpan: "c" }],
      ],
    });

    expect(parsed.matrix).toEqual([
      [
        { value: "a", confidence: 1, sourceSpan: "a" },
        { value: "b", confidence: 1, sourceSpan: "b" },
      ],
      [{ value: "c", confidence: 1, sourceSpan: "c" }],
    ]);
  });
});

describe("enveloped() — throws on shapes strict structured-output mode cannot express", () => {
  // Every case below pins BOTH halves of the message: the path (what a caller needs to find the
  // field) and the zod constructor name (the diagnostic half — real in 4.4.3, and worth pinning so
  // a future edit to the message can't quietly drop it while the path-only regex keeps passing).
  test("record — throws naming the field path and the constructor name", () => {
    const patch = z.object({ notes: z.record(z.string(), z.string()) });
    expect(() => enveloped(patch)).toThrowError(/"notes".*\(ZodRecord\)/);
  });

  test("union of objects — throws naming the field path and the constructor name", () => {
    const patch = z.object({
      target: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
    });
    expect(() => enveloped(patch)).toThrowError(/"target".*\(ZodUnion\)/);
  });

  test("the path is the DOTTED path for a shape nested inside an object", () => {
    const patch = z.object({
      healthSafety: z.object({ notes: z.record(z.string(), z.string()) }),
    });
    expect(() => enveloped(patch)).toThrowError(/"healthSafety\.notes".*\(ZodRecord\)/);
  });
});

describe("enveloped() — return type is shape-preserving", () => {
  // The property the task brief calls out specifically: a bare `z.ZodObject` return infers as a
  // loose `Record<string, unknown>`, which would silently stop type-checking every field. This
  // test goes through `z.infer<ReturnType<typeof enveloped<...>>>`, NOT the standalone
  // `Enveloped<V>` alias — the brief is explicit that testing the alias alone does not exercise
  // the function's actual return type.
  const patch = z.object({
    rValue: z.number().nullable().optional(),
    nested: z.object({ leaf: z.string().nullable().optional() }).optional(),
  });

  type Actual = z.infer<ReturnType<typeof enveloped<typeof patch>>>;
  type Expected = {
    rValue: Extracted<number>;
    nested: { leaf: Extracted<string> };
  };

  test("z.infer of the derived schema retains the nested shape (type-level only)", () => {
    expectTypeOf<Actual>().toEqualTypeOf<Expected>();

    // Also exercise `patch` at runtime, so the fixture used for the type-level assertion above is
    // proven to actually describe `enveloped()`'s real output, not just a type this test invented.
    const parsed: Actual = enveloped(patch).parse({
      rValue: { value: 19, confidence: 1, sourceSpan: null },
      nested: { leaf: { value: "x", confidence: 1, sourceSpan: null } },
    });
    expect(parsed.nested.leaf.value).toBe("x");
  });

  // `Enveloped<V>` (the standalone, exported, plain-value-space alias) and `EnvelopedShape`/`Actual`
  // above (the schema-space mechanism behind `enveloped()`'s own return type) are DELIBERATELY two
  // separate mechanisms — see enveloped.ts's file header. Separate means neither is proven correct
  // by the other passing: this test puts `Enveloped<V>` directly against the function's real
  // inferred output rather than against a hand-written `Expected`, so the two mechanisms can't
  // silently drift apart.
  //
  // MUTUAL `extends`, not `toEqualTypeOf` — deliberately. `Enveloped<V>` carries `readonly` (see
  // enveloped.ts's doc comment: every sibling field-map type in this package does, as a public
  // immutability signal, regardless of the underlying leaf's own mutability), but
  // `z.infer<ReturnType<typeof enveloped<...>>>` never does, since nothing in the implementation
  // calls `.readonly()`. `toEqualTypeOf` treats that difference as a mismatch; TypeScript's
  // structural `extends` relation does not consider `readonly` at all, so checking `extends` in
  // BOTH directions still proves the two types describe the same required/optional shape (a
  // one-directional `extends` alone would not: `{ a?: X }` failing to extend `{ a: X }` is exactly
  // what catches `Enveloped<V>` quietly re-inheriting the patch's optionality, which is why both
  // directions are asserted) while tolerating the deliberate `readonly` difference.
  test("Enveloped<V> is mutually assignable with the function's actual return type", () => {
    expectTypeOf<Enveloped<z.infer<typeof patch>>>().toExtend<Actual>();
    expectTypeOf<Actual>().toExtend<Enveloped<z.infer<typeof patch>>>();
  });

  // The one thing mutual `extends` cannot see, pinned separately: `Enveloped<V>`'s `readonly`
  // modifier itself. Without this, `Enveloped<V>` could quietly lose `readonly` (as it did during
  // this task's first review pass) and nothing else in this file would catch it.
  test("Enveloped<V> is readonly, unlike the function's own return type", () => {
    const value: Enveloped<z.infer<typeof patch>> = {
      rValue: { value: 19, confidence: 1, sourceSpan: null },
      nested: { leaf: { value: "x", confidence: 1, sourceSpan: null } },
    };

    // @ts-expect-error readonly property — this line must fail to compile, or `Enveloped<V>` has
    // silently stopped being readonly. (A no-op at runtime: `@ts-expect-error` and the reassignment
    // both vanish from emitted JS; the assertion lives entirely in `pnpm typecheck`. A fresh object,
    // not `value.rValue` itself, so the assignment isn't also flagged as a no-op self-assignment.)
    value.rValue = { value: 20, confidence: 1, sourceSpan: null };
  });
});

describe("enveloped() — return type is shape-preserving for arrays", () => {
  const _patch = z.object({
    hvac: z
      .array(
        z.object({
          systemType: z.string().nullable().optional(),
          capacity: z.number().nullable().optional(),
        }),
      )
      .optional(),
  });

  type Actual = z.infer<ReturnType<typeof enveloped<typeof _patch>>>;
  type Expected = {
    hvac: { systemType: Extracted<string>; capacity: Extracted<number> }[];
  };

  test("z.infer of the derived array schema is an array of per-leaf envelopes (type-level only)", () => {
    expectTypeOf<Actual>().toEqualTypeOf<Expected>();
  });

  // The same mutual-`extends` and `readonly` probe as the non-array shape-preserving block:
  // `Enveloped<V>` and `z.infer<ReturnType<typeof enveloped<...>>>` are computed by two different
  // type mechanisms, so they must be checked against each other, not against a hand-written shape.
  test("Enveloped<V> is mutually assignable with the function's actual return type for arrays", () => {
    expectTypeOf<Enveloped<z.infer<typeof _patch>>>().toExtend<Actual>();
    expectTypeOf<Actual>().toExtend<Enveloped<z.infer<typeof _patch>>>();
  });
});
