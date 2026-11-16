import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { compareEvalRunRecords } from "./compare.js";
import type { EvalCompareAxis, EvalCompareReport } from "./compare-report.js";
import { EvalCompareReportSchema } from "./compare-report.js";
import type { EvalRunRecordDraft } from "./record-schema.js";
import { EvalRunRecordSchema } from "./record-schema.js";
import { readEvalRunRecords, writeEvalRunRecord } from "./record-store.js";
import {
  FIXTURE_CORPUS,
  copiedCorpus,
  corpusWithoutDocuments,
  editJson,
  removeTemporaries,
} from "./test-support/corpus.js";
import { recordOverCorpus } from "./test-support/record.js";

/**
 * @file The comparison: two run records, one report. Every suite here drives
 * the exported comparison over records the stub chat produced — no model
 * call, no network, no credential — and pins the axes, the refusals and the
 * alignment rule the design doc §7 fixes: a difference in any of the four
 * identity fields is an axis, never refused and never silently equated, and
 * leaves align on the intersection with the exclusions counted.
 */

afterEach(() => {
  removeTemporaries();
});

/** The settings every baseline record runs under. */
const settings = { strategies: ["single-shot"], model: "ribo-test" } as const;

/** A copied fixture corpus without its document case, with one expectation broken. */
const corpusWithDifferentCases = (): string =>
  copiedCorpus(FIXTURE_CORPUS, (dir) => {
    rmSync(path.join(dir, "service-sheet"), { recursive: true, force: true });
    editJson(path.join(dir, "spoken-note", "case.json"), (document) => {
      const expected = document["expected"] as Record<string, unknown>;
      const serial = expected["frame.serial"] as Record<string, unknown>;
      serial["value"] = "BW-9999";
    });
  });

/** A copied fixture corpus with its prompt instructions edited. */
const corpusWithDifferentPrompt = (): string =>
  copiedCorpus(FIXTURE_CORPUS, (dir) => {
    rmSync(path.join(dir, "service-sheet"), { recursive: true, force: true });
    editJson(path.join(dir, "manifest.json"), (document) => {
      const prompt = document["prompt"] as Record<string, unknown>;
      prompt["instructions"] = "Edited instructions for the same questions.";
    });
  });

/** A copied fixture corpus with its `groupInstructions` map edited. */
const corpusWithDifferentGroupInstructions = (): string =>
  copiedCorpus(FIXTURE_CORPUS, (dir) => {
    rmSync(path.join(dir, "service-sheet"), { recursive: true, force: true });
    editJson(path.join(dir, "manifest.json"), (document) => {
      const prompt = document["prompt"] as Record<string, unknown>;
      const group = prompt["groupInstructions"] as Record<string, unknown>;
      group["frame"] = "Frame only, please.";
    });
  });

/** A copied fixture corpus with one leaf dropped from its schema document. */
const corpusWithFewerLeaves = (): string =>
  copiedCorpus(FIXTURE_CORPUS, (dir) => {
    rmSync(path.join(dir, "service-sheet"), { recursive: true, force: true });
    editJson(path.join(dir, "schema.json"), (document) => {
      const service = (document["properties"] as Record<string, unknown>)["service"] as Record<
        string,
        unknown
      >;
      const properties = service["properties"] as Record<string, unknown>;
      delete properties["notes"];
      service["required"] = ["date"];
    });
  });

/** The axes a comparison reports, as bare names for the exact-list assertions. */
const axisNames = (report: EvalCompareReport): readonly EvalCompareAxis[] => report.axes;

test("two records differing only in the prompt inputs report exactly the fingerprint axis", async () => {
  const same = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const edited = await recordOverCorpus(corpusWithDifferentPrompt(), settings);
  const report = compareEvalRunRecords(same.record, edited.record);

  expect(axisNames(report)).toEqual(["fingerprint"]);
  expect(report.corpusOverride).toBe(false);
  expect(report.left.corpus.fingerprint).toBe(report.right.corpus.fingerprint);
});

test("two records differing only in the manifest's groupInstructions also report the fingerprint axis", async () => {
  const same = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const edited = await recordOverCorpus(corpusWithDifferentGroupInstructions(), settings);
  const report = compareEvalRunRecords(same.record, edited.record);

  expect(axisNames(report)).toEqual(["fingerprint"]);
});

test("a strategy-only pair reports exactly the settings axis, with fingerprints identical", async () => {
  const singleShot = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const perGroup = await recordOverCorpus(corpusWithoutDocuments(), {
    ...settings,
    strategies: ["per-group"],
  });

  // The run fingerprint covers the schema and the prompt, never the settings.
  expect(singleShot.record.fingerprint).toBe(perGroup.record.fingerprint);
  const report = compareEvalRunRecords(singleShot.record, perGroup.record);
  expect(axisNames(report)).toEqual(["settings"]);
  expect(report.leafPaths.length).toBeGreaterThan(0);
});

test("a consensus-candidate-count-only pair reports exactly the settings axis", async () => {
  const three = await recordOverCorpus(corpusWithoutDocuments(), {
    ...settings,
    consensusCandidates: 3,
  });
  const five = await recordOverCorpus(corpusWithoutDocuments(), {
    ...settings,
    consensusCandidates: 5,
  });

  expect(three.record.fingerprint).toBe(five.record.fingerprint);
  const report = compareEvalRunRecords(three.record, five.record);
  expect(axisNames(report)).toEqual(["settings"]);
});

test("a settings difference is read through the one canonicaliser: key order never moves it", async () => {
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const reordered: EvalRunRecordDraft = {
    ...run.record,
    settings: {
      maxRetries: 2,
      strategies: run.record.settings.strategies,
    },
  };
  const plain: EvalRunRecordDraft = {
    ...run.record,
    settings: {
      strategies: run.record.settings.strategies,
      maxRetries: 2,
    },
  };

  const report = compareEvalRunRecords(plain, reordered);
  expect(axisNames(report)).toEqual([]);
});

test("a model-only difference reports exactly the model axis", async () => {
  const base = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const other = await recordOverCorpus(corpusWithoutDocuments(), {
    ...settings,
    model: "another-model",
  });

  const report = compareEvalRunRecords(base.record, other.record);
  expect(axisNames(report)).toEqual(["model"]);
});

test("a backend-only difference reports exactly the backend axis", async () => {
  const base = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const other = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    backend: "claude-cli",
  });

  const report = compareEvalRunRecords(base.record, other.record);
  expect(axisNames(report)).toEqual(["backend"]);
  expect(report.left.identity.backend).not.toBe(report.right.identity.backend);
});

test("identical four-field identities report no axis; a self-comparison reports nothing at all", async () => {
  const base = await recordOverCorpus(corpusWithoutDocuments(), settings);
  // A rerun of the same measurement: same identity, a later capture time,
  // and drift the stub's overrides produce.
  const rerun = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-14T11:00:00.000Z",
    stub: { values: { "frame.material": "steel" } },
  });

  const rerunReport = compareEvalRunRecords(base.record, rerun.record);
  expect(axisNames(rerunReport)).toEqual([]);
  expect(rerunReport.differences.length).toBeGreaterThan(0);

  const self = compareEvalRunRecords(base.record, base.record);
  expect(axisNames(self)).toEqual([]);
  expect(self.differences).toEqual([]);
});

test("records from different corpora are refused without the override, and the refusal names it", async () => {
  const same = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const other = await recordOverCorpus(corpusWithDifferentCases(), settings);

  expect(same.record.corpus.fingerprint).not.toBe(other.record.corpus.fingerprint);
  expect(() => compareEvalRunRecords(same.record, other.record)).toThrow(/--allow-corpus-mismatch/);
  expect(() => compareEvalRunRecords(same.record, other.record)).toThrow(
    /different corpora|corpus fingerprints differ/u,
  );
});

test("under the override, different corpora compare, and the report records the override", async () => {
  const same = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const other = await recordOverCorpus(corpusWithDifferentCases(), settings);

  const report = compareEvalRunRecords(same.record, other.record, { allowCorpusMismatch: true });
  expect(report.corpusOverride).toBe(true);
  expect(report.left.corpus.fingerprint).not.toBe(report.right.corpus.fingerprint);
  expect(EvalCompareReportSchema.safeParse(report).success).toBe(true);
});

test("the override is recorded as passed even when the fingerprints match", async () => {
  const same = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const twin = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-14T11:00:00.000Z",
  });

  const report = compareEvalRunRecords(same.record, twin.record, { allowCorpusMismatch: true });
  expect(report.corpusOverride).toBe(true);
});

test("under the override, records whose case ids are disjoint are refused", async () => {
  const base = await recordOverCorpus(corpusWithoutDocuments(), settings);
  // The second record is a real run over a second copy of the corpus whose
  // case ids were relabelled in its grid — a corpus by another name.
  const other = await recordOverCorpus(corpusWithDifferentCases(), settings);
  const relabelled: EvalRunRecordDraft = {
    ...other.record,
    grid: Object.fromEntries(
      Object.entries(other.record.grid).map(([leaf, row]) => [
        leaf,
        Object.fromEntries(
          Object.entries(row).map(([caseId, cell]) => [`${caseId}-elsewhere`, cell]),
        ),
      ]),
    ),
  };

  expect(() =>
    compareEvalRunRecords(base.record, relabelled, { allowCorpusMismatch: true }),
  ).toThrow(/share no case/);
});

test("partially overlapping leaf sets align on the intersection, with the exclusions counted", async () => {
  const base = await recordOverCorpus(corpusWithoutDocuments(), settings);
  // The second record comes from a schema version with one leaf fewer —
  // the same cases, a different schema, which the corpus fingerprint
  // deliberately does not cover.
  const narrower = await recordOverCorpus(corpusWithFewerLeaves(), settings);

  const report = compareEvalRunRecords(base.record, narrower.record);
  expect(report.leafPaths).toEqual(
    base.record.leafPaths.filter((leaf) => leaf !== "service.notes"),
  );
  expect(report.left.excludedLeaves).toBe(1);
  expect(report.right.excludedLeaves).toBe(0);
  expect(report.left.excludedCases).toBe(0);
  expect(report.right.excludedCases).toBe(0);
  for (const difference of report.differences) {
    expect(report.leafPaths).toContain(difference.leafPath);
  }
});

test("disjoint leaf sets are refused", async () => {
  const base = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const disjoint: EvalRunRecordDraft = {
    ...base.record,
    leafPaths: [],
    grid: {},
  };

  expect(() => compareEvalRunRecords(base.record, disjoint)).toThrow(/share no leaf/);
});

test("a difference entry appears exactly when the verdicts differ, ordered by leaf then case", async () => {
  const base = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const drifted = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-14T11:00:00.000Z",
    stub: { values: { "frame.material": "steel", "frame.serial": "BW-4471" } },
  });

  const report = compareEvalRunRecords(base.record, drifted.record);
  const expectedOrder: readonly (readonly string[])[] = [
    ["frame.material", "spoken-note"],
    ["frame.serial", "spoken-note"],
  ];
  expect(report.differences.map((entry) => [entry.leafPath, entry.caseId])).toEqual(expectedOrder);
  for (const entry of report.differences) {
    expect(entry.left.verdict).not.toBe(entry.right.verdict);
    expect(entry.left.expected).toEqual(entry.right.expected);
    expect(entry.left.got).not.toEqual(entry.right.got);
  }
});

test("the comparison performs no filesystem access beyond the records it is handed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ribo-eval-compare-"));
  try {
    const run = await recordOverCorpus(corpusWithoutDocuments(), settings);
    writeEvalRunRecord(run.record, dir);
    const records = readEvalRunRecords(dir);
    expect(records).toHaveLength(1);
    const record = records[0]!;

    // The corpus and the records directory are both gone before the
    // comparison runs: it sees the two parsed drafts and nothing else.
    rmSync(dir, { recursive: true, force: true });
    removeTemporaries();
    const twin = { ...record, capturedAt: "2026-11-14T12:00:00.000Z" };
    const report = compareEvalRunRecords(record, twin);
    expect(axisNames(report)).toEqual([]);
    expect(report.differences).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- The committed fixture records (criterion 23) ---------------------------------

const FIXTURE_A = new URL("../fixtures/records/compare-a.json", import.meta.url);
const FIXTURE_B = new URL("../fixtures/records/compare-b.json", import.meta.url);

test("the committed compare fixtures parse as run records and tell the settings-axis story", () => {
  const a = EvalRunRecordSchema.parse(JSON.parse(readFileSync(FIXTURE_A, "utf8")));
  const b = EvalRunRecordSchema.parse(JSON.parse(readFileSync(FIXTURE_B, "utf8")));

  expect(a.corpus.fingerprint).toBe(b.corpus.fingerprint);
  expect(a.fingerprint).toBe(b.fingerprint);
  expect(a.settings.strategies).not.toEqual(b.settings.strategies);
  const { strategies: _a, ...aRest } = a.settings;
  const { strategies: _b, ...bRest } = b.settings;
  expect(aRest).toEqual(bRest);

  const report = compareEvalRunRecords(a, b);
  expect(axisNames(report)).toEqual(["settings"]);
  expect(report.differences.length).toBeGreaterThan(0);
  expect(EvalCompareReportSchema.safeParse(report).success).toBe(true);
});
