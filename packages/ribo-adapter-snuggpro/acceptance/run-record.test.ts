import { describe, expect, test } from "vitest";

import type { RunRecord } from "./run-record.js";
import { HistoryEntrySchema, RunRecordSchema } from "./run-record.js";

/** The smallest record that must round-trip: one leaf, one transcript, one cell. */
function minimalRun(): RunRecord {
  return {
    capturedAt: "2026-08-11T12:00:00.000Z",
    schemaFingerprint: `sha256:${"a".repeat(64)}`,
    backend: "codex-cli",
    backendLabel: "codex-cli",
    model: "codex-cli",
    passed: true,
    hallRate: 0.0075,
    missRate: 0.0151,
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
    shapeConformance: { applicable: true, firstTry: 12, retried: 1, never: 1 },
    totals: { gtNull: 398, gtNonNull: 134 },
    leafPaths: ["attic.rValue"],
    transcripts: [{ slug: "01-attic-r-value-shell", status: "scored", problem: null }],
    grid: {
      "attic.rValue": {
        "01-attic-r-value-shell": {
          verdict: "correct",
          expected: "38",
          got: "38",
          sourceSpan: "R-38 in the attic",
          spanIssue: null,
          detail: null,
        },
      },
    },
  };
}

describe("RunRecordSchema", () => {
  test("accepts a well-formed record and round-trips through JSON", () => {
    const parsed = RunRecordSchema.parse(JSON.parse(JSON.stringify(minimalRun())));
    expect(parsed.grid["attic.rValue"]?.["01-attic-r-value-shell"]?.verdict).toBe("correct");
  });

  test("rejects an unknown cell verdict rather than letting it render", () => {
    const bad = {
      ...minimalRun(),
      grid: {
        "attic.rValue": {
          "01-attic-r-value-shell": {
            verdict: "probably-fine",
            expected: null,
            got: null,
            sourceSpan: null,
            spanIssue: null,
            detail: null,
          },
        },
      },
    };
    expect(() => RunRecordSchema.parse(bad)).toThrow();
  });

  test("rejects a fingerprint that is not a sha256 hex digest", () => {
    expect(() =>
      RunRecordSchema.parse({ ...minimalRun(), schemaFingerprint: "sha256:xyz" }),
    ).toThrow();
  });

  test("rejects a capturedAt that is not an ISO instant", () => {
    expect(() => RunRecordSchema.parse({ ...minimalRun(), capturedAt: "last tuesday" })).toThrow();
  });
});

describe("HistoryEntrySchema", () => {
  test("a full run record satisfies the history entry shape (history is a strict prefix)", () => {
    expect(() => HistoryEntrySchema.parse(minimalRun())).not.toThrow();
  });

  test("rejects an entry missing its hazard counts", () => {
    expect(() => HistoryEntrySchema.parse({ ...minimalRun(), hazards: undefined })).toThrow();
  });
});
