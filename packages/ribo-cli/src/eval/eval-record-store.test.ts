/**
 * @file The records store: where a record lands, what the directory reads
 * back, and where a record's lineage comes from.
 *
 * The store owns three rules: a record is written whole or not at all, a
 * record is never overwritten, and the lineage is a fact of the directory
 * rather than a caller's claim. These suites pin all three, together with the
 * loudness a malformed sibling record deserves.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { EvalError } from "./error.js";
import { isRecordCurrent, recordIdentity } from "./record-fingerprint.js";
import type { EvalRunRecordDraft } from "./record-schema.js";
import {
  EVAL_RUN_RECORDS_DEFAULT_DIR,
  readEvalRunRecords,
  writeEvalRunRecord,
} from "./record-store.js";
import { corpusWithoutDocuments, removeTemporaries } from "./test-support/corpus.js";
import { recordOverCorpus } from "./test-support/record.js";
import type { EvalSettings } from "./types.js";

afterEach(() => {
  removeTemporaries();
});

/** The settings every store suite runs under. */
const settings = { strategies: ["single-shot"], model: "ribo-test" } as const;

/** The temporary directories this suite created, so each test cleans up after itself. */
const temporaries: string[] = [];

/**
 * A fresh temporary directory.
 * @returns The directory's path.
 */
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "ribo-eval-store-"));
  temporaries.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the default records directory is the run's own, named once", () => {
  expect(EVAL_RUN_RECORDS_DEFAULT_DIR).toBe("ribo-eval-runs");
});

test("writing creates the directory, writes one file, and leaves no temp file behind", async () => {
  const dir = tempDir();
  const target = path.join(dir, "records");
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-13T10:00:00.000Z",
  });

  const file = writeEvalRunRecord(run.record, target);

  expect(file.startsWith(target)).toBe(true);
  const entries = readdirSync(target);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.endsWith(".json")).toBe(true);
  // No temp file survived the write.
  expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
});

test("reading a directory with no records reads as empty, not as a fault", () => {
  expect(readEvalRunRecords(path.join(tempDir(), "never-written"))).toEqual([]);
});

test("a non-record entry in the directory is ignored", async () => {
  const dir = tempDir();
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-13T10:00:00.000Z",
  });
  writeEvalRunRecord(run.record, dir);
  writeFileSync(path.join(dir, "notes.txt"), "a human's note\n");
  writeFileSync(path.join(dir, "half-written.json.tmp"), "{");

  const records = readEvalRunRecords(dir);
  expect(records).toHaveLength(1);
});

test("reading a records directory skips files that are not run records — one stderr line each", async () => {
  const dir = tempDir();
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-13T10:00:00.000Z",
  });
  writeEvalRunRecord(run.record, dir);
  // The strays a real directory accumulates: a truncated capture (a report's
  // stdout redirected into --out), a JSON value that is not an object, and a
  // JSON object that is no record (a redirected report carries no
  // contractVersion).
  const truncated = path.join(dir, "out2.json");
  writeFileSync(truncated, '{"name": "workshop-bicycles", "arms":');
  const notAnObject = path.join(dir, "notes.json");
  writeFileSync(notAnObject, JSON.stringify(["just", "a", "list"]));
  const reportShaped = path.join(dir, "report.json");
  writeFileSync(reportShaped, JSON.stringify({ name: "workshop-bicycles", arms: [] }));

  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    writes.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  });
  let records: ReturnType<typeof readEvalRunRecords>;
  try {
    records = readEvalRunRecords(dir);
  } finally {
    spy.mockRestore();
  }

  // Must-fail: before the skip, any one of these files threw the
  // could-not-run class and refused the read outright.
  expect(records).toHaveLength(1);
  const lines = writes
    .join("")
    .split("\n")
    .filter((line) => line.includes("skipping"));
  for (const file of [truncated, notAnObject, reportShaped]) {
    expect(
      lines.filter((line) => line.includes(file)),
      file,
    ).toHaveLength(1);
  }
});

test("a record-shaped file that fails the schema — a newer contract version — still fails the read and the write, naming the file", async () => {
  const dir = tempDir();
  const newer = path.join(dir, "newer.json");
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-13T10:00:00.000Z",
  });
  // A record of a newer contract version IS a record: handled exactly as
  // before the skip — a refusal, never a silent drop out of a lineage.
  writeFileSync(newer, JSON.stringify({ ...run.record, history: [], contractVersion: 999 }));

  expect(() => readEvalRunRecords(dir)).toThrow(EvalError);
  expect(() => readEvalRunRecords(dir)).toThrow(newer);
  expect(() => writeEvalRunRecord(run.record, dir)).toThrow(EvalError);
  expect(() => writeEvalRunRecord(run.record, dir)).toThrow(newer);
});

test("an old-format record (capturedAt, no contractVersion) still fails the read, naming the file", () => {
  const dir = tempDir();
  const old = path.join(dir, "current-codex-cli.json");
  // The retired format carries capturedAt but no contractVersion: it is a
  // record, so it refuses rather than being skipped as a stray.
  writeFileSync(old, JSON.stringify({ capturedAt: "2026-01-01T00:00:00.000Z", passed: true }));
  expect(() => readEvalRunRecords(dir)).toThrow(EvalError);
  expect(() => readEvalRunRecords(dir)).toThrow(old);
});

test("a record's lineage is the earlier records of the same identity in the directory", async () => {
  const dir = tempDir();
  const first = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-13T10:00:00.000Z",
  });
  const second = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-13T11:00:00.000Z",
  });
  const third = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-13T12:00:00.000Z",
  });

  writeEvalRunRecord(first.record, dir);
  writeEvalRunRecord(second.record, dir);
  writeEvalRunRecord(third.record, dir);

  const records = readEvalRunRecords(dir);
  expect(records).toHaveLength(3);
  const [, secondRecord, thirdRecord] = records;
  expect(secondRecord?.history).toHaveLength(1);
  expect(secondRecord?.history[0]?.identity).toBe(recordIdentity(first.record));
  expect(secondRecord?.history[0]?.capturedAt).toBe("2026-11-13T10:00:00.000Z");
  expect(secondRecord?.history[0]?.totals).toEqual(first.record.totals);

  expect(thirdRecord?.history).toHaveLength(2);
  expect(thirdRecord?.history.map((entry) => entry.capturedAt)).toEqual([
    "2026-11-13T10:00:00.000Z",
    "2026-11-13T11:00:00.000Z",
  ]);
});

test("a record of another identity starts with an empty lineage", async () => {
  const dir = tempDir();
  const first = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-13T10:00:00.000Z",
  });
  const other = await recordOverCorpus(corpusWithoutDocuments(), {
    strategies: ["single-shot"],
    model: "another-model",
  });
  writeEvalRunRecord(first.record, dir);
  writeEvalRunRecord(other.record, dir);

  const records = readEvalRunRecords(dir);
  expect(records).toHaveLength(2);
  const otherRecord = records.find((entry) => entry.model === "another-model");
  expect(otherRecord?.history).toEqual([]);
});

test("a caller cannot claim a lineage: the draft carries none, and the store's wins", async () => {
  const dir = tempDir();
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-13T10:00:00.000Z",
  });
  // Compile-time: the writer's input has no lineage field at all.
  type DraftHasNoHistory = "history" extends keyof EvalRunRecordDraft ? never : true;
  const _draftHasNoHistory: DraftHasNoHistory = true;
  expect(_draftHasNoHistory).toBe(true);

  const forged = {
    ...run.record,
    history: [
      {
        identity: "0".repeat(64),
        capturedAt: "2020-01-01T00:00:00.000Z",
        totals: run.record.totals,
      },
    ],
  } as EvalRunRecordDraft;
  writeEvalRunRecord(forged, dir);

  const records = readEvalRunRecords(dir);
  expect(records[0]?.history).toEqual([]);
});

test("a run over several arms writes one record per arm, each current against its own settings", async () => {
  const dir = tempDir();
  const corpusDir = corpusWithoutDocuments();
  const arms: readonly EvalSettings[] = [
    { strategies: ["single-shot"], model: "ribo-test" },
    { strategies: ["per-group"], model: "ribo-test" },
  ];

  const records = [];
  for (const arm of arms) {
    const run = await recordOverCorpus(corpusDir, arm, {
      capturedAt: "2026-11-13T10:00:00.000Z",
    });
    expect(run.calls).toBeGreaterThan(0);
    writeEvalRunRecord(run.record, dir);
    records.push(run.record);
  }

  const written = readEvalRunRecords(dir);
  expect(written).toHaveLength(2);
  // The arms differ in their settings, not in what they were asked.
  expect(written[0]?.fingerprint).toBe(written[1]?.fingerprint);
  expect(recordIdentity(written[0]!)).not.toBe(recordIdentity(written[1]!));

  for (const record of written) {
    expect(
      isRecordCurrent(record, {
        backend: record.backend,
        model: record.model,
        settings: record.settings,
        fingerprint: record.fingerprint,
      }),
    ).toBe(true);
  }
});
