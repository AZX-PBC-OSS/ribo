import { expect, test } from "vitest";
import { z } from "zod";

import type { ChatClient } from "../../phases/chat-client.js";
import { enveloped } from "../../provenance/enveloped.js";
import { SCHEMA_PLAN_CONTRACT_VERSION } from "../schema-plan.js";
import type { SchemaPlan, SchemaPlanPiece } from "../schema-plan.js";
import type { ExtractionTarget } from "../extractor.js";

import { compilePlannedGroups } from "./planned-groups.js";
import type { PlannedGroups } from "./planned-groups.js";
import { serializedCharCount } from "./split-schema.js";

const makePlan = (pieces: readonly SchemaPlanPiece[]): SchemaPlan => ({
  version: SCHEMA_PLAN_CONTRACT_VERSION,
  schemaFingerprint: "a".repeat(64),
  fieldPaths: pieces.flatMap((piece) => piece.paths),
  pieces: [...pieces],
  provenance: {
    model: "stub-model",
    backend: "stub-backend",
    createdAt: "2026-09-21T12:00:00.000Z",
  },
});

const piece = (
  name: string,
  description: string,
  key: string,
  paths: readonly string[],
): SchemaPlanPiece => ({ name, description, key, paths: [...paths] });

const makeTarget = (
  extractionSchema: z.ZodType,
  fields?: Record<string, unknown>,
): ExtractionTarget<Record<string, unknown>> =>
  ({
    name: "audit-demo",
    extractionSchema,
    instructions: "Base extraction rules.",
    examples: fields === undefined ? [] : [{ transcript: "example", fields }],
  }) as unknown as ExtractionTarget<Record<string, unknown>>;

const neverCalledChat = (): { chat: ChatClient; calls: () => number } => {
  let calls = 0;
  return {
    chat: {
      complete: () => {
        calls += 1;
        throw new Error("planned group compilation must not call chat");
      },
    },
    calls: () => calls,
  };
};

const targetsFor = (
  compiled: PlannedGroups<Record<string, unknown>>,
  key: string,
): readonly ExtractionTarget<Record<string, unknown>>[] => {
  const targets = (compiled.targets as Record<string, unknown>)[key];
  return (Array.isArray(targets) ? targets : [targets]) as readonly ExtractionTarget<
    Record<string, unknown>
  >[];
};

const groupShape = (target: ExtractionTarget<Record<string, unknown>>, key: string) => {
  const root = target.extractionSchema as z.ZodObject;
  let value = root.shape[key] as z.ZodType;
  if (value instanceof z.ZodArray) value = value.element as z.ZodType;
  return (value as z.ZodObject).shape as Record<string, z.ZodType>;
};

test("union packing preserves semantic pieces, labels, complete elsewhere and first-call citation ownership", () => {
  const schema = enveloped(
    z.object({
      audit: z.object({
        a: z.string().nullable().optional(),
        b: z.string().nullable().optional(),
        c: z.string().nullable().optional(),
      }),
      details: z.object({ x: z.string().nullable().optional() }),
    }),
    { provenance: { audit: "row", details: "none" } },
  );
  const plan = makePlan([
    piece("first facts", "The first semantic group.", "audit", ["audit.a", "audit.b"]),
    piece("second facts", "The second semantic group.", "audit", ["audit.c"]),
    piece("details", "Details stay in their own key.", "details", ["details.x"]),
  ]);
  const fields = {
    audit: { a: "A", b: "B", c: "C", sourceSpan: "audit citation" },
    details: { x: "X" },
  };
  const stub = neverCalledChat();

  const compiled = compilePlannedGroups({
    target: makeTarget(schema, fields),
    plan,
    chat: stub.chat,
    model: "stub",
    maxNullableUnionsPerGroup: 2,
  });
  const audit = targetsFor(compiled, "audit");
  const details = targetsFor(compiled, "details");

  expect(audit).toHaveLength(3);
  expect(details).toHaveLength(1);
  expect(Object.keys(groupShape(audit[0]!, "audit"))).toEqual(["sourceSpan", "a"]);
  expect(Object.keys(groupShape(audit[1]!, "audit"))).toEqual(["b"]);
  expect(Object.keys(groupShape(audit[2]!, "audit"))).toEqual(["c"]);
  expect(Object.keys(groupShape(details[0]!, "details"))).toEqual(["x"]);

  expect(audit.map((target) => target.instructions)).toEqual([
    expect.stringContaining("This call covers the first facts fields of audit."),
    expect.stringContaining("This call covers the first facts fields of audit."),
    expect.stringContaining("This call covers the second facts fields of audit."),
  ]);
  expect(audit[0]!.instructions).toContain("The first semantic group.");
  expect(audit[2]!.instructions).toContain("The second semantic group.");
  expect(audit[0]!.instructions).toContain("audit.b, audit.c");
  expect(audit[1]!.instructions).toContain("audit.a, audit.c");
  expect(audit[2]!.instructions).toContain("audit.a, audit.b");
  expect(audit[0]!.instructions).not.toContain("details.x");

  expect(audit[0]!.name).toContain("first-facts");
  expect(audit[2]!.name).toContain("second-facts");
  expect(audit[0]!.name).not.toContain("2");
  const firstExample = audit[0]!.examples![0]!.fields as {
    audit: Record<string, unknown>;
  };
  const secondExample = audit[1]!.examples![0]!.fields as {
    audit: Record<string, unknown>;
  };
  const nonOwnerExample = audit[2]!.examples![0]!.fields as {
    audit: Record<string, unknown>;
  };
  expect(firstExample.audit).toEqual({ sourceSpan: "audit citation", a: "A" });
  expect(secondExample.audit).toEqual({ b: "B" });
  expect(nonOwnerExample.audit).toEqual({ c: "C" });
  expect(stub.calls()).toBe(0);
});

const longEnumLeaf = (seed: number): z.ZodEnum =>
  z.enum([
    `option-alpha-${seed}-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
    `option-bravo-${seed}-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
    `option-charlie-${seed}-cccccccccccccccccccccccccccccc`,
  ]);

const enumGroup = (count: number): z.ZodObject => {
  const shape: Record<string, z.ZodType> = {};
  for (let index = 0; index < count; index += 1) shape[`leaf${index}`] = longEnumLeaf(index);
  return z.object(shape);
};

test("byte packing reuses the existing cap arithmetic without putting caps in prompts or artifacts", () => {
  const schema = enveloped(z.object({ alpha: enumGroup(4) }));
  const plan = makePlan([
    piece("enum facts", "Enum values stay semantically together before packing.", "alpha", [
      "alpha.leaf0",
      "alpha.leaf1",
      "alpha.leaf2",
      "alpha.leaf3",
    ]),
  ]);
  const stub = neverCalledChat();
  const byteCap = 900;

  const compiled = compilePlannedGroups({
    target: makeTarget(schema),
    plan,
    chat: stub.chat,
    model: "stub",
    maxSerializedCharsPerGroup: byteCap,
  });
  const targets = targetsFor(compiled, "alpha");

  expect(targets.length).toBeGreaterThan(1);
  for (const target of targets) {
    expect(serializedCharCount(target.extractionSchema)).toBeLessThanOrEqual(byteCap);
    expect(target.instructions).toContain("This call covers the enum facts fields of alpha.");
    expect(target.instructions).toContain("Enum values stay semantically together before packing.");
    expect(target.instructions).not.toContain(String(byteCap));
    expect(target.name).not.toContain(String(byteCap));
  }
  expect(stub.calls()).toBe(0);
});

test("an unfittable projected direct property keeps the existing field-and-cap refusal", () => {
  const schema = enveloped(z.object({ huge: enumGroup(1) }));
  const plan = makePlan([piece("huge", "One unfittable property.", "huge", ["huge.leaf0"])]);
  const stub = neverCalledChat();
  const byteCap = 100;

  const compile = (): unknown =>
    compilePlannedGroups({
      target: makeTarget(schema),
      plan,
      chat: stub.chat,
      model: "stub",
      maxSerializedCharsPerGroup: byteCap,
    });

  expect(compile).toThrow(/splitExtractionSchema: group "huge" has a property "leaf0"/);
  expect(compile).toThrow(/maxSerializedCharsPerGroup/);
  expect(compile).toThrow(new RegExp(String(byteCap)));
  expect(stub.calls()).toBe(0);
});
