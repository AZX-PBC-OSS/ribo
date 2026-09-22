import { enveloped } from "@azx/ribo-core";
import { z } from "zod";
import { describe, expect, test } from "vitest";

import { assertWireSafeSchemaName } from "../prompt/extraction-common.js";
import { deriveExtractionShape } from "../shape/shape-operations.js";
import { describeExtraction } from "./describe-extraction.js";
import { splitExtractionSchema } from "./split-schema.js";
import type { SplitOptions } from "./split-schema.js";

/**
 * @file `describeExtraction` — the dry run of the schema split.
 *
 * Every behaviour here is a fact the design's must-fail list names: the
 * grouped/flat verdict with the loose keys named, the refusals carried
 * verbatim from the code that would raise them at construction (derive, name,
 * split), the measured numbers the call-shape selection reads, and the
 * presets' 16-union defaulting. The differential guard — that these answers
 * match what `perGroupPlan` and `schemaExtractor` actually build — is the
 * sibling `describe-extraction-agreement.test.ts`; this suite pins the
 * report's own contents.
 */

const leaf = () => z.string().nullable().optional();

/** The message a real construction would raise — the bar "verbatim" is measured against. */
const splitRefusal = (schema: z.ZodType, options?: SplitOptions): string => {
  try {
    splitExtractionSchema(schema, options);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the split to refuse this schema");
};

describe("describeExtraction — the grouped/flat verdict", () => {
  // 22 unions (10 + 10 + 2) put the whole schema past the 16-union default, so
  // the per-group path is selected — and one loose top-level leaf then sends
  // the split down the flat fallback: one piece, key "", the whole schema.
  const mixedWide = enveloped(
    z
      .object({
        alpha: z
          .object({ a1: leaf(), a2: leaf(), a3: leaf(), a4: leaf(), a5: leaf() })
          .strict()
          .optional(),
        beta: z
          .object({ b1: leaf(), b2: leaf(), b3: leaf(), b4: leaf(), b5: leaf() })
          .strict()
          .optional(),
        note: leaf(),
      })
      .strict(),
  );

  test("two groups plus one loose top-level leaf report path flat, the loose key named, one flat piece", () => {
    const report = describeExtraction({ extractionSchema: mixedWide });

    expect(report.refusal).toBeUndefined();
    expect(report.keys).toEqual([
      { key: "alpha", kind: "group" },
      { key: "beta", kind: "group" },
      { key: "note", kind: "loose" },
    ]);
    expect(report.path).toBe("flat");
    expect(report.flatReason).toEqual({ kind: "loose-keys", keys: ["note"] });
    expect(report.callShape).toBe("per-group");
    expect(report.pieces).toHaveLength(1);
    expect(report.pieces?.[0]?.key).toBe("");
    expect(report.pieces?.[0]?.part).toBeUndefined();
    expect(report.pieces?.[0]?.parts).toBeUndefined();
    // The one flat piece IS the whole schema, so the numbers are the same numbers.
    expect(report.pieces?.[0]?.nullableUnions).toBe(report.whole?.nullableUnions);
    expect(report.pieces?.[0]?.serializedChars).toBe(report.whole?.serializedChars);
  });

  test("a non-object schema reports not-an-object; an empty object reports empty", () => {
    const arrayExtraction = enveloped(
      z.object({ hvac: z.array(z.object({ h1: leaf() }).strict()).optional() }).strict(),
    ).shape.hvac;

    const nonObject = describeExtraction({ extractionSchema: arrayExtraction });
    expect(nonObject.keys).toEqual([]);
    expect(nonObject.path).toBe("flat");
    expect(nonObject.flatReason).toEqual({ kind: "not-an-object" });

    const empty = describeExtraction({ extractionSchema: z.strictObject({}) });
    expect(empty.keys).toEqual([]);
    expect(empty.path).toBe("flat");
    expect(empty.flatReason).toEqual({ kind: "empty" });
    expect(empty.refusal).toBeUndefined();
    expect(empty.callShape).toBe("single-shot");
  });
});

describe("describeExtraction — the call shape and its measurements", () => {
  const small = enveloped(
    z
      .object({
        alpha: z.object({ a1: leaf(), a2: leaf() }).strict().optional(),
        beta: z.object({ b1: leaf(), b2: leaf() }).strict().optional(),
      })
      .strict(),
  );

  test("a schema under the caps reports single-shot: one piece row, the whole schema, no part", () => {
    const report = describeExtraction({ extractionSchema: small });

    expect(report.refusal).toBeUndefined();
    expect(report.path).toBe("grouped");
    expect(report.flatReason).toBeUndefined();
    expect(report.callShape).toBe("single-shot");
    expect(report.pieces).toEqual([
      {
        key: "",
        nullableUnions: report.whole?.nullableUnions,
        serializedChars: report.whole?.serializedChars,
        depth: report.whole?.depth,
      },
    ]);
  });

  test("describing with no caps supplied partitions at the presets' 16-union default", () => {
    // Nine enveloped leaves cost 18 unions — over the 16 the presets default
    // to, under no number the helper invented. The even re-slice is 5+4.
    const nineLeaf = enveloped(
      z
        .object({
          gamma: z
            .object({
              g1: leaf(),
              g2: leaf(),
              g3: leaf(),
              g4: leaf(),
              g5: leaf(),
              g6: leaf(),
              g7: leaf(),
              g8: leaf(),
              g9: leaf(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    );

    const report = describeExtraction({ extractionSchema: nineLeaf });

    expect(report.refusal).toBeUndefined();
    expect(report.callShape).toBe("per-group");
    expect(report.pieces?.map((p) => [p.key, p.part, p.parts])).toEqual([
      ["gamma", 0, 2],
      ["gamma", 1, 2],
    ]);
    for (const piece of report.pieces ?? []) {
      expect(piece.nullableUnions).toBeLessThanOrEqual(16);
    }
  });

  test("a flat schema over a supplied byte cap reports flat pieces sharing the empty key, each under the cap", () => {
    const described = (what: string) =>
      leaf().describe(`${what}: a considerably long vendor-style description text field`);
    const flat = enveloped(
      z
        .object({
          f1: described("f1"),
          f2: described("f2"),
          f3: described("f3"),
          f4: described("f4"),
        })
        .strict(),
    );

    const report = describeExtraction({
      extractionSchema: flat,
      maxSerializedCharsPerGroup: 900,
    });

    expect(report.refusal).toBeUndefined();
    expect(report.path).toBe("flat");
    expect(report.callShape).toBe("per-group");
    expect(report.pieces?.length).toBeGreaterThan(1);
    report.pieces?.forEach((piece, index) => {
      expect(piece.key).toBe("");
      expect(piece.part).toBe(index);
      expect(piece.parts).toBe(report.pieces?.length);
      expect(piece.serializedChars).toBeLessThanOrEqual(900);
    });
  });

  test("a deep-but-legal schema reports depth per piece and for the whole schema, with no refusal", () => {
    // Hand walk of the rendering, one level per `properties` descent: whole
    // and piece "outer" 5 (root → outer → mid → inner → the envelopes),
    // piece "plain" 3. The byte cap sits between the whole schema and its
    // largest group so the per-group path runs without partitioning.
    const deep = enveloped(
      z
        .object({
          outer: z
            .object({
              mid: z.object({ inner: z.object({ a: leaf(), b: leaf() }).strict() }).strict(),
            })
            .strict()
            .optional(),
          plain: z.object({ x: leaf() }).strict().optional(),
        })
        .strict(),
    );

    const report = describeExtraction({
      extractionSchema: deep,
      maxSerializedCharsPerGroup: 1000,
    });

    expect(report.refusal).toBeUndefined();
    expect(report.callShape).toBe("per-group");
    expect(report.whole?.depth).toBe(5);
    expect(report.pieces?.map((p) => [p.key, p.depth])).toEqual([
      ["outer", 5],
      ["plain", 3],
    ]);
  });
});

describe("describeExtraction — refusals are reported, not thrown", () => {
  test("a leaf costing 17 unions against the default cap reports the split's ADR 0013 refusal verbatim", () => {
    // Each `.nullable()` wrapper is one nullable union; seventeen of them
    // price one leaf out of every piece the default cap allows.
    let fat: z.ZodType = z.string();
    for (let i = 0; i < 17; i++) fat = fat.nullable();
    const overweight = z.strictObject({ g: z.strictObject({ fat }) });

    const report = describeExtraction({ extractionSchema: overweight });

    expect(report.refusal?.stage).toBe("split");
    expect(report.refusal?.message).toBe(
      splitRefusal(overweight, {
        maxNullableUnionsPerGroup: 16,
      }),
    );
    expect(report.pieces).toBeUndefined();
    // Everything that was still measurable is still reported.
    expect(report.keys).toEqual([{ key: "g", kind: "group" }]);
    expect(report.path).toBe("grouped");
    expect(report.callShape).toBe("per-group");
    expect(report.whole?.nullableUnions).toBe(17);
  });

  test("a mixed schema over both caps reports the flat packer's refusal verbatim — the live run's failure shape", () => {
    // nest-live-run-evidence.md §3: the flat fallback treats a group as one
    // atomic "property", so a group over the caps beside a loose leaf has
    // nowhere to go. The report must carry that refusal, not throw it.
    const mixed = enveloped(
      z
        .object({
          alpha: z.object({ a1: leaf(), a2: leaf() }).strict().optional(),
          beta: z.object({ b1: leaf(), b2: leaf() }).strict().optional(),
          note: leaf(),
        })
        .strict(),
    );
    const caps = { maxNullableUnionsPerGroup: 3, maxSerializedCharsPerGroup: 900 };

    const report = describeExtraction({ extractionSchema: mixed, ...caps });

    expect(report.refusal?.stage).toBe("split");
    expect(report.refusal?.message).toBe(splitRefusal(mixed, caps));
    expect(report.refusal?.message).toContain('property "alpha"');
    expect(report.pieces).toBeUndefined();
    expect(report.path).toBe("flat");
    expect(report.flatReason).toEqual({ kind: "loose-keys", keys: ["note"] });
  });

  test("a wire-unsafe name reports a name-stage refusal, before the split, with the schema facts still reported", () => {
    const small = enveloped(
      z.object({ alpha: z.object({ a1: leaf() }).strict().optional() }).strict(),
    );
    let expected = "";
    try {
      assertWireSafeSchemaName("bad:name", "describeExtraction");
    } catch (error) {
      expected = (error as Error).message;
    }

    const report = describeExtraction({ extractionSchema: small, name: "bad:name" });

    expect(report.refusal?.stage).toBe("name");
    expect(report.refusal?.message).toBe(expected);
    expect(report.pieces).toBeUndefined();
    expect(report.callShape).toBe("single-shot");
    expect(report.keys).toEqual([{ key: "alpha", kind: "group" }]);
  });

  test("a wire-safe name reports no name refusal", () => {
    const small = enveloped(
      z.object({ alpha: z.object({ a1: leaf() }).strict().optional() }).strict(),
    );
    const report = describeExtraction({ extractionSchema: small, name: "fine-name_123" });
    expect(report.refusal).toBeUndefined();
  });
});

describe("describeExtraction — the raw input shape runs the real derivation first", () => {
  const rawPatch = z
    .object({
      keep: z.object({ a: leaf() }).strict().optional(),
      gone: z.object({ b: leaf() }).strict().optional(),
    })
    .strict();

  test("a drop removing one group reports the shaped keys without it, and carries the derived artifact", () => {
    const report = describeExtraction({
      schema: rawPatch,
      operations: [{ op: "drop", path: "gone" }],
    });

    expect(report.refusal).toBeUndefined();
    expect(report.keys).toEqual([{ key: "keep", kind: "group" }]);
    expect(report.shape).toBeDefined();
    expect(Object.keys(report.shape?.patchSchema.shape ?? {})).toEqual(["keep"]);
  });

  test("a drop naming a path the schema does not carry reports the applier's refusal verbatim", () => {
    let expected = "";
    try {
      deriveExtractionShape(rawPatch, { operations: [{ op: "drop", path: "nope" }] });
    } catch (error) {
      expected = (error as Error).message;
    }

    const report = describeExtraction({
      schema: rawPatch,
      operations: [{ op: "drop", path: "nope" }],
    });

    expect(report.refusal?.stage).toBe("derive");
    expect(report.refusal?.message).toBe(expected);
    // The derivation failed: there is no schema to classify, measure or split.
    expect(report.shape).toBeUndefined();
    expect(report.keys).toBeUndefined();
    expect(report.path).toBeUndefined();
    expect(report.callShape).toBeUndefined();
    expect(report.whole).toBeUndefined();
    expect(report.pieces).toBeUndefined();
  });

  test("provenance rides the derivation: a row-granularity group costs one union per leaf, not two", () => {
    // Ten leaves: enveloped per-leaf is 20 unions (two calls' worth), row
    // granularity is 11 (ten plain leaves plus the row's one span) and fits.
    const tenLeafPatch = z
      .object({
        gamma: z
          .object({
            g1: leaf(),
            g2: leaf(),
            g3: leaf(),
            g4: leaf(),
            g5: leaf(),
            g6: leaf(),
            g7: leaf(),
            g8: leaf(),
            g9: leaf(),
            g10: leaf(),
          })
          .strict()
          .optional(),
      })
      .strict();

    const leafGranular = describeExtraction({ schema: tenLeafPatch });
    expect(leafGranular.whole?.nullableUnions).toBe(20);
    expect(leafGranular.callShape).toBe("per-group");

    const rowGranular = describeExtraction({
      schema: tenLeafPatch,
      provenance: { gamma: "row" },
    });
    expect(rowGranular.whole?.nullableUnions).toBe(11);
    expect(rowGranular.callShape).toBe("single-shot");
  });

  test("the passthrough shape carries no derived artifact", () => {
    const report = describeExtraction({
      extractionSchema: enveloped(rawPatch),
    });
    expect(report.shape).toBeUndefined();
    expect(report.refusal).toBeUndefined();
  });
});

describe("describeExtraction — options misuse is a programming error, thrown", () => {
  const patch = z.object({ a: leaf() }).strict();
  const derived = enveloped(patch);

  test("neither schema key throws", () => {
    // @ts-expect-error — the union requires one schema key; a JS caller's
    // mistake is refused at runtime, and this line failing to error is the
    // type-level half of that guarantee.
    expect(() => describeExtraction({})).toThrow(TypeError);
    // @ts-expect-error — same as above.
    expect(() => describeExtraction({})).toThrow(/pass the plain patch schema under `schema`/);
  });

  test("both schema keys throw", () => {
    // @ts-expect-error — `extractionSchema?: never` on the raw shape makes the
    // pair unrepresentable; the runtime throw is the JS caller's version.
    expect(() => describeExtraction({ schema: patch, extractionSchema: derived })).toThrow(
      /not both/,
    );
  });

  test("derivation options with a passthrough schema throw", () => {
    expect(() =>
      describeExtraction({
        extractionSchema: derived,
        // @ts-expect-error — `operations?: never` on the passthrough shape.
        operations: [{ op: "drop", path: "a" }],
      }),
    ).toThrow(TypeError);
    // @ts-expect-error — `provenance?: never` on the passthrough shape.
    expect(() => describeExtraction({ extractionSchema: derived, provenance: {} })).toThrow(
      TypeError,
    );
  });
});
