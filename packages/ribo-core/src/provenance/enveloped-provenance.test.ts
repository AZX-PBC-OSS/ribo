import { describe, expect, expectTypeOf, test } from "vitest";
import { z } from "zod";

import { enveloped, type Enveloped } from "./enveloped.js";
import type { Extracted } from "./provenance.js";

/**
 * @file Per-group provenance granularity — the `"row"` and `"none"` halves.
 *
 * `enveloped.test.ts` covers the default (`"leaf"`) derivation and must stay
 * untouched by anything here: the default is the regression gate, and the
 * `"no options"` test below is the assertion that says so in this file too.
 */

const roomsPatch = z.object({
  rooms: z
    .array(
      z.object({
        name: z.string().nullable().optional(),
        heatingLoad: z.number().nullable().optional(),
      }),
    )
    .optional(),
  basedata: z
    .object({
      yearBuilt: z.number().nullable().optional(),
    })
    .optional(),
});

describe('enveloped() — "row" granularity', () => {
  test("a collection group's leaves are plain and its element carries one sourceSpan", () => {
    const schema = enveloped(roomsPatch, { provenance: { rooms: "row" } });

    const parsed = schema.parse({
      rooms: [{ name: "L1.Bathrm", heatingLoad: 47, sourceSpan: "L1.Bathrm | 47" }],
      basedata: { yearBuilt: { value: 1972, confidence: 1, sourceSpan: "built in 72" } },
    });

    expect(parsed).toEqual({
      rooms: [{ name: "L1.Bathrm", heatingLoad: 47, sourceSpan: "L1.Bathrm | 47" }],
      basedata: { yearBuilt: { value: 1972, confidence: 1, sourceSpan: "built in 72" } },
    });
  });

  test("the row's sourceSpan is required and nullable, like every other extraction key", () => {
    const schema = enveloped(roomsPatch, { provenance: { rooms: "row" } });

    expect(
      schema.safeParse({
        rooms: [{ name: "L1.Bathrm", heatingLoad: 47 }],
        basedata: { yearBuilt: { value: null, confidence: 0, sourceSpan: null } },
      }).success,
      "a row missing its sourceSpan must be rejected",
    ).toBe(false);
    expect(
      schema.safeParse({
        rooms: [{ name: "L1.Bathrm", heatingLoad: 47, sourceSpan: null }],
        basedata: { yearBuilt: { value: null, confidence: 0, sourceSpan: null } },
      }).success,
    ).toBe(true);
  });

  test("a row leaf is nullable but carries no confidence", () => {
    const schema = enveloped(roomsPatch, { provenance: { rooms: "row" } });
    const rooms = z.toJSONSchema(schema, { target: "draft-2020-12" }).properties?.rooms as {
      items: { properties: Record<string, unknown>; required: string[] };
    };

    expect(Object.keys(rooms.items.properties)).toEqual(["name", "heatingLoad", "sourceSpan"]);
    expect(rooms.items.required).toEqual(["name", "heatingLoad", "sourceSpan"]);
  });

  test("a singleton group gets one sourceSpan for the whole group object", () => {
    const schema = enveloped(roomsPatch, { provenance: { basedata: "row" } });

    const parsed = schema.parse({
      rooms: [
        {
          name: { value: "L1.Bathrm", confidence: 1, sourceSpan: "L1.Bathrm" },
          heatingLoad: { value: 47, confidence: 1, sourceSpan: "47" },
        },
      ],
      basedata: { yearBuilt: 1972, sourceSpan: "built in 72" },
    });

    expect(parsed.basedata).toEqual({ yearBuilt: 1972, sourceSpan: "built in 72" });
  });

  test("a nested array inside a row group is itself a row and gets its own span", () => {
    const patch = z.object({
      ducts: z
        .array(
          z.object({
            label: z.string().nullable().optional(),
            runs: z.array(z.object({ length: z.number().nullable().optional() })).optional(),
          }),
        )
        .optional(),
    });
    const schema = enveloped(patch, { provenance: { ducts: "row" } });

    const parsed = schema.parse({
      ducts: [
        { label: "supply", runs: [{ length: 12, sourceSpan: "12 feet" }], sourceSpan: "supply" },
      ],
    });

    expect(parsed.ducts[0]!.runs[0]).toEqual({ length: 12, sourceSpan: "12 feet" });
  });

  test("a nested plain object inside a row belongs to that row and gets no span of its own", () => {
    const patch = z.object({
      ducts: z
        .array(
          z.object({
            label: z.string().nullable().optional(),
            sizing: z.object({ diameter: z.number().nullable().optional() }).optional(),
          }),
        )
        .optional(),
    });
    const provenance = { ducts: "row" } as const;
    const schema = enveloped(patch, { provenance });

    const row = { label: "supply", sizing: { diameter: 6 }, sourceSpan: "supply, six inch" };
    expect(schema.parse({ ducts: [row] }).ducts[0]).toEqual(row);
    expect(
      schema.safeParse({
        ducts: [{ ...row, sizing: { diameter: 6, sourceSpan: "six inch" } }],
      }).success,
      "a nested object is part of its row, not a row of its own",
    ).toBe(false);

    // And the type says the same thing. A type that granted the nested object a `sourceSpan`
    // would describe a schema the runtime rejects — the two walks have to agree here as much as
    // review and the derivation do.
    type Derived = z.infer<ReturnType<typeof enveloped<typeof patch, typeof provenance>>>;
    expectTypeOf<Derived["ducts"][number]["sizing"]>().toEqualTypeOf<{ diameter: number | null }>();
    // `Enveloped<V, P>` is a separate mechanism from the schema's own return type (see
    // `enveloped.ts`), so it has to be pinned against it here too — a nested object that gained a
    // span in one and not the other would break exactly at the `ToolAdapter` boundary.
    type Values = z.infer<typeof patch>;
    expectTypeOf<Enveloped<Values, typeof provenance>>().toExtend<Derived>();
    expectTypeOf<Derived>().toExtend<Enveloped<Values, typeof provenance>>();
  });
});

describe('enveloped() — "none" granularity', () => {
  test("leaves are plain and nothing carries a span", () => {
    const schema = enveloped(roomsPatch, { provenance: { rooms: "none" } });

    const parsed = schema.parse({
      rooms: [{ name: "L1.Bathrm", heatingLoad: null }],
      basedata: { yearBuilt: { value: 1972, confidence: 1, sourceSpan: "72" } },
    });

    expect(parsed.rooms).toEqual([{ name: "L1.Bathrm", heatingLoad: null }]);
    expect(
      schema.safeParse({
        rooms: [{ name: "L1.Bathrm", heatingLoad: null, sourceSpan: "x" }],
        basedata: { yearBuilt: { value: null, confidence: 0, sourceSpan: null } },
      }).success,
      'a "none" row must not carry a sourceSpan',
    ).toBe(false);
  });
});

describe("enveloped() — the default is untouched", () => {
  test("no options derives exactly what an empty provenance map derives", () => {
    const withoutOptions = z.toJSONSchema(enveloped(roomsPatch), { target: "draft-2020-12" });
    const withEmptyMap = z.toJSONSchema(enveloped(roomsPatch, { provenance: {} }), {
      target: "draft-2020-12",
    });

    expect(JSON.stringify(withEmptyMap)).toBe(JSON.stringify(withoutOptions));
  });

  test("a group absent from the map keeps the leaf envelope", () => {
    const schema = enveloped(roomsPatch, { provenance: { rooms: "row" } });

    expect(
      schema.safeParse({
        rooms: [{ name: "a", heatingLoad: 1, sourceSpan: null }],
        basedata: { yearBuilt: 1972 },
      }).success,
      "basedata was not named, so its leaves must still be envelopes",
    ).toBe(false);
  });
});

describe("enveloped() — a granularity that cannot be honoured throws at build time", () => {
  test("naming a group the values schema does not have", () => {
    expect(() =>
      // @ts-expect-error — the key is checked at the type level too; this pins the runtime.
      enveloped(roomsPatch, { provenance: { roomz: "row" } }),
    ).toThrow(/"roomz"/);
  });

  test("naming a leaf with row granularity — there is no row to hang the span on", () => {
    const patch = z.object({ note: z.string().nullable().optional() });
    expect(() => enveloped(patch, { provenance: { note: "row" } })).toThrow(/"note"/);
  });

  test("a row group that already declares a sourceSpan leaf", () => {
    const patch = z.object({
      rooms: z.array(z.object({ sourceSpan: z.string().nullable().optional() })).optional(),
    });
    expect(() => enveloped(patch, { provenance: { rooms: "row" } })).toThrow(/sourceSpan/);
  });

  test("an unrecognised granularity", () => {
    expect(() =>
      // @ts-expect-error — pins the runtime guard against a JS caller.
      enveloped(roomsPatch, { provenance: { rooms: "cell" } }),
    ).toThrow(/cell/);
  });
});

describe("enveloped() — the granularity map reaches the type level", () => {
  const provenance = { rooms: "row" } as const;
  type Derived = z.infer<ReturnType<typeof enveloped<typeof roomsPatch, typeof provenance>>>;
  type Values = z.infer<typeof roomsPatch>;

  test("a row group's leaves type as plain values and the row carries a span", () => {
    // The runtime half of the same claim, so the two cannot drift: `Derived` is computed from
    // the very call whose output is parsed here.
    expect(
      enveloped(roomsPatch, { provenance }).parse({
        rooms: [{ name: "a", heatingLoad: 1, sourceSpan: "a | 1" }],
        basedata: { yearBuilt: { value: null, confidence: 0, sourceSpan: null } },
      }).rooms[0]!.sourceSpan,
    ).toBe("a | 1");

    expectTypeOf<Derived["rooms"][number]["name"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Derived["rooms"][number]["sourceSpan"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Derived["basedata"]["yearBuilt"]>().toEqualTypeOf<Extracted<number>>();
  });

  test("Enveloped<V, P> is mutually assignable with the derived schema's inferred type", () => {
    expectTypeOf<Enveloped<Values, typeof provenance>>().toExtend<Derived>();
    expectTypeOf<Derived>().toExtend<Enveloped<Values, typeof provenance>>();
  });
});
