import {
  describeExtraction,
  MAX_NULLABLE_UNIONS_PER_CALL,
  parseSchemaPlan,
  planFingerprint,
  SCHEMA_PLAN_CONTRACT_VERSION,
  serializedNestingDepth,
} from "@azx/ribo-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { expect, test } from "vitest";

import { SchemaInspectReportSchema, SchemaInspectError, inspectSchema } from "./index.js";
import type { SchemaInspectOptions } from "./index.js";
import { inspectSchemaWithPlan } from "./inspect-schema.js";
import { convertDocument } from "./inspect/convert.js";
import { schemaFingerprint } from "./inspect/fingerprint.js";
import type { PlannedPackedCallRow } from "./inspect/planned.js";
import { selectPieceCharsThreshold } from "./inspect/threshold-rows.js";

/**
 * @file The report's measure agreement (design §3), the depth threshold, the
 * self-parsed versioned contract, and the must-fail and could-not-run classes
 * (design §11, Decisions 8/9): every number the report carries is deep-equal
 * to what `describeExtraction` reports for the same converted schema and
 * options; every refusal is carried verbatim; nothing is ever guessed.
 */

// --- Fixtures -----------------------------------------------------------------

const grouped = {
  type: "object",
  description: "Home overview",
  properties: {
    home: {
      type: "object",
      description: "Home",
      properties: {
        address: { type: "string", description: "Street address" },
        yearBuilt: { type: "number", description: "Year built", nullable: true },
      },
      required: ["address", "yearBuilt"],
    },
    notes: { type: "string", description: "Freeform notes", nullable: true },
  },
  required: ["home", "notes"],
};

const mixed = {
  type: "object",
  properties: {
    alpha: {
      type: "object",
      properties: {
        a1: { type: "string", nullable: true },
        a2: { type: "number", nullable: true },
      },
      required: ["a1", "a2"],
    },
    beta: {
      type: "object",
      properties: {
        b1: { type: "string", nullable: true },
        b2: { type: "number", nullable: true },
      },
      required: ["b1", "b2"],
    },
    note: { type: "string", nullable: true },
  },
  required: ["alpha", "beta", "note"],
};

const flat = {
  type: "object",
  properties: {
    f1: { type: "string", nullable: true },
    f2: { type: "number", nullable: true },
    f3: { type: "boolean", nullable: true },
    f4: { type: "string", nullable: true },
  },
  required: ["f1", "f2", "f3", "f4"],
};

const collections = {
  type: "object",
  properties: {
    hvac: {
      type: "array",
      description: "Systems",
      items: {
        type: "object",
        properties: {
          fuel: { type: "string", nullable: true },
          efficiency: { type: "number", nullable: true },
        },
        required: ["fuel", "efficiency"],
      },
    },
    dhw: {
      type: "array",
      items: {
        type: "object",
        properties: { waterType: { type: "string", nullable: true } },
        required: ["waterType"],
      },
    },
  },
  required: ["hvac", "dhw"],
};

// The could-not-fit fixture: one group with one leaf. An enveloped leaf costs
// two nullable unions, so under a union cap of 1 no piece can ever fit it —
// the split refuses, and the report carries the refusal verbatim (criterion
// 10c; the core-side overweight fixture's seventeen `.nullable()` wrappers are
// the same shape seen from a document, which can only speak `nullable: true`).
const unfitLeaf = {
  type: "object",
  properties: {
    home: {
      type: "object",
      properties: { address: { type: "string", nullable: true } },
      required: ["address"],
    },
  },
  required: ["home"],
};

const deeplyNested = {
  type: "object",
  properties: {
    a: {
      type: "object",
      properties: {
        b: {
          type: "object",
          properties: {
            c: {
              type: "object",
              properties: { d: { type: "string", nullable: true } },
              required: ["d"],
            },
          },
          required: ["c"],
        },
      },
      required: ["b"],
    },
  },
  required: ["a"],
};

/** The corpus: every branch the split takes, as documents. */
const corpus: Record<string, unknown> = {
  grouped,
  mixed,
  flat,
  collections,
  unfitLeaf,
};

/** The cap matrix, in the idiom of `describe-extraction-agreement.test.ts`. */
const capSets: Record<"none" | "unions" | "bytes" | "both", SchemaInspectOptions> = {
  none: {},
  unions: { maxNullableUnionsPerGroup: 3 },
  bytes: { maxSerializedCharsPerGroup: 900 },
  both: { maxNullableUnionsPerGroup: 3, maxSerializedCharsPerGroup: 900 },
};

/** The document fixtures are plain literals; the converter wants its JSONSchema type. */
const asJsonSchema = (document: unknown): Parameters<typeof z.fromJSONSchema>[0] =>
  document as Parameters<typeof z.fromJSONSchema>[0];

// --- Measure agreement (criterion 2) --------------------------------------------

test("whole, pieces, path, flatReason, callShape and refusal deep-equal describeExtraction", () => {
  for (const [name, document] of Object.entries(corpus)) {
    for (const [capsName, caps] of Object.entries(capSets)) {
      const report = inspectSchema(document, caps);
      // The same conversion the loader runs — the tests hold the report
      // against core's own dry run over that converted schema.
      const schema = z.fromJSONSchema(asJsonSchema(document), {
        defaultTarget: "openapi-3.0",
      }) as z.ZodObject;
      const description = describeExtraction({ schema, ...caps });

      expect(report.whole, `${name} × ${capsName} whole`).toEqual(description.whole);
      expect(report.pieces, `${name} × ${capsName} pieces`).toEqual(
        description.pieces?.map((piece) => ({
          key: piece.key,
          ...(piece.part === undefined ? {} : { part: piece.part, parts: piece.parts }),
          nullableUnions: piece.nullableUnions,
          serializedChars: piece.serializedChars,
          depth: piece.depth,
        })),
      );
      expect(report.path, `${name} × ${capsName} path`).toBe(description.path);
      expect(report.flatReason, `${name} × ${capsName} flatReason`).toEqual(description.flatReason);
      expect(report.callShape, `${name} × ${capsName} callShape`).toBe(description.callShape);
      expect(report.refusal, `${name} × ${capsName} refusal`).toEqual(description.refusal);
    }
  }
});

test("the matrix exercises the branches it exists for", () => {
  // A coverage pin, in the agreement suite's idiom: an edit that shrinks the
  // coverage fails here and must re-justify the branch it dropped.
  const cell = (document: unknown, caps: SchemaInspectOptions): string => {
    const report = inspectSchema(document, caps);
    if (report.refusal !== undefined) return `refusal:${report.refusal.stage}`;
    return `${report.callShape}:${report.pieces?.length ?? 0}`;
  };
  expect(cell(unfitLeaf, capSets.none)).toBe("single-shot:1");
  expect(cell(unfitLeaf, { maxNullableUnionsPerGroup: 1 })).toBe("refusal:split");
  expect(cell(flat, capSets.unions)).toBe("per-group:1");
  expect(cell(flat, capSets.bytes)).toBe("per-group:2");
  expect(cell(mixed, capSets.both)).toBe("per-group:5");
  expect(cell(collections, capSets.unions)).toBe("per-group:3");
});

// --- Thresholds (criterion 5) ----------------------------------------------------

test("a depth cap reports the breach by the measure the split's header probe records", () => {
  const report = inspectSchema(deeplyNested, { maxDepth: 3 });
  expect(report.thresholds).toHaveLength(1);
  const row = report.thresholds![0]!;
  expect(row.measure).toBe("depth");
  expect(row.layout).toBe("shared");
  expect(row).not.toHaveProperty("piece");
  expect(row.limit).toBe(3);
  expect(row.breached).toBe(true);
  // The same number the split's header probe records: `serializedNestingDepth`
  // over the derived schema `describeExtraction` measured.
  const schema = z.fromJSONSchema(asJsonSchema(deeplyNested), {
    defaultTarget: "openapi-3.0",
  }) as z.ZodObject;
  const derived = describeExtraction({ schema }).shape!.extractionSchema;
  expect(row.measured).toBe(serializedNestingDepth(derived));
  expect(row.measured).toBe(report.whole?.depth);
  expect(row.measured).toBeGreaterThan(3);
});

test("no threshold option supplied, no threshold row exists", () => {
  const report = inspectSchema(grouped);
  expect(report.thresholds).toBeUndefined();
});

test("a pieceChars cap reports the worst piece by name", () => {
  const report = inspectSchema(mixed, { maxPieceChars: 1 });
  const row = report.thresholds![0]!;
  expect(row.measure).toBe("pieceChars");
  expect(row.layout).toBe("rule-based");
  expect(row.limit).toBe(1);
  expect(row.breached).toBe(true);
  expect(row.measured).toBe(report.worstPiece?.serializedChars);
  expect(row.piece).toBe(
    report.worstPiece?.part === undefined
      ? report.worstPiece?.key
      : `${report.worstPiece.key}-${report.worstPiece.part}`,
  );
});

test("a threshold over a refused split measures null and does not breach", () => {
  const report = inspectSchema(unfitLeaf, {
    maxNullableUnionsPerGroup: 1,
    maxPieceChars: 1,
  });
  expect(report.refusal?.stage).toBe("split");
  expect(report.pieces).toBeUndefined();
  expect(report.worstPiece).toBeNull();
  const row = report.thresholds!.find((entry) => entry.measure === "pieceChars")!;
  expect(row.measured).toBeNull();
  expect(row.breached).toBe(false);
});

// --- The versioned contract (criterion 9) ----------------------------------------

test("the serialized report parses against its own zod shape and names the core version", () => {
  const report = inspectSchema(grouped, { maxDepth: 12, maxPieceChars: 4096 });
  expect(report.contractVersion).toBe(4);
  expect(report.planFingerprint).toBeUndefined();
  expect(report.planned).toBeUndefined();
  const round = SchemaInspectReportSchema.parse(JSON.parse(JSON.stringify(report)));
  // Compile-time: the zod schema's inferred shape and the report interface are
  // the same contract — a field added to one and not the other fails here.
  const asReport: typeof round = report;
  const fromRound: typeof report = round;
  expect(asReport).toEqual(fromRound);
  const coreManifest = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../node_modules/@azx/ribo-core/package.json", import.meta.url)),
      "utf8",
    ),
  ) as { version: string };
  expect(report.coreVersion).toBe(coreManifest.version);
});

// --- Planned v4 reports ------------------------------------------------------------

const packedRow = (size: number): PlannedPackedCallRow => ({
  semantic: "Synthetic planned piece",
  key: "home",
  requestName: "planned-packed-call",
  paths: ["home.identity.address"],
  callIndex: 1,
  callCount: 1,
  nullableUnions: 0,
  serializedChars: size,
  depth: 1,
});

test("piece thresholds cover rule-based-only, planned-only, both and neither size breaches", () => {
  const cases = [
    { name: "rule-based only", rule: 200, planned: 100, limit: 150 },
    { name: "planned only", rule: 100, planned: 200, limit: 150 },
    { name: "both", rule: 200, planned: 300, limit: 150 },
    { name: "neither", rule: 100, planned: 120, limit: 150 },
  ];
  for (const entry of cases) {
    const rule = { key: "rule", serializedChars: entry.rule };
    const withPlan = selectPieceCharsThreshold({
      limit: entry.limit,
      ruleBased: rule,
      planned: packedRow(entry.planned),
    });
    const withoutPlan = selectPieceCharsThreshold({ limit: entry.limit, ruleBased: rule });
    expect(withPlan.measured, `${entry.name} with plan`).toBe(entry.planned);
    expect(withPlan.layout, `${entry.name} with plan`).toBe("planned");
    expect(withPlan.breached, `${entry.name} with plan`).toBe(entry.planned > entry.limit);
    expect(withoutPlan.measured, `${entry.name} without plan`).toBe(entry.rule);
    expect(withoutPlan.layout, `${entry.name} without plan`).toBe("rule-based");
    expect(withoutPlan.breached, `${entry.name} without plan`).toBe(entry.rule > entry.limit);
  }
});

const plannedDocument = {
  type: "object",
  properties: {
    home: {
      type: "object",
      properties: {
        identity: {
          type: "object",
          properties: {
            address: {
              type: "string",
              nullable: true,
              description:
                "The street address, with enough guidance to make the semantic piece oversized.",
            },
            yearBuilt: {
              type: "number",
              nullable: true,
              description:
                "The construction year, with enough guidance to make the semantic piece oversized.",
            },
          },
          required: ["address", "yearBuilt"],
        },
        condition: {
          type: "object",
          properties: {
            roof: {
              type: "string",
              nullable: true,
              description:
                "The roof condition, with enough guidance to make the semantic piece oversized.",
            },
            heating: {
              type: "string",
              nullable: true,
              description:
                "The heating condition, with enough guidance to make the semantic piece oversized.",
            },
          },
          required: ["roof", "heating"],
        },
      },
      required: ["identity", "condition"],
    },
  },
  required: ["home"],
};

const plannedPiece = {
  name: "Whole home",
  description: "The semantic home layout is reviewed before core packs it.",
  key: "home",
  paths: [
    "home.identity.address",
    "home.identity.yearBuilt",
    "home.condition.roof",
    "home.condition.heating",
  ],
};

const planned = parseSchemaPlan(
  {
    version: SCHEMA_PLAN_CONTRACT_VERSION,
    schemaFingerprint: schemaFingerprint(plannedDocument),
    fieldPaths: plannedPiece.paths,
    pieces: [plannedPiece],
    provenance: {
      model: "stub-model",
      backend: "stub-backend",
      createdAt: "2026-10-01T02:03:04.000Z",
    },
  },
  convertDocument(plannedDocument),
);

// Cuts across the rule-based object groups, so the planned and rule-based worst
// sizes differ: the planned one is larger under a tight cap, smaller under a loose one.
const crossCutPlan = parseSchemaPlan(
  {
    version: SCHEMA_PLAN_CONTRACT_VERSION,
    schemaFingerprint: schemaFingerprint(plannedDocument),
    fieldPaths: plannedPiece.paths,
    pieces: [
      {
        name: "Most of the home",
        description: "Identity and roof are reviewed together.",
        key: "home",
        paths: ["home.identity.address", "home.identity.yearBuilt", "home.condition.roof"],
      },
      {
        name: "Heating",
        description: "Heating is reviewed alone.",
        key: "home",
        paths: ["home.condition.heating"],
      },
    ],
    provenance: {
      model: "stub-model",
      backend: "stub-backend",
      createdAt: "2026-10-01T02:03:04.000Z",
    },
  },
  convertDocument(plannedDocument),
);

test("real reports judge rule-based-only, planned-only, both and neither piece breaches by the selected layout", async () => {
  const measure = async (cap: number) => {
    const withPlan = await inspectSchemaWithPlan(plannedDocument, {
      plan: crossCutPlan,
      maxSerializedCharsPerGroup: cap,
    });
    const rule = inspectSchema(plannedDocument, { maxSerializedCharsPerGroup: cap });
    return {
      planned: Math.max(...withPlan.planned!.packedCalls.map((call) => call.serializedChars)),
      ruleBased: rule.worstPiece!.serializedChars,
    };
  };
  const tight = await measure(1_600);
  const loose = await measure(100_000);
  // Preconditions: each layout is the larger one under one of the caps.
  expect(tight.planned).toBeGreaterThan(tight.ruleBased);
  expect(loose.ruleBased).toBeGreaterThan(loose.planned);

  const between = (low: number, high: number) => Math.floor((low + high) / 2);
  const cases = [
    {
      name: "planned only",
      cap: 1_600,
      limit: between(tight.ruleBased, tight.planned),
      planned: true,
      rule: false,
    },
    {
      name: "rule-based only",
      cap: 100_000,
      limit: between(loose.planned, loose.ruleBased),
      planned: false,
      rule: true,
    },
    { name: "both", cap: 1_600, limit: 1, planned: true, rule: true },
    { name: "neither", cap: 100_000, limit: 100_000, planned: false, rule: false },
  ];
  for (const entry of cases) {
    const withPlan = await inspectSchemaWithPlan(plannedDocument, {
      plan: crossCutPlan,
      maxSerializedCharsPerGroup: entry.cap,
      maxPieceChars: entry.limit,
    });
    const withoutPlan = inspectSchema(plannedDocument, {
      maxSerializedCharsPerGroup: entry.cap,
      maxPieceChars: entry.limit,
    });
    const planRow = withPlan.thresholds!.find((row) => row.measure === "pieceChars")!;
    const ruleRow = withoutPlan.thresholds!.find((row) => row.measure === "pieceChars")!;
    expect(planRow.layout, entry.name).toBe("planned");
    expect(planRow.breached, `${entry.name} with plan`).toBe(entry.planned);
    expect(ruleRow.layout, entry.name).toBe("rule-based");
    expect(ruleRow.breached, `${entry.name} without plan`).toBe(entry.rule);
  }
});

test("the existing no-plan inspectSchema call remains synchronous", () => {
  const report = inspectSchema(grouped, { maxDepth: 50 });
  expect(report).not.toBeInstanceOf(Promise);
  expect(report.contractVersion).toBe(4);
  expect(report.thresholds).toEqual([
    {
      measure: "depth",
      layout: "shared",
      limit: 50,
      measured: report.whole!.depth,
      breached: false,
    },
  ]);
});

test("activated v4 round-trips its exact planned document shape and core plan identity", async () => {
  const report = await inspectSchemaWithPlan(plannedDocument, {
    plan: planned,
    maxSerializedCharsPerGroup: 1_600,
    maxDepth: 50,
    maxPieceChars: 100_000,
  });
  const round = SchemaInspectReportSchema.parse(JSON.parse(JSON.stringify(report)));
  const asReport: typeof round = report;
  const fromRound: typeof report = round;
  expect(asReport).toEqual(fromRound);
  expect(report.contractVersion).toBe(4);
  expect(report.planFingerprint).toBe(await planFingerprint(planned));
  expect(Object.keys(report).sort()).toEqual(
    [
      "contractVersion",
      "cliVersion",
      "coreVersion",
      "schemaFingerprint",
      "planFingerprint",
      "leafCount",
      "splitCaps",
      "groupCount",
      "looseKeyCount",
      "keys",
      "path",
      "callShape",
      "whole",
      "pieces",
      "worstPiece",
      "calls",
      "guidanceCoverage",
      "reformatFindings",
      "granularityViolations",
      "notVisible",
      "thresholds",
      "planned",
    ].sort(),
  );
  expect(Object.keys(report.planned!).sort()).toEqual(
    ["semanticPieces", "packedCalls", "totals", "notes"].sort(),
  );
  expect(Object.keys(report.planned!.semanticPieces[0]!).sort()).toEqual(
    ["name", "key", "paths", "packedCount", "nullableUnions", "serializedChars", "depth"].sort(),
  );
  expect(Object.keys(report.planned!.packedCalls[0]!).sort()).toEqual(
    [
      "semantic",
      "key",
      "requestName",
      "paths",
      "callIndex",
      "callCount",
      "nullableUnions",
      "serializedChars",
      "depth",
    ].sort(),
  );
});

test("a planned report judges only compliant packed calls from an oversized semantic piece", async () => {
  const ruleBased = inspectSchema(plannedDocument);
  const report = await inspectSchemaWithPlan(plannedDocument, {
    plan: planned,
    maxSerializedCharsPerGroup: 1_600,
    maxDepth: 1,
    maxPieceChars: ruleBased.worstPiece!.serializedChars,
  });
  const semantic = report.planned!.semanticPieces[0]!;
  const packed = report.planned!.packedCalls;
  const worst = packed.reduce((current, row) =>
    row.serializedChars > current.serializedChars ? row : current,
  );
  const depthRows = report.thresholds!.filter((row) => row.measure === "depth");
  const pieceRow = report.thresholds!.find((row) => row.measure === "pieceChars")!;

  expect(semantic.serializedChars).toBeGreaterThan(worst.serializedChars);
  expect(semantic.packedCount).toBeGreaterThan(1);
  expect(packed.every((row) => row.serializedChars <= 1_600)).toBe(true);
  expect(report.planned!.totals).toEqual({ semanticPieces: 1, packedCalls: packed.length });
  expect(depthRows).toEqual([
    {
      measure: "depth",
      layout: "shared",
      limit: 1,
      measured: report.whole!.depth,
      breached: true,
    },
  ]);
  expect(pieceRow).toEqual({
    measure: "pieceChars",
    layout: "planned",
    limit: ruleBased.worstPiece!.serializedChars,
    measured: worst.serializedChars,
    breached: false,
    piece: `${semantic.name} — call ${worst.callIndex} of ${worst.callCount}`,
  });
  // The unplanned whole-piece breach is not judged when planned packed calls are the selected layout.
  expect(ruleBased.worstPiece!.serializedChars).toBeGreaterThan(worst.serializedChars);
  expect(report.worstPiece!.serializedChars).toBe(
    Math.max(...report.pieces!.map((piece) => piece.serializedChars)),
  );
});

test("a planned unsplit call uses its semantic name rather than its internal request name", async () => {
  const report = await inspectSchemaWithPlan(plannedDocument, {
    plan: planned,
    maxPieceChars: 1,
  });
  const row = report.thresholds!.find((entry) => entry.measure === "pieceChars")!;
  const worst = report.planned!.packedCalls.reduce((current, call) =>
    call.serializedChars > current.serializedChars ? call : current,
  );
  expect(worst.callCount).toBe(1);
  expect(row.layout).toBe("planned");
  expect(row.piece).toBe(worst.semantic);
  expect(row.piece).not.toBe(worst.requestName);
  expect(row.breached).toBe(true);
});

// --- Unwanted paths (criterion 10) ------------------------------------------------

test("empty, non-schema and unconvertible documents are could-not-run", () => {
  expect(() => inspectSchema({})).toThrow(SchemaInspectError);
  expect(() => inspectSchema("just a string")).toThrow(SchemaInspectError);
  expect(() => inspectSchema([1, 2, 3])).toThrow(SchemaInspectError);
  expect(() => inspectSchema({ hello: "world" })).toThrow(SchemaInspectError);
  // Vocabulary-bearing but not a type the converter knows.
  expect(() => inspectSchema({ type: "banana" })).toThrow(SchemaInspectError);
});

test("a convertible-but-unwalkable document is could-not-run, carrying the walk's own message", () => {
  const scalarArray = {
    type: "object",
    properties: { tags: { type: "array", items: { type: "string" } } },
    required: ["tags"],
  };
  try {
    inspectSchema(scalarArray);
    expect.unreachable("the walk's refusal was swallowed");
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaInspectError);
    // The walk's own path-named message, not a paraphrase, not a count.
    expect((error as Error).message).toContain('the array at "tags"');
  }
});

test("a split refusal is a finding: the refusal verbatim, whole present, pieces absent", () => {
  const report = inspectSchema(unfitLeaf, { maxNullableUnionsPerGroup: 1 });
  const description = describeExtraction({
    schema: z.fromJSONSchema(asJsonSchema(unfitLeaf), {
      defaultTarget: "openapi-3.0",
    }) as z.ZodObject,
    maxNullableUnionsPerGroup: 1,
  });
  expect(report.refusal).toEqual(description.refusal);
  expect(report.refusal?.message).toContain("cannot fit any piece");
  expect(report.whole).toEqual(description.whole);
  expect(report.pieces).toBeUndefined();
  // Everything the walk could measure still stands.
  expect(report.leafCount).toBeGreaterThan(0);
  expect(report.keys).toEqual([{ key: "home", kind: "group" }]);
  expect(report.worstPiece).toBeNull();
});

test("a wire-unsafe group key nulls only the per-group row, carrying the reason", () => {
  const wireUnsafe = {
    type: "object",
    properties: {
      "hvac: system": {
        type: "object",
        properties: { fuel: { type: "string", nullable: true } },
        required: ["fuel"],
      },
    },
    required: ["hvac: system"],
  };
  const report = inspectSchema(wireUnsafe);
  expect(report.calls?.perGroup).toBeNull();
  expect(report.calls?.perGroupReason).toContain("hvac: system");
  // Every other row is intact.
  expect(report.keys).toEqual([{ key: "hvac: system", kind: "group" }]);
  expect(report.path).toBe("grouped");
  expect(report.whole).toBeDefined();
  expect(report.pieces).toHaveLength(1);
  expect(report.calls?.singleShot).toBe(1);
});

test("a flat schema reports presenceNarrowedAtMost null — the preset refuses a zero-group walk", () => {
  const report = inspectSchema(flat);
  expect(report.path).toBe("flat");
  expect(report.groupCount).toBe(0);
  expect(report.calls?.presenceNarrowedAtMost).toBeNull();
  expect(report.calls?.singleShot).toBe(1);
});

test("the default union cap is core's own, and the split used it", () => {
  // Ten enveloped leaves ≈ 10+ unions: over a cap of 3 the mixed schema
  // partitions, under the default it fits whole — the report's default-path
  // single-shot answers that the forwarded default was MAX's, not a restated
  // literal of the CLI's own.
  const underDefault = inspectSchema(mixed);
  expect(underDefault.callShape).toBe("single-shot");
  expect(MAX_NULLABLE_UNIONS_PER_CALL).toBeGreaterThan(underDefault.whole!.nullableUnions - 1);
});
