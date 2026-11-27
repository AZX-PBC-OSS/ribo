import {
  describeExtraction,
  enveloped,
  parseSchemaPlan,
  plannedPerGroupPlan,
  SCHEMA_PLAN_CONTRACT_VERSION,
  walkFieldInventory,
} from "@azx/ribo-core";
import type { ChatClient, ExtractionTarget, SchemaPlan, SchemaPlanPiece } from "@azx/ribo-core";
import { expect, test } from "vitest";
import type { z } from "zod";

import { inspectSchema } from "./inspect-schema.js";
import type { SplitCapOptions } from "./inspect/calls.js";
import { convertDocument } from "./inspect/convert.js";
import { SchemaInspectError } from "./inspect/error.js";
import { schemaFingerprint } from "./inspect/fingerprint.js";
import { inspectPlanned } from "./inspect/planned.js";
import { selectPieceCharsThreshold } from "./inspect/threshold-rows.js";
import { schemaPlanFreshness } from "./schema-plan.js";

const leaf = (description: string) => ({ type: "string", nullable: true, description });

const nestedDocument = {
  type: "object",
  properties: {
    home: {
      type: "object",
      properties: {
        identity: {
          type: "object",
          properties: {
            address: leaf("The street address, recorded with enough guidance to size the schema."),
            yearBuilt: leaf("The construction year, recorded with enough guidance to size it."),
          },
          required: ["address", "yearBuilt"],
        },
        condition: {
          type: "object",
          properties: {
            roof: leaf("The roof condition, recorded with enough guidance to size the schema."),
            heating: leaf("The heating condition, recorded with enough guidance to size it."),
          },
          required: ["roof", "heating"],
        },
      },
      required: ["identity", "condition"],
    },
    audit: {
      type: "object",
      properties: {
        auditor: leaf("The auditor's name."),
        notes: leaf("Notes from the audit."),
      },
      required: ["auditor", "notes"],
    },
  },
  required: ["home", "audit"],
};

const packingDocument = {
  type: "object",
  properties: { home: nestedDocument.properties.home },
  required: ["home"],
};

const nestedPieces: readonly SchemaPlanPiece[] = [
  {
    name: "Home details",
    description: "Identity and condition facts stay semantically together before packing.",
    key: "home",
    paths: [
      "home.identity.address",
      "home.identity.yearBuilt",
      "home.condition.roof",
      "home.condition.heating",
    ],
  },
  {
    name: "Audit record",
    description: "Audit metadata stays together.",
    key: "audit",
    paths: ["audit.auditor", "audit.notes"],
  },
];

const packingPieces: readonly SchemaPlanPiece[] = [
  {
    name: "Whole home",
    description: "The semantic home layout is reviewed before core packs it.",
    key: "home",
    paths: [
      "home.identity.address",
      "home.identity.yearBuilt",
      "home.condition.roof",
      "home.condition.heating",
    ],
  },
];

function makePlan(document: unknown, pieces: readonly SchemaPlanPiece[]): SchemaPlan {
  return parseSchemaPlan(
    {
      version: SCHEMA_PLAN_CONTRACT_VERSION,
      schemaFingerprint: schemaFingerprint(document),
      fieldPaths: pieces.flatMap((piece) => piece.paths),
      pieces: [...pieces],
      provenance: {
        model: "stub-model",
        backend: "stub-backend",
        createdAt: "2026-10-01T02:03:04.000Z",
      },
    },
    convertDocument(document),
  );
}

const nestedPlan = makePlan(nestedDocument, nestedPieces);
const packingPlan = makePlan(packingDocument, packingPieces);
const byteCap = 1_600;

function targetFor(schema: z.ZodObject): DryRunTarget {
  return {
    name: "ribo-inspect",
    extractionSchema: enveloped(schema),
    instructions: "",
    examples: [],
  };
}

function neverCalledChat(): { chat: ChatClient; calls: () => number } {
  let calls = 0;
  return {
    chat: {
      complete: () => {
        calls += 1;
        throw new Error("planned inspection must not call chat");
      },
    },
    calls: () => calls,
  };
}

type DryRunTarget = ExtractionTarget<Record<string, unknown>> & {
  readonly extractionSchema: z.ZodObject;
};

function directTargets(
  schema: z.ZodObject,
  plan: SchemaPlan,
  caps: SplitCapOptions,
): { targets: readonly DryRunTarget[]; calls: () => number } {
  const stub = neverCalledChat();
  const compiled = plannedPerGroupPlan({
    target: targetFor(schema),
    plan,
    chat: stub.chat,
    model: "ribo-inspect",
    ...caps,
  });
  const byKey = new Map<string, DryRunTarget[]>();
  for (const [key, value] of Object.entries(compiled.targets as Record<string, unknown>)) {
    const values = (Array.isArray(value) ? value : [value]) as DryRunTarget[];
    byKey.set(key, values);
  }
  const targets = plan.pieces.flatMap((piece, pieceIndex) => {
    const prefix = `ribo-inspect-${pieceIndex}-`;
    return (byKey.get(piece.key) ?? []).filter((target) => target.name.startsWith(prefix));
  });
  return { targets, calls: stub.calls };
}

function expectedRows(targets: readonly DryRunTarget[]) {
  return targets.map((target) => {
    const measures = describeExtraction({ extractionSchema: target.extractionSchema }).whole;
    expect(measures).toBeDefined();
    return {
      requestName: target.name,
      paths: walkFieldInventory(target.extractionSchema).map((field) => field.path),
      ...measures!,
    };
  });
}

test("planned rows match core dry-run requests under union, byte and combined caps without chat", () => {
  const capSets: readonly SplitCapOptions[] = [
    { maxNullableUnionsPerGroup: 4 },
    { maxSerializedCharsPerGroup: byteCap },
    { maxNullableUnionsPerGroup: 4, maxSerializedCharsPerGroup: byteCap },
  ];
  let observedPacking = false;

  for (const caps of capSets) {
    const schema = convertDocument(nestedDocument);
    const result = inspectPlanned({ document: nestedDocument, schema, plan: nestedPlan, caps });
    const direct = directTargets(schema, nestedPlan, caps);
    const semantic = directTargets(schema, nestedPlan, {
      maxNullableUnionsPerGroup: Number.POSITIVE_INFINITY,
    });

    expect(direct.calls()).toBe(0);
    expect(semantic.calls()).toBe(0);
    expect(
      result.packedCalls.map((row) => ({
        requestName: row.requestName,
        paths: row.paths,
        nullableUnions: row.nullableUnions,
        serializedChars: row.serializedChars,
        depth: row.depth,
      })),
    ).toEqual(expectedRows(direct.targets));
    expect(
      result.semanticPieces.map((row) => ({
        name: row.name,
        key: row.key,
        paths: row.paths,
        nullableUnions: row.nullableUnions,
        serializedChars: row.serializedChars,
        depth: row.depth,
      })),
    ).toEqual(
      semantic.targets.map((target, index) => ({
        name: nestedPieces[index]!.name,
        key: nestedPieces[index]!.key,
        paths: nestedPieces[index]!.paths,
        ...describeExtraction({ extractionSchema: target.extractionSchema }).whole!,
      })),
    );
    expect(result.totals).toEqual({
      semanticPieces: result.semanticPieces.length,
      packedCalls: direct.targets.length,
    });
    expect(result.semanticPieces.map((row) => row.packedCount)).toEqual(
      nestedPieces.map(
        (piece) => result.packedCalls.filter((row) => row.semantic === piece.name).length,
      ),
    );
    expect(result.notes).toEqual([]);
    observedPacking ||= result.totals.packedCalls > result.totals.semanticPieces;
  }

  expect(observedPacking).toBe(true);
});

test("an oversized semantic piece exposes nested membership as its actual packed calls", () => {
  const result = inspectPlanned({
    document: packingDocument,
    schema: convertDocument(packingDocument),
    plan: packingPlan,
    caps: { maxSerializedCharsPerGroup: byteCap },
  });
  const semantic = result.semanticPieces[0]!;

  expect(result.semanticPieces).toHaveLength(1);
  expect(semantic.packedCount).toBeGreaterThan(1);
  expect(result.packedCalls).toHaveLength(semantic.packedCount);
  expect(result.packedCalls.map((row) => row.semantic)).toEqual(
    Array.from({ length: semantic.packedCount }, () => semantic.name),
  );
  expect(result.packedCalls.map((row) => row.callIndex)).toEqual(
    Array.from({ length: semantic.packedCount }, (_, index) => index + 1),
  );
  expect(result.packedCalls.map((row) => row.callCount)).toEqual(
    Array.from({ length: semantic.packedCount }, () => semantic.packedCount),
  );
  expect(result.packedCalls.flatMap((row) => row.paths).sort()).toEqual([...semantic.paths].sort());
  expect(result.packedCalls.flatMap((row) => row.paths)).toEqual(
    expect.arrayContaining(["home.identity.address", "home.condition.roof"]),
  );
  expect(new Set(result.packedCalls.map((row) => row.requestName)).size).toBe(semantic.packedCount);
  for (const row of result.packedCalls) {
    expect(row.key).toBe("home");
    expect(row.serializedChars).toBeLessThanOrEqual(byteCap);
    expect(row.serializedChars).toBeLessThan(semantic.serializedChars);
  }
  expect(result.worstPackedCall).toBe(
    result.packedCalls.reduce((worst, row) =>
      row.serializedChars > worst.serializedChars ? row : worst,
    ),
  );
});

test("piece-character selection uses planned packed calls with a plan and rule-based pieces without one", () => {
  const planned = inspectPlanned({
    document: packingDocument,
    schema: convertDocument(packingDocument),
    plan: packingPlan,
    caps: { maxSerializedCharsPerGroup: byteCap },
  });
  const ruleBased = inspectSchema(packingDocument).worstPiece;
  const semantic = planned.semanticPieces[0]!;

  expect(ruleBased).not.toBeNull();
  expect(planned.worstPackedCall.serializedChars).toBeLessThan(semantic.serializedChars);
  expect(planned.worstPackedCall.serializedChars).toBeLessThan(ruleBased!.serializedChars);
  const withPlan = selectPieceCharsThreshold({
    limit: planned.worstPackedCall.serializedChars,
    ruleBased,
    planned: planned.worstPackedCall,
  });
  const withoutPlan = selectPieceCharsThreshold({
    limit: planned.worstPackedCall.serializedChars,
    ruleBased,
  });
  expect(withPlan).toEqual({
    measure: "pieceChars",
    layout: "planned",
    limit: planned.worstPackedCall.serializedChars,
    measured: planned.worstPackedCall.serializedChars,
    breached: false,
    piece: `${planned.worstPackedCall.semantic} — call ${planned.worstPackedCall.callIndex} of ${planned.worstPackedCall.callCount}`,
  });
  expect(withoutPlan.measured).toBe(ruleBased!.serializedChars);
  expect(withoutPlan.layout).toBe("rule-based");
  expect(withoutPlan.breached).toBe(true);
});

test("stale plans refuse before measurement and fingerprint-only drift returns a note", () => {
  const staleDocument = structuredClone(nestedDocument);
  delete (staleDocument.properties.audit.properties as Record<string, unknown>).notes;
  staleDocument.properties.audit.required = ["auditor"];

  let staleResult: unknown;
  try {
    staleResult = inspectPlanned({
      document: staleDocument,
      schema: convertDocument(staleDocument),
      plan: nestedPlan,
      caps: { maxSerializedCharsPerGroup: 1 },
    });
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaInspectError);
    expect((error as Error).message).toContain("audit.notes");
    expect((error as Error).message).toContain("ribo schema plan --update");
    expect((error as Error).message).not.toContain("maxSerializedCharsPerGroup");
  }
  expect(staleResult).toBeUndefined();

  const driftPlan = { ...nestedPlan, schemaFingerprint: "0".repeat(64) };
  const drift = inspectPlanned({
    document: nestedDocument,
    schema: convertDocument(nestedDocument),
    plan: driftPlan,
    caps: {},
  });
  expect(drift.notes).toEqual(schemaPlanFreshness(nestedDocument, driftPlan).notes);
  expect(drift.notes).toHaveLength(1);
  expect(drift.packedCalls.length).toBeGreaterThan(0);
});

test("an over-cap projected property refuses construction with or without a piece threshold", () => {
  const document = {
    type: "object",
    properties: {
      home: {
        type: "object",
        properties: {
          details: {
            type: "object",
            properties: {
              oversized: {
                type: "string",
                nullable: true,
                enum: ["alpha-aaaaaaaaaaaaaaaaaaaaaaaa", "bravo-bbbbbbbbbbbbbbbbbbbbbbbb"],
              },
            },
            required: ["oversized"],
          },
        },
        required: ["details"],
      },
    },
    required: ["home"],
  };
  const plan = makePlan(document, [
    {
      name: "Oversized detail",
      description: "One projected property cannot fit the requested cap.",
      key: "home",
      paths: ["home.details.oversized"],
    },
  ]);

  for (const requestedThreshold of [undefined, 1]) {
    let outcome: Record<string, unknown>;
    try {
      const measurement = inspectPlanned({
        document,
        schema: convertDocument(document),
        plan,
        caps: { maxSerializedCharsPerGroup: 100 },
      });
      outcome = {
        measurement,
        ...(requestedThreshold === undefined
          ? {}
          : {
              threshold: selectPieceCharsThreshold({
                limit: requestedThreshold,
                ruleBased: null,
                planned: measurement.worstPackedCall,
              }),
            }),
      };
    } catch (error) {
      outcome = { error };
    }

    expect(outcome["error"]).toBeInstanceOf(SchemaInspectError);
    const message = (outcome["error"] as Error).message;
    expect(message).toContain('group "home"');
    expect(message).toContain('property "details"');
    expect(message).toMatch(/\d+ serialized characters/u);
    expect(message).toContain("maxSerializedCharsPerGroup");
    expect(message).toContain("100");
    expect(outcome).not.toHaveProperty("measurement");
    expect(outcome).not.toHaveProperty("threshold");
  }

  expect(inspectSchema(nestedDocument).contractVersion).toBe(5);
});
