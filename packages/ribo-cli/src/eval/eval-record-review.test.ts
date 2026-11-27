/**
 * @file The record's judged-expectation origins: the per-cell `review`
 * provenance, the record-level `expectations` summary, and the same-model
 * disclosure they feed (R8, ADR 0049).
 *
 * The counts are pinned against exact literals over a fixture holding one
 * entry of each review class plus a default-resolved judged cell — never by
 * comparing two generated records against each other. The runs are driven
 * over the stub chat — no model, no network, no credential.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "vitest";

import { loadCorpus } from "../corpus/loader.js";
import { corpusFingerprint } from "./record-fingerprint.js";
import { EvalRunRecordSchema } from "./record-schema.js";
import type { EvalRunRecord, EvalRunRecordDraft } from "./record-schema.js";
import { readEvalRunRecords, writeEvalRunRecord } from "./record-store.js";
import {
  corpusWithReviewClasses,
  corpusWithoutDocuments,
  editJson,
  removeTemporaries,
} from "./test-support/corpus.js";
import { recordOverCorpus } from "./test-support/record.js";

/** The committed fixed record every proposal-free run must match byte for byte. */
const FIXED_RECORD = fileURLToPath(
  new URL("../fixtures/records/review-free-record.json", import.meta.url),
);

/** The temporary directories this suite created, so each test cleans up after itself. */
const temporaries: string[] = [];

afterEach(() => {
  removeTemporaries();
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temporary directory. */
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "ribo-eval-review-"));
  temporaries.push(dir);
  return dir;
};

/** The settings every suite here runs under — the record's model is part of the same-model rule. */
const settings = { strategies: ["single-shot"], model: "ribo-test" } as const;

/** The backend every suite here runs under — the record's other half of the same-model rule. */
const BACKEND = "openai-compatible" as const;

/** A draft as a complete record, with the empty lineage a first write gives it. */
const complete = (draft: EvalRunRecordDraft): EvalRunRecord => ({ ...draft, history: [] });

/** One cell of a record's grid. */
const cellOf = (record: EvalRunRecordDraft, leafPath: string, caseId: string) => {
  const cell = record.grid[leafPath]?.[caseId];
  if (cell === undefined) throw new Error(`no cell for "${leafPath}" in "${caseId}"`);
  return cell;
};

test("the origin counts pin the fixture's review classes exactly", async () => {
  const run = await recordOverCorpus(corpusWithReviewClasses(), settings, {
    backend: BACKEND,
    capturedAt: "2026-11-13T10:00:00.000Z",
  });
  expect(run.calls).toBeGreaterThan(0);
  const expectations = run.record.expectations;
  if (expectations === undefined) throw new Error("the record carries no expectations summary");

  // Exact values, against literals — the fixture holds one hand-written,
  // one accepted-unchanged, one corrected and one pending entry, and the
  // declared-absent default resolves one more judged cell, which counts as
  // hand-written.
  expect(expectations.reviewClasses).toEqual({
    "hand-written": 2,
    "accepted-unchanged": 1,
    corrected: 1,
  });
  expect(expectations.proposers).toEqual([
    { backend: "openai-compatible", model: "ribo-test", cells: 2 },
  ]);
  expect(expectations.sameModelAcceptedUnchanged).toBe(1);

  // The origin counts always sum to the judged total — computed from the
  // scored cells the record itself persists.
  const judged = Object.values(expectations.reviewClasses).reduce(
    (sum, count) => sum + (count ?? 0),
    0,
  );
  expect(judged).toBe(run.record.totals.judged);
  expect(run.record.totals.judged).toBeGreaterThan(0);

  // The cells behind the counts: an explicit entry's cell carries its review
  // class, a proposal-bearing one carries the proposer too, a
  // default-resolved judged cell carries none.
  expect(cellOf(run.record, "frame.material", "spoken-note").review).toEqual({
    class: "hand-written",
  });
  expect(cellOf(run.record, "frame.serial", "spoken-note").review).toEqual({
    class: "accepted-unchanged",
    proposerBackend: "openai-compatible",
    proposerModel: "ribo-test",
  });
  expect(cellOf(run.record, "service.date", "spoken-note").review).toEqual({
    class: "corrected",
    proposerBackend: "openai-compatible",
    proposerModel: "ribo-test",
  });
  expect(cellOf(run.record, "service.warranty", "spoken-note").review).toBeUndefined();
  expect(cellOf(run.record, "service.warranty", "spoken-note").origin).toBe("default");

  // The pending cell stays unscorable with its reason, still carrying the
  // proposed value and the proposer.
  const pending = cellOf(run.record, "service.notes", "spoken-note");
  expect(pending.verdict).toBe("unscorable");
  expect(pending.reason).toBe("unreviewed-proposal");
  expect(pending.expected).toBe("brake pad replacement");
  expect(pending.review).toEqual({
    class: "pending",
    proposerBackend: "openai-compatible",
    proposerModel: "ribo-test",
  });
});

test("the same-model count is non-zero only when the proposer matches backend AND model", async () => {
  const wrongModel = await recordOverCorpus(
    corpusWithReviewClasses({ backend: "openai-compatible", model: "stub-model" }),
    settings,
    { backend: BACKEND, capturedAt: "2026-11-13T10:00:00.000Z" },
  );
  const wrongBackend = await recordOverCorpus(
    corpusWithReviewClasses({ backend: "stub-backend", model: "ribo-test" }),
    settings,
    { backend: BACKEND, capturedAt: "2026-11-13T10:00:00.000Z" },
  );

  expect(wrongModel.record.expectations?.sameModelAcceptedUnchanged).toBe(0);
  expect(wrongBackend.record.expectations?.sameModelAcceptedUnchanged).toBe(0);
});

test("a proposal-free corpus's record carries neither optional addition", async () => {
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    backend: BACKEND,
    capturedAt: "2026-11-13T10:00:00.000Z",
  });

  expect(run.record.totals.judged).toBeGreaterThan(0);
  expect(run.record.expectations).toBeUndefined();
  for (const scored of Object.values(run.record.grid)) {
    for (const cell of Object.values(scored)) {
      expect(cell.review).toBeUndefined();
    }
  }
});

test("a record with the additions round-trips through the store", async () => {
  const run = await recordOverCorpus(corpusWithReviewClasses(), settings, {
    backend: BACKEND,
    capturedAt: "2026-11-13T10:00:00.000Z",
  });
  const dir = tempDir();

  writeEvalRunRecord(run.record, dir);
  const [read] = readEvalRunRecords(dir);

  expect(read).toEqual(complete(run.record));
  expect(EvalRunRecordSchema.parse(read)).toEqual(read);
});

test("a proposal-free record is byte-identical to the committed fixed record", async () => {
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    backend: BACKEND,
    capturedAt: "2026-11-13T10:00:00.000Z",
  });
  const dir = tempDir();

  const file = writeEvalRunRecord(run.record, dir);

  expect(readFileSync(file, "utf8")).toBe(readFileSync(FIXED_RECORD, "utf8"));
});

test("the corpus fingerprint covers review state and proposer whole", () => {
  const dir = corpusWithReviewClasses();
  const before = corpusFingerprint(loadCorpus(dir));

  editJson(path.join(dir, "spoken-note", "case.json"), (document) => {
    const expected = document["expected"] as Record<string, Record<string, unknown>>;
    const entry = expected["service.notes"]!;
    entry["review"] = "confirmed";
  });
  const reviewed = corpusFingerprint(loadCorpus(dir));
  expect(reviewed).not.toBe(before);

  editJson(path.join(dir, "spoken-note", "case.json"), (document) => {
    const expected = document["expected"] as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const proposal = expected["service.notes"]!["proposal"]!;
    proposal["model"] = "another-model";
  });
  const reproposed = corpusFingerprint(loadCorpus(dir));
  expect(reproposed).not.toBe(reviewed);
  expect(reproposed).not.toBe(before);
});
