/**
 * @file The record's identity and the currency predicate: the four fields
 * that decide whether two records measure the same thing.
 *
 * A fingerprint-only key would let a stale baseline pass as fresh, and a
 * strategy-only key would call two different measurements the same. These
 * suites pin the four-field key: the backend, the model, the settings and
 * the run fingerprint, all of them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";

import { isRecordCurrent, recordIdentity } from "./record-fingerprint.js";
import type { EvalRunRecord, EvalRunRecordDraft, EvalRunRecordIdentity } from "./record-schema.js";
import { readEvalRunRecords, writeEvalRunRecord } from "./record-store.js";
import { corpusWithoutDocuments, removeTemporaries } from "./test-support/corpus.js";
import { recordOverCorpus } from "./test-support/record.js";
import type { EvalSettings } from "./types.js";

afterEach(() => {
  removeTemporaries();
});

/** The settings every identity suite runs under. */
const settings = { strategies: ["single-shot"], model: "ribo-test" } as const;

/** A draft as a complete record, with the empty lineage a first write gives it. */
const asRecord = (draft: EvalRunRecordDraft): EvalRunRecord => ({ ...draft, history: [] });

/** The identity a record carries — the four fields freshness is judged on. */
const identityOf = (record: EvalRunRecord): EvalRunRecordIdentity => ({
  backend: record.backend,
  model: record.model,
  settings: record.settings,
  fingerprint: record.fingerprint,
});

/** The temporary directories this suite created, so each test cleans up after itself. */
const temporaries: string[] = [];

/**
 * A fresh temporary directory.
 * @returns The directory's path.
 */
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "ribo-eval-records-"));
  temporaries.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the identity key is a digest, and equal inputs give equal keys", async () => {
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const record = asRecord(run.record);

  const key = recordIdentity(identityOf(record));
  expect(key).toMatch(/^[0-9a-f]{64}$/u);
  expect(recordIdentity(identityOf(record))).toBe(key);

  // The order of the keys inside the settings is free.
  const reordered: EvalRunRecordIdentity = {
    fingerprint: record.fingerprint,
    model: record.model,
    backend: record.backend,
    settings: { ...record.settings },
  };
  expect(recordIdentity(reordered)).toBe(key);
});

test("changing any one of the four identity fields changes the key", async () => {
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const record = asRecord(run.record);
  const base = recordIdentity(identityOf(record));

  const changed: readonly (readonly [string, EvalRunRecordIdentity])[] = [
    ["the backend", { ...identityOf(record), backend: "claude-cli" }],
    ["the model", { ...identityOf(record), model: "another-model" }],
    [
      "a settings option",
      { ...identityOf(record), settings: { ...record.settings, maxRetries: 2 } },
    ],
    ["the fingerprint", { ...identityOf(record), fingerprint: "0".repeat(64) }],
  ];

  for (const [label, identity] of changed) {
    expect(recordIdentity(identity), `${label} must move the key`).not.toBe(base);
  }
});

test("a caller holding the runner's settings object gets the key the record persisted", async () => {
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const record = asRecord(run.record);

  // The runner's settings carry the model inside them; the identity key
  // drops that stray copy, so both agree.
  const runnerSettings: EvalSettings = settings;
  const fromRunner = recordIdentity({
    backend: record.backend,
    model: record.model,
    settings: runnerSettings,
    fingerprint: record.fingerprint,
  });
  expect(fromRunner).toBe(recordIdentity(identityOf(record)));
});

test("a record read back from disk yields the key it was written with", async () => {
  const dir = tempDir();
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-13T10:00:00.000Z",
  });
  const written = writeEvalRunRecord(run.record, dir);
  const read = readEvalRunRecords(dir);

  expect(read).toHaveLength(1);
  expect(read[0]).toBeDefined();
  expect(written.endsWith(".json")).toBe(true);
  // The JSON-value rule: the record read back is the same value it was
  // written as, so its key is the same key.
  expect(recordIdentity(identityOf(read[0]!))).toBe(
    recordIdentity(identityOf(asRecord(run.record))),
  );
  expect(isRecordCurrent(read[0]!, identityOf(asRecord(run.record)))).toBe(true);
});

test("the predicate is true when all four fields match and false when one does not", async () => {
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const record = asRecord(run.record);

  expect(isRecordCurrent(record, identityOf(record))).toBe(true);

  const stale: readonly (readonly [string, EvalRunRecordIdentity])[] = [
    ["the backend", { ...identityOf(record), backend: "codex-cli" }],
    ["the model", { ...identityOf(record), model: "another-model" }],
    [
      "a settings option",
      { ...identityOf(record), settings: { ...record.settings, responseCap: 128 } },
    ],
    ["the fingerprint", { ...identityOf(record), fingerprint: "1".repeat(64) }],
  ];
  for (const [label, identity] of stale) {
    expect(isRecordCurrent(record, identity), `${label} must make the record stale`).toBe(false);
  }
});

test("two records differing only in their strategy are not current for each other", async () => {
  const oneRung = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const twoRungs = await recordOverCorpus(corpusWithoutDocuments(), {
    strategies: ["single-shot", "per-group"],
    model: "ribo-test",
  });

  expect(oneRung.calls).toBeGreaterThan(0);
  expect(twoRungs.calls).toBeGreaterThan(0);
  // The strategy is not in the fingerprint, so the fingerprints agree...
  expect(twoRungs.record.fingerprint).toBe(oneRung.record.fingerprint);
  // ...but the two records are not the same measurement.
  expect(isRecordCurrent(asRecord(oneRung.record), identityOf(asRecord(twoRungs.record)))).toBe(
    false,
  );
  expect(isRecordCurrent(asRecord(twoRungs.record), identityOf(asRecord(oneRung.record)))).toBe(
    false,
  );
});

test("two records differing only in their model id are not current for each other", async () => {
  const first = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const second = await recordOverCorpus(corpusWithoutDocuments(), {
    strategies: ["single-shot"],
    model: "another-model",
  });

  expect(first.calls).toBeGreaterThan(0);
  expect(second.calls).toBeGreaterThan(0);
  expect(second.record.fingerprint).toBe(first.record.fingerprint);
  expect(isRecordCurrent(asRecord(first.record), identityOf(asRecord(second.record)))).toBe(false);
  expect(isRecordCurrent(asRecord(second.record), identityOf(asRecord(first.record)))).toBe(false);
});

test("every remaining settings axis moves the key, and none of them moves the fingerprint", async () => {
  const base = await recordOverCorpus(corpusWithoutDocuments(), settings);
  const baseRecord = asRecord(base.record);

  const axes: readonly (readonly [string, EvalSettings])[] = [
    [
      "the consensus arbiter",
      { ...settings, consensusCandidates: 3, consensusArbiter: "majority" },
    ],
    ["the retry budget", { ...settings, maxRetries: 2 }],
    ["the response cap", { ...settings, responseCap: 512 }],
    [
      "the split caps",
      {
        ...settings,
        splitCaps: { maxNullableUnionsPerGroup: 4, maxSerializedCharsPerGroup: 4096 },
      },
    ],
  ];

  for (const [label, axis] of axes) {
    const other = await recordOverCorpus(corpusWithoutDocuments(), axis);
    expect(other.calls, `${label} must drive the run`).toBeGreaterThan(0);
    const otherRecord = asRecord(other.record);
    expect(otherRecord.fingerprint, `${label} must not move the fingerprint`).toBe(
      baseRecord.fingerprint,
    );
    expect(
      isRecordCurrent(baseRecord, identityOf(otherRecord)),
      `${label} must make the records stale`,
    ).toBe(false);
    expect(isRecordCurrent(otherRecord, identityOf(baseRecord))).toBe(false);
  }
});
