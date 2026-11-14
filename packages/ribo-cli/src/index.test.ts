import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import * as cli from "./index.js";
import {
  CorpusCaseSchema,
  CorpusCaptureBlockSchema,
  CorpusError,
  CorpusExampleSchema,
  CorpusManifestSchema,
  CorpusPromptInputsSchema,
  ExpectationEntrySchema,
  ExpectationValueSchema,
  SchemaInspectReportSchema,
  SchemaInspectError,
  ScopedDefaultSchema,
  inspectSchema,
  loadCorpus,
  resolveExpectation,
} from "./index.js";

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };
const coreManifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../node_modules/@azx/ribo-core/package.json", import.meta.url)),
    "utf8",
  ),
) as { version: string };

// OpenAPI 3.0 form (ADR 0038): nullability as `nullable: true`, not an anyOf
// with a null arm. One nested group, two described leaves, one nullable leaf.
const document = {
  type: "object",
  properties: {
    home: {
      type: "object",
      description: "Home overview",
      properties: {
        address: { type: "string", description: "Street address" },
        yearBuilt: { type: "number", description: "Year built" },
        completed: { type: "boolean", description: "Audit completed", nullable: true },
      },
      required: ["address", "yearBuilt", "completed"],
    },
    notes: { type: "string", description: "Freeform notes", nullable: true },
  },
  required: ["home", "notes"],
};

test("inspectSchema returns the versioned report for an OpenAPI-3.0-form document", () => {
  const report = inspectSchema(document);
  expect(report.contractVersion).toBe(3);
  expect(report.cliVersion).toBe(manifest.version);
  // The contract names the version of the core that produced the numbers.
  expect(report.coreVersion).toBe(coreManifest.version);
  // Four leaves under the fixture shape: address, yearBuilt, completed, notes.
  expect(report.leafCount).toBe(4);
  expect(report.leafCount).toBeGreaterThanOrEqual(1);
});

test("the serialized report parses against its own exported zod schema", () => {
  const report = inspectSchema(document);
  const round = SchemaInspectReportSchema.parse(JSON.parse(JSON.stringify(report)));
  // Compile-time: the zod schema's inferred shape and the report interface are
  // the same contract — a field added to one and not the other fails here.
  const asReport: typeof round = report;
  const fromRound: typeof report = round;
  expect(asReport).toEqual(fromRound);
  expect(round.leafCount).toBe(4);
});

test("inspectSchema rejects an empty document", () => {
  expect(() => inspectSchema({})).toThrow(SchemaInspectError);
});

test("inspectSchema rejects a non-schema JSON value", () => {
  expect(() => inspectSchema("just a string")).toThrow(SchemaInspectError);
  expect(() => inspectSchema([1, 2, 3])).toThrow(SchemaInspectError);
  expect(() => inspectSchema({ hello: "world" })).toThrow(SchemaInspectError);
});

test("the corpus loader and its schemas are exported from the package's public entry", () => {
  expect(typeof loadCorpus).toBe("function");
  expect(typeof resolveExpectation).toBe("function");
  expect(CorpusError.prototype).toBeInstanceOf(SchemaInspectError);
  // The boundary schemas are exported so a writer (the Snugg migration) can
  // validate what it writes against the same shape the loader parses.
  expect(CorpusManifestSchema.safeParse({}).success).toBe(false);
  expect(CorpusCaseSchema.safeParse({}).success).toBe(false);
  expect(CorpusPromptInputsSchema.safeParse({ instructions: "" }).success).toBe(true);
  expect(CorpusExampleSchema.safeParse({ transcript: "t", fields: {} }).success).toBe(true);
  expect(
    CorpusCaptureBlockSchema.safeParse({ capturedAt: "2026-02-11T08:15:00Z", pageCount: 1 })
      .success,
  ).toBe(true);
  expect(ExpectationEntrySchema.safeParse({ status: "asserted", value: "x" }).success).toBe(true);
  expect(ExpectationValueSchema.safeParse("x").success).toBe(true);
  expect(ScopedDefaultSchema.safeParse({ scope: "a", status: "unmentioned" }).success).toBe(true);
});

// The barrel's job is to be a stable, complete list of what consumers may
// depend on. This test pins that list: adding an export means adding it here
// deliberately, and removing one cannot happen by accident during a refactor.
// Runtime values only — type-only exports leave nothing to inspect at runtime.
test("the barrel exports the package's public runtime surface", () => {
  expect(Object.keys(cli).sort()).toEqual([
    "CONTRACT_VERSION",
    "CorpusCaptureBlockSchema",
    "CorpusCaseSchema",
    "CorpusError",
    "CorpusExampleSchema",
    "CorpusManifestSchema",
    "CorpusPromptInputsSchema",
    "EvalError",
    "ExpectationEntrySchema",
    "ExpectationValueSchema",
    "SchemaInspectError",
    "SchemaInspectReportSchema",
    "ScopedDefaultSchema",
    "cliVersion",
    "coreVersion",
    "createOpenAiCompatibleChat",
    "inspectSchema",
    "loadCorpus",
    "resolveExpectation",
    "runEval",
  ]);
});
