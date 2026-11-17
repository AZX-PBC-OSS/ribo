/**
 * @file The ceiling's two refusals and its two ways through.
 *
 * The question is asked through an injected confirmation, so the suite never
 * touches a real terminal: the answers are the ones an operator can give.
 */
import { expect, test, vi } from "vitest";

import { EvalError } from "./error.js";
import { enforceSpendCeiling } from "./spend-ceiling.js";
import type { SpendEstimate } from "./spend-guard.js";

/** An estimate over the ceiling. */
const estimate = (usd: number): SpendEstimate => ({
  backend: "openai-compatible",
  price: {
    backend: "openai-compatible",
    model: "ribo-test",
    matched: "reference",
    rowName: "the gpt-4o reference row",
    promptUsdPerThousandTokens: 0.0025,
    completionUsdPerThousandTokens: 0.01,
    pricedOn: "2026-11-13",
    source: "the list price",
  },
  caseCount: 3,
  arms: [],
  callsPerCase: 6,
  worstCaseCalls: 18,
  worstCasePromptTokens: 2700,
  worstCaseCompletionTokens: 73728,
  usd,
});

test("a run under the ceiling proceeds, and asks nothing", async () => {
  const ask = vi.fn(async (_question: string) => true);
  await enforceSpendCeiling({
    estimate: estimate(1),
    maxSpendUsd: 10,
    yes: false,
    confirmation: { ask },
  });
  expect(ask).not.toHaveBeenCalled();
});

test("an over-ceiling run with --yes proceeds, and asks nothing", async () => {
  const ask = vi.fn(async (_question: string) => false);
  await enforceSpendCeiling({
    estimate: estimate(12),
    maxSpendUsd: 10,
    yes: true,
    confirmation: { ask },
  });
  expect(ask).not.toHaveBeenCalled();
});

test("an over-ceiling run the operator confirmed proceeds", async () => {
  const ask = vi.fn(async (_question: string) => true);
  await enforceSpendCeiling({
    estimate: estimate(12),
    maxSpendUsd: 10,
    yes: false,
    confirmation: { ask },
  });
  expect(ask).toHaveBeenCalledTimes(1);
  // The question carries the estimate and the ceiling.
  const question = ask.mock.calls[0]?.[0] ?? "";
  expect(question).toContain("USD 12");
  expect(question).toContain("USD 10");
});

test("an over-ceiling run the operator declined refuses, naming the estimate and the fix", async () => {
  const ask = vi.fn(async (_question: string) => false);
  await expect(
    enforceSpendCeiling({
      estimate: estimate(12),
      maxSpendUsd: 10,
      yes: false,
      confirmation: { ask },
    }),
  ).rejects.toThrow(EvalError);
  expect(ask).toHaveBeenCalledTimes(1);

  let message = "";
  try {
    await enforceSpendCeiling({
      estimate: estimate(12),
      maxSpendUsd: 10,
      yes: false,
      confirmation: { ask },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("above the ceiling");
  expect(message).toContain("USD 12");
  expect(message).toContain("USD 10");
  expect(message).toContain("(fix:");
  expect(message).toContain("--max-spend");
  expect(message).toContain("--yes");
});

test("an over-ceiling run with no terminal refuses without asking", async () => {
  const ask = vi.fn(async (_question: string) => true);
  await expect(
    enforceSpendCeiling({ estimate: estimate(12), maxSpendUsd: 10, yes: false }),
  ).rejects.toThrow(EvalError);
  expect(ask).not.toHaveBeenCalled();
});
