/**
 * @file The record format: what a record carries, and what the schema
 * refuses.
 *
 * A record is the source of truth every view renders, so the format is
 * pinned here: the fields it carries, the strictness it parses with, and the
 * density of its grid. The runs are driven over the stub chat — no model, no
 * network, no credential — and every suite asserts the stub saw calls, so a
 * run that drove nothing cannot pass vacuously.
 */
import { afterEach, expect, test } from "vitest";

import { scriptedChat } from "@azx/ribo-core";

import { loadCorpus } from "../corpus/loader.js";
import { runEval } from "./run.js";
import { scoreEvalRun } from "./score.js";
import { buildEvalRunRecord } from "./record-build.js";
import { EvalRunRecordSchema } from "./record-schema.js";
import type { EvalRunRecord } from "./record-schema.js";
import { replyFor } from "./test-support/stub-chat.js";
import { corpusWithoutDocuments, removeTemporaries } from "./test-support/corpus.js";
import { recordOverCorpus } from "./test-support/record.js";

afterEach(() => {
  removeTemporaries();
});

/** The settings every record suite runs under. */
const settings = { strategies: ["single-shot"], model: "ribo-test" } as const;

/** A complete record, with the empty lineage a first write gives it. */
const complete = (record: ReturnType<typeof buildEvalRunRecord>): EvalRunRecord => ({
  ...record,
  history: [],
});

test("a record produced by a run round-trips through the exported schema", async () => {
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-13T10:00:00.000Z",
  });

  // The run drove the model: a run that reached nothing fails here.
  expect(run.calls).toBeGreaterThan(0);

  const document = JSON.parse(JSON.stringify(complete(run.record))) as unknown;
  const parsed = EvalRunRecordSchema.parse(document);

  // Compile-time: the zod schema's inferred shape and the record type are the
  // same contract — a field added to one and not the other fails here.
  const asRecord: EvalRunRecord = parsed;
  const fromRecord: typeof parsed = complete(run.record);
  expect(asRecord).toEqual(fromRecord);
});

test("the schema refuses a record it cannot vouch for", async () => {
  const run = await recordOverCorpus(corpusWithoutDocuments(), settings, {
    capturedAt: "2026-11-13T10:00:00.000Z",
  });
  const valid = complete(run.record);

  const refusals: readonly (readonly [string, () => unknown])[] = [
    ["a wrong contract version", () => ({ ...valid, contractVersion: 2 })],
    ["a missing required field", () => ({ ...valid, model: undefined })],
    ["an unknown key at the top level", () => ({ ...valid, extra: "no" })],
    [
      "an unknown key inside the settings",
      () => ({ ...valid, settings: { ...valid.settings, extra: "no" } }),
    ],
    [
      "an unknown key inside a cell",
      () => {
        const leafPath = valid.leafPaths[0]!;
        const caseId = Object.keys(valid.grid[leafPath] ?? {})[0]!;
        const cell = valid.grid[leafPath]![caseId]!;
        return {
          ...valid,
          grid: {
            ...valid.grid,
            [leafPath]: { ...valid.grid[leafPath], [caseId]: { ...cell, extra: "no" } },
          },
        };
      },
    ],
    [
      "a verdict outside the vocabulary",
      () => {
        const leafPath = valid.leafPaths[0]!;
        const caseId = Object.keys(valid.grid[leafPath] ?? {})[0]!;
        const cell = valid.grid[leafPath]![caseId]!;
        return {
          ...valid,
          grid: {
            ...valid.grid,
            [leafPath]: { ...valid.grid[leafPath], [caseId]: { ...cell, verdict: "excellent" } },
          },
        };
      },
    ],
    ["a malformed fingerprint", () => ({ ...valid, fingerprint: "not-a-digest" })],
    [
      "an uppercase fingerprint",
      () => ({ ...valid, fingerprint: valid.fingerprint.toUpperCase() }),
    ],
    ["a backend outside the vocabulary", () => ({ ...valid, backend: "telepathy" })],
    [
      "a consensus count below two",
      () => ({ ...valid, settings: { ...valid.settings, consensusCandidates: 1 } }),
    ],
    [
      "a corpus fingerprint that is not a digest",
      () => ({
        ...valid,
        corpus: { ...valid.corpus, fingerprint: "short" },
      }),
    ],
  ];

  for (const [label, mutate] of refusals) {
    const parsed = EvalRunRecordSchema.safeParse(mutate());
    expect(parsed.success, `${label} must be refused`).toBe(false);
  }

  // The record the run produced is itself valid.
  expect(EvalRunRecordSchema.safeParse(valid).success).toBe(true);
});

test("the record carries the corpus's identity, the model beside the settings, and a dense grid", async () => {
  const corpusDir = corpusWithoutDocuments();
  const run = await recordOverCorpus(corpusDir, settings);
  const loaded = loadCorpus(corpusDir);

  expect(run.record.corpus.name).toBe(loaded.manifest.name);
  expect(run.record.corpus.provenance).toBe(loaded.manifest.provenance);
  expect(run.record.corpus.fingerprint).toMatch(/^[0-9a-f]{64}$/u);

  // The model is its own field, and it is NOT inside the settings.
  expect(run.record.model).toBe("ribo-test");
  expect(Object.keys(run.record.settings)).not.toContain("model");

  // The grid is dense: every leaf of every case has a cell.
  expect(run.record.leafPaths).toEqual([...run.score.leafPaths]);
  expect(Object.keys(run.record.grid).sort()).toEqual([...run.score.leafPaths].sort());
  for (const leafPath of run.record.leafPaths) {
    expect(Object.keys(run.record.grid[leafPath] ?? {}).sort()).toEqual(
      run.results.map((entry) => entry.caseId).sort(),
    );
  }
});

test("a run whose case failed still produces a record, with the failure scored", async () => {
  const corpusDir = corpusWithoutDocuments();
  const corpus = loadCorpus(corpusDir);
  // The first call fails: the transport refuses that case, and the case is
  // scored as an empty extraction rather than aborting the run.
  const chat = scriptedChat((request, context) => {
    if (context.call === 0) throw new Error("the transport refused the call");
    return { content: replyFor(request) };
  });
  const results = await runEval(corpus, chat, settings);
  const score = scoreEvalRun(corpus, results);
  const record = buildEvalRunRecord({
    corpus,
    backend: "openai-compatible",
    settings,
    results,
    score,
    capturedAt: "2026-11-13T10:00:00.000Z",
  });

  const failedCase = results.find((entry) => entry.status === "failed");
  expect(failedCase).toBeDefined();
  expect(chat.calls.length).toBeGreaterThan(0);

  // The failed case's cells are in the record, and the totals count them.
  const failedId = failedCase!.caseId;
  const leafPath = record.leafPaths[0]!;
  expect(record.grid[leafPath]?.[failedId]).toBeDefined();
  expect(record.totals.cases).toBe(results.length);
  expect(record.totals.missed + record.totals.hallucinated + record.totals.correct).toBeGreaterThan(
    0,
  );

  // The record round-trips.
  const parsed = EvalRunRecordSchema.parse(JSON.parse(JSON.stringify({ ...record, history: [] })));
  expect(parsed).toEqual({ ...record, history: [] });
});
