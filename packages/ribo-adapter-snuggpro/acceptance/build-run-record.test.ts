import { describe, expect, test } from "vitest";

import type { BuildRunRecordInput, ScoreReportLike } from "./build-run-record.js";
import { buildRunRecord, toHistoryEntry } from "./build-run-record.js";
import { RunRecordSchema } from "./run-record.js";

const LEAVES = ["attic.rValue", "hvac.heatingFuel", "health.coTest"];
const SLUGS = ["01-one", "02-two"];

function emptyReport(slug: string): ScoreReportLike {
  return {
    slug,
    status: "scored",
    problem: null,
    hallucinations: [],
    softAlternatives: [],
    sanctionedRows: [],
    misses: [],
    excused: [],
    wrong: [],
    unscorableRows: [],
    badSpans: [],
    health: [],
  };
}

function input(overrides: Partial<BuildRunRecordInput> = {}): BuildRunRecordInput {
  return {
    capturedAt: "2026-08-11T12:00:00.000Z",
    schemaFingerprint: `sha256:${"a".repeat(64)}`,
    backend: "codex-cli",
    backendLabel: "codex-cli",
    model: "codex-cli",
    passed: true,
    hallRate: 0,
    missRate: 0,
    totals: { gtNull: 4 },
    hazards: {
      fuelDropped: 0,
      fuelInvented: 0,
      hallucinatedPass: 0,
      rvalueConversion: 0,
      enumWrongMember: 0,
      enumInvalid: 0,
      spanFabricated: 0,
      spanMissing: 0,
    },
    shapeConformance: { applicable: true, firstTry: 2, retried: 0, never: 0 },
    leafPaths: LEAVES,
    reports: SLUGS.map(emptyReport),
    assertedLeaves: { "01-one": ["attic.rValue"], "02-two": [] },
    ...overrides,
  };
}

describe("buildRunRecord — the grid is dense", () => {
  test("emits exactly one cell per leaf path per transcript", () => {
    const run = buildRunRecord(input());
    expect(Object.keys(run.grid)).toHaveLength(LEAVES.length);
    for (const leaf of LEAVES) {
      expect(Object.keys(run.grid[leaf] ?? {})).toEqual(SLUGS);
    }
  });

  test("a leaf mentioned in no problem list is correct when ground truth asserted it", () => {
    const run = buildRunRecord(input());
    expect(run.grid["attic.rValue"]?.["01-one"]?.verdict).toBe("correct");
  });

  test("...and correct-null when ground truth was null — the two are never conflated", () => {
    const run = buildRunRecord(input());
    expect(run.grid["attic.rValue"]?.["02-two"]?.verdict).toBe("correct-null");
    expect(run.grid["hvac.heatingFuel"]?.["01-one"]?.verdict).toBe("correct-null");
  });

  test("the output satisfies RunRecordSchema", () => {
    expect(() => RunRecordSchema.parse(buildRunRecord(input()))).not.toThrow();
  });
});

describe("buildRunRecord — verdict attribution", () => {
  test("a hallucination is attributed to its own cell, with value and span", () => {
    const report = emptyReport("01-one");
    report.hallucinations.push({
      field: "hvac.heatingFuel",
      value: "Natural Gas",
      sourceSpan: "the gas furnace",
      confidence: 0.9,
      rvalueConversion: false,
    });
    const run = buildRunRecord(input({ reports: [report, emptyReport("02-two")] }));
    const cell = run.grid["hvac.heatingFuel"]?.["01-one"];
    expect(cell?.verdict).toBe("hallucination");
    expect(cell?.got).toBe("Natural Gas");
    expect(cell?.sourceSpan).toBe("the gas furnace");
  });

  test("a miss carries what was expected", () => {
    const report = emptyReport("01-one");
    report.misses.push({ field: "attic.rValue", expected: 38, span: "R-38 up there" });
    const run = buildRunRecord(input({ reports: [report, emptyReport("02-two")] }));
    const cell = run.grid["attic.rValue"]?.["01-one"];
    expect(cell?.verdict).toBe("miss");
    expect(cell?.expected).toBe("38");
    expect(cell?.got).toBeNull();
  });

  test("a wrong value carries both sides and the scorer's detail", () => {
    const report = emptyReport("01-one");
    report.wrong.push({
      field: "attic.rValue",
      expected: 38,
      got: 30,
      tag: "numeric",
      detail: "off by 8",
    });
    const run = buildRunRecord(input({ reports: [report, emptyReport("02-two")] }));
    const cell = run.grid["attic.rValue"]?.["01-one"];
    expect(cell?.verdict).toBe("wrong");
    expect(cell?.expected).toBe("38");
    expect(cell?.got).toBe("30");
    expect(cell?.detail).toBe("off by 8");
  });

  test("a health row maps onto its own verdict namespace", () => {
    const report = emptyReport("01-one");
    report.health.push({
      test: "health.coTest",
      gt: null,
      got: "Passed",
      category: "hallucinatedPass",
    });
    const run = buildRunRecord(input({ reports: [report, emptyReport("02-two")] }));
    expect(run.grid["health.coTest"]?.["01-one"]?.verdict).toBe("health-hallucinated-pass");
  });

  test("a span problem is recorded WITHOUT overriding the content verdict", () => {
    const report = emptyReport("01-one");
    report.badSpans.push({
      field: "attic.rValue",
      value: 38,
      span: "invented quote",
      status: "fabricated",
      detail: "not present in transcript",
    });
    const run = buildRunRecord(input({ reports: [report, emptyReport("02-two")] }));
    const cell = run.grid["attic.rValue"]?.["01-one"];
    expect(cell?.verdict).toBe("correct");
    expect(cell?.spanIssue).toBe("fabricated");
  });

  test("an unscored transcript is marked as such and its problem preserved", () => {
    const report: ScoreReportLike = {
      ...emptyReport("02-two"),
      status: "unscored",
      problem: "cliChat: never conformed after 3 attempts",
    };
    const run = buildRunRecord(input({ reports: [emptyReport("01-one"), report] }));
    const column = run.transcripts.find((t) => t.slug === "02-two");
    expect(column?.status).toBe("unscored");
    expect(column?.problem).toBe("cliChat: never conformed after 3 attempts");
  });
});

describe("toHistoryEntry", () => {
  test("projects the record's summary fields and drops the grid", () => {
    const entry = toHistoryEntry(buildRunRecord(input()));
    expect(entry.backend).toBe("codex-cli");
    expect(entry.hazards.fuelDropped).toBe(0);
    expect(entry).not.toHaveProperty("grid");
    expect(entry).not.toHaveProperty("leafPaths");
  });
});
