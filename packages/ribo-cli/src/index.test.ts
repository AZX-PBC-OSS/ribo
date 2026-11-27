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
  ExpectationProposalSchema,
  ExpectationReviewSchema,
  ExpectationValueSchema,
  ProposalEvidenceSchema,
  SchemaInspectReportSchema,
  SchemaInspectError,
  ScopedDefaultSchema,
  inspectSchema,
  initSchema,
  loadCorpus,
  planSchema,
  resolveExpectation,
  schemaPlanFreshness,
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
  expect(report.contractVersion).toBe(5);
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

test("the proposal-format schemas are exported from the public runtime barrel", () => {
  // The proposal and review schemas are exported so a proposer and a review
  // sheet validate what they write against the same shape the loader parses.
  const pending = ExpectationProposalSchema.safeParse({
    status: "asserted",
    value: "gas",
    evidence: { quote: "runs on gas", input: "input.txt" },
    backend: "http",
    model: "proposer-1",
    proposedAt: "2026-01-01T00:00:00Z",
  });
  expect(pending.success).toBe(true);
  expect(ExpectationReviewSchema.safeParse("pending").success).toBe(true);
  expect(ExpectationReviewSchema.safeParse("rejected").success).toBe(false);
  expect(ProposalEvidenceSchema.safeParse({ quote: "q", input: "i" }).success).toBe(true);
});

// The barrel's job is to be a stable, complete list of what consumers may
// depend on. This test pins that list: adding an export means adding it here
// deliberately, and removing one cannot happen by accident during a refactor.
// Runtime values only — type-only exports leave nothing to inspect at runtime.
test("the barrel exports the package's public runtime surface", () => {
  expect(Object.keys(cli).sort()).toEqual([
    "CONTRACT_VERSION",
    "CorpusCaptureBlockSchema",
    "CorpusCaseInputSchema",
    "CorpusCaseSchema",
    "CorpusCombineOptionsSchema",
    "CorpusError",
    "CorpusExampleSchema",
    "CorpusManifestSchema",
    "CorpusPromptInputsSchema",
    "EVAL_COMPARE_AXES",
    "EVAL_COMPARE_CONTRACT_VERSION",
    "EVAL_RUN_RECORDS_DEFAULT_DIR",
    "EVAL_VERDICTS",
    "EvalCompareDifferenceSchema",
    "EvalCompareReportSchema",
    "EvalCompareSideSchema",
    "EvalError",
    "EvalRunRecordSchema",
    "ExpectationEntrySchema",
    "ExpectationProposalSchema",
    "ExpectationReviewSchema",
    "ExpectationValueSchema",
    "ProposalEvidenceMapSchema",
    "ProposalEvidenceSchema",
    "ProposalEvidenceSetSchema",
    "RETIRED_VERDICT_TRANSLATION",
    "SchemaInspectError",
    "SchemaInspectReportSchema",
    "ScopedDefaultSchema",
    "buildEvalRunRecord",
    "cliChat",
    "cliVersion",
    "compareEvalRunRecords",
    "coreVersion",
    "corpusFingerprint",
    "createOpenAiCompatibleChat",
    "initSchema",
    "inspectSchema",
    "isRecordCurrent",
    "loadCorpus",
    "planSchema",
    "readEvalRunRecords",
    "recordIdentity",
    "resolveExpectation",
    "runEval",
    "runEvalWithSettings",
    "runFingerprint",
    "schemaPlanFreshness",
    "scoreEvalRun",
    "transcribeDocumentCases",
    "writeEvalRunRecord",
  ]);
});

test("the public runtime barrel deliberately includes schema initialization and planning", () => {
  expect(cli.initSchema).toBe(initSchema);
  expect(cli.planSchema).toBe(planSchema);
  expect(cli.schemaPlanFreshness).toBe(schemaPlanFreshness);
  expect(typeof initSchema).toBe("function");
  expect(typeof planSchema).toBe("function");
  expect(typeof schemaPlanFreshness).toBe("function");
});

test("the CLI transport's internals stay off the public surface", () => {
  // The transport's public surface is exactly four names: the client and its
  // three types. The JSON extractor is an internal helper of the package, and
  // the preflight is the bin's own up-front check — neither is a consumer's
  // business, and the exact list above already implies both. The named
  // assertions document the invariant.
  expect("extractLastJsonObject" in cli).toBe(false);
  expect("preflightCliBackend" in cli).toBe(false);
  expect(typeof cli.cliChat).toBe("function");
});
