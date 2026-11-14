/**
 * @file The spend guard's estimate model: what it reads, what it multiplies,
 * and what it refuses.
 *
 * The estimate's teeth are its comparisons against the METERED actual — what
 * a run really spent, counted by the runner's own meter. Each of the three
 * must-fail cases below sets the run's retry budget so that the estimate and
 * the meter are directly comparable, and then asserts that the estimate is
 * never the smaller of the two:
 *
 * - a retry storm: every first attempt fails transiently, so the meter counts
 *   more attempts than the plan's entries — an estimate that forgot the retry
 *   multiplier would be UNDER the meter;
 * - a consensus arm: the meter counts one call per candidate, so an estimate
 *   that forgot the candidate multiplier would be UNDER the meter;
 * - a presence-narrowed fixture whose groups split into several pieces: the
 *   meter counts a fill call per PIECE, so an estimate that counted one fill
 *   call per group would be UNDER the meter.
 *
 * No test here spends: every run is driven by the stub chat, and the price
 * table is the package's own dated table.
 */
import { ChatError, describeExtraction, scriptedChat } from "@azx/ribo-core";
import type { ChatRequest } from "@azx/ribo-core";
import { afterEach, expect, test } from "vitest";

import { loadCorpus } from "../corpus/loader.js";
import { describeCalls } from "../inspect/calls.js";
import { runEvalOverSchema } from "./run.js";
import { estimateSpend } from "./spend-guard.js";
import { replyFor, stubChat } from "./test-support/stub-chat.js";
import {
  FIXTURE_FLAT_CORPUS,
  FIXTURE_SPLIT_CORPUS,
  corpusWithCases,
  corpusWithoutDocuments,
  removeTemporaries,
} from "./test-support/corpus.js";
import type { EvalCaseResult, EvalSettings, EvalSplitCaps } from "./types.js";

afterEach(() => {
  removeTemporaries();
});

/** The calls the meter counted, over every case of a run. */
const meteredCalls = (results: readonly EvalCaseResult[]): number =>
  results.reduce((total, entry) => total + (entry.usage?.calls ?? 0), 0);

/**
 * A chat whose FIRST attempt at every distinct request fails transiently.
 *
 * The distinctness is per request — the schema name and the transcript — so
 * every call of every case is retried once, which is what makes the storm.
 */
const stormChat = () => {
  const attempts = new Map<string, number>();
  return scriptedChat((request: ChatRequest) => {
    const last = request.messages[request.messages.length - 1]?.content ?? "";
    const key = `${request.responseFormat.json_schema.name}|${last}`;
    const seen = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, seen);
    if (seen === 1) throw ChatError.transport("the uplink dropped");
    return { content: replyFor(request) };
  });
};

/** Run an arm over a corpus, with the retry backoff stubbed out. */
const runArm = async (
  corpus: ReturnType<typeof loadCorpus>,
  settings: EvalSettings,
  chat: Parameters<typeof runEvalOverSchema>[0]["chat"],
): Promise<readonly EvalCaseResult[]> =>
  runEvalOverSchema({
    schema: corpus.schema,
    prompt: corpus.manifest.prompt,
    manifestName: corpus.manifest.name,
    cases: corpus.cases.map((entry) => ({
      id: entry.id,
      kind: entry.input.kind === "document" ? ("text" as const) : entry.input.kind,
      text: entry.input.kind === "document" ? "" : entry.input.text,
    })),
    chat,
    settings,
    delay: () => Promise.resolve(),
  });

// ---------------------------------------------------------------------------
// The call model is read, never restated
// ---------------------------------------------------------------------------

test("the per-group rung's count is the report's own per-group count", () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const caps: EvalSplitCaps = { maxSerializedCharsPerGroup: 1500 };
  const report = describeCalls(describeExtraction({ schema: corpus.schema, ...caps }), caps);
  expect(report.perGroup).not.toBeNull();

  const estimate = estimateSpend({
    corpus,
    arms: [{ strategies: ["per-group"], model: "ribo-test", splitCaps: caps }],
    backend: "openai-compatible",
  });

  expect(estimate.arms[0]?.rungs[0]?.calls).toBe(report.perGroup);
});

test("the presence-narrowed rung's count is the report's own bound", () => {
  const corpus = loadCorpus(FIXTURE_SPLIT_CORPUS);
  const caps: EvalSplitCaps = { maxSerializedCharsPerGroup: 1500 };
  const report = describeCalls(describeExtraction({ schema: corpus.schema, ...caps }), caps);
  expect(report.presenceNarrowedAtMost).not.toBeNull();

  const estimate = estimateSpend({
    corpus,
    arms: [{ strategies: ["presence-narrowed"], model: "ribo-test", splitCaps: caps }],
    backend: "openai-compatible",
  });

  expect(estimate.arms[0]?.rungs[0]?.calls).toBe(report.presenceNarrowedAtMost);
});

test("a ladder counts every rung, and the multipliers apply to the whole ladder", () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const report = describeCalls(describeExtraction({ schema: corpus.schema }), {});
  expect(report.perGroup).not.toBeNull();

  const estimate = estimateSpend({
    corpus,
    arms: [
      {
        strategies: ["single-shot", "per-group"],
        model: "ribo-test",
        maxRetries: 1,
        consensusCandidates: 3,
      },
    ],
    backend: "openai-compatible",
  });

  const arm = estimate.arms[0];
  expect(arm?.rungs.map((rung) => rung.calls)).toEqual([1, report.perGroup]);
  // Every rung, times the retry multiplier (1 + 1), times the candidates.
  expect(arm?.callsPerCase).toBe((1 + (report.perGroup ?? 0)) * 2 * 3);
  expect(arm?.retryMultiplier).toBe(2);
  expect(arm?.consensusCandidates).toBe(3);
});

test("a run's estimate is the sum of its arms' estimates", () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const one = estimateSpend({
    corpus,
    arms: [{ strategies: ["single-shot"], model: "ribo-test" }],
    backend: "openai-compatible",
  });
  const two = estimateSpend({
    corpus,
    arms: [{ strategies: ["per-group"], model: "ribo-test" }],
    backend: "openai-compatible",
  });
  const both = estimateSpend({
    corpus,
    arms: [
      { strategies: ["single-shot"], model: "ribo-test" },
      { strategies: ["per-group"], model: "ribo-test" },
    ],
    backend: "openai-compatible",
  });

  expect(both.usd).toBeCloseTo(one.usd + two.usd, 10);
  expect(both.worstCaseCalls).toBe(one.worstCaseCalls + two.worstCaseCalls);
});

// ---------------------------------------------------------------------------
// A missing bound refuses
// ---------------------------------------------------------------------------

test("a presence-narrowed arm over a schema with no groups refuses, naming the bound", () => {
  const corpus = loadCorpus(FIXTURE_FLAT_CORPUS);

  expect(() =>
    estimateSpend({
      corpus,
      arms: [{ strategies: ["presence-narrowed"], model: "ribo-test" }],
      backend: "openai-compatible",
    }),
  ).toThrow(/presence-narrowed strategy has no call bound/);
});

test("the refusal names why the bound is missing", () => {
  const corpus = loadCorpus(FIXTURE_FLAT_CORPUS);

  let message = "";
  try {
    estimateSpend({
      corpus,
      arms: [{ strategies: ["presence-narrowed"], model: "ribo-test" }],
      backend: "openai-compatible",
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("no groups");
  expect(message).toContain("(fix:");
});

test("a split that cannot fit a piece refuses the presence-narrowed rung too, naming the bound", () => {
  const corpus = loadCorpus(FIXTURE_SPLIT_CORPUS);

  let message = "";
  try {
    estimateSpend({
      corpus,
      arms: [
        {
          strategies: ["presence-narrowed"],
          model: "ribo-test",
          splitCaps: { maxSerializedCharsPerGroup: 1 },
        },
      ],
      backend: "openai-compatible",
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  // Must-fail: a guard that coerced the null bound to zero, or fell back to
  // the per-group count, would price this run instead of refusing it.
  expect(message).toContain("presence-narrowed strategy has no call bound");
  // The refusal carries the split's own reason, so the operator knows why.
  expect(message).toContain("splitExtractionSchema");
  expect(message).toContain("(fix:");
});

test("a split that cannot fit a piece refuses the per-group rung, naming the reason", () => {
  const corpus = loadCorpus(FIXTURE_SPLIT_CORPUS);

  let message = "";
  try {
    estimateSpend({
      corpus,
      arms: [
        {
          strategies: ["per-group"],
          model: "ribo-test",
          splitCaps: { maxSerializedCharsPerGroup: 1 },
        },
      ],
      backend: "openai-compatible",
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("per-group strategy has no call bound");
  expect(message).toContain("(fix:");
});

// ---------------------------------------------------------------------------
// The estimate is never lower than the metered actual
// ---------------------------------------------------------------------------

test("a retry storm's metered calls are covered by the estimate", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const settings: EvalSettings = { strategies: ["per-group"], model: "ribo-test", maxRetries: 2 };

  const estimate = estimateSpend({ corpus, arms: [settings], backend: "openai-compatible" });
  const results = await runArm(corpus, settings, stormChat());
  const metered = meteredCalls(results);

  // The storm really happened: the meter counted more calls than the plan's
  // entries, so an estimate without the retry multiplier would be under it.
  const report = describeCalls(describeExtraction({ schema: corpus.schema }), {});
  expect(metered).toBeGreaterThan((report.perGroup ?? 0) * corpus.cases.length);
  // Must-fail: an estimate that forgot the retry multiplier prices fewer calls
  // than the storm spent.
  expect(estimate.worstCaseCalls).toBeGreaterThanOrEqual(metered);
});

test("a consensus arm's metered calls are covered by the estimate", async () => {
  const corpus = loadCorpus(corpusWithoutDocuments());
  const settings: EvalSettings = {
    strategies: ["single-shot"],
    model: "ribo-test",
    maxRetries: 0,
    consensusCandidates: 3,
  };

  const estimate = estimateSpend({ corpus, arms: [settings], backend: "openai-compatible" });
  const results = await runArm(corpus, settings, stubChat());
  const metered = meteredCalls(results);

  // Three candidates, one call each, every case.
  expect(metered).toBe(3 * corpus.cases.length);
  // Must-fail: an estimate that forgot the candidate multiplier prices a third
  // of what the arm spent.
  expect(estimate.worstCaseCalls).toBeGreaterThanOrEqual(metered);
});

test("a presence-narrowed split fixture's metered calls are covered by the estimate", async () => {
  const corpus = loadCorpus(FIXTURE_SPLIT_CORPUS);
  const caps: EvalSplitCaps = { maxSerializedCharsPerGroup: 1500 };
  const settings: EvalSettings = {
    strategies: ["presence-narrowed"],
    model: "ribo-test",
    maxRetries: 0,
    splitCaps: caps,
  };

  const estimate = estimateSpend({ corpus, arms: [settings], backend: "openai-compatible" });
  const results = await runArm(corpus, settings, stubChat());
  const metered = meteredCalls(results);

  // The groups split: the fill makes a call per PIECE, so the meter counts
  // more calls than there are groups.
  const report = describeCalls(describeExtraction({ schema: corpus.schema, ...caps }), caps);
  expect(report.presenceNarrowedAtMost).not.toBeNull();
  expect(metered).toBe(report.presenceNarrowedAtMost);
  // Must-fail: an estimate that counted one fill call per group prices fewer
  // calls than the fill made.
  expect(estimate.worstCaseCalls).toBeGreaterThanOrEqual(metered);
});

test("a tight byte cap is estimated under that cap, not under the default one", async () => {
  const corpus = loadCorpus(FIXTURE_SPLIT_CORPUS);
  const baseline = describeCalls(describeExtraction({ schema: corpus.schema }), {}).perGroup;
  expect(baseline).not.toBeNull();

  // The tight cap is derived from the split's own pieces, never restated.
  const pieces = describeExtraction({ schema: corpus.schema }).pieces ?? [];
  const widest = Math.max(...pieces.map((piece) => piece.serializedChars));
  let tight: number | undefined;
  for (let cap = widest - 1; cap >= 1; cap--) {
    const count = describeCalls(
      describeExtraction({ schema: corpus.schema, maxSerializedCharsPerGroup: cap }),
      { maxSerializedCharsPerGroup: cap },
    ).perGroup;
    if (count !== null && count > (baseline ?? 0)) {
      tight = cap;
      break;
    }
  }
  expect(tight).toBeDefined();

  const settings: EvalSettings = {
    strategies: ["per-group"],
    model: "ribo-test",
    maxRetries: 0,
    splitCaps: { maxSerializedCharsPerGroup: tight },
  };
  const estimate = estimateSpend({ corpus, arms: [settings], backend: "openai-compatible" });
  const results = await runArm(corpus, settings, stubChat());
  const metered = meteredCalls(results);

  expect(metered).toBeGreaterThan((baseline ?? 0) * corpus.cases.length);
  // Must-fail: an estimate computed under the DEFAULT caps prices the smaller
  // plan, and is under what the capped run spent.
  expect(estimate.worstCaseCalls).toBeGreaterThanOrEqual(metered);
});

test("the corpus the run measures is the corpus the estimate prices", async () => {
  const corpus = loadCorpus(corpusWithCases("spoken-note"));
  const settings: EvalSettings = { strategies: ["single-shot"], model: "ribo-test" };
  const estimate = estimateSpend({ corpus, arms: [settings], backend: "openai-compatible" });

  expect(estimate.caseCount).toBe(corpus.cases.length);
  expect(estimate.worstCaseCalls).toBe(estimate.callsPerCase * corpus.cases.length);
});
