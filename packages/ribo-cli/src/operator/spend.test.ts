/**
 * @file Fixed-call authoring spend bounds. Stub chats and stub CLI children are
 * driven to their scripted limits; no test reaches a model or paid endpoint.
 */
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";

import { expect, test, vi } from "vitest";

import { scriptedChat } from "@azx/ribo-core";
import type { ChatRequest } from "@azx/ribo-core";

import { colorsFor } from "../colors.js";
import { cliChat } from "../cli-chat.js";
import { priceTokens } from "../eval/pricing.js";
import { AUTHORING_CLI_SHAPE_ATTEMPTS, prepareOperatorBackend } from "./backend.js";
import { OperatorError } from "./error.js";
import {
  DEFAULT_COMPLETION_TOKENS,
  enforceOperatorSpendCeiling,
  estimateFixedCallSpend,
  formatFixedCallSpend,
  usd,
} from "./spend.js";

const REQUEST: ChatRequest = {
  model: "test-model",
  messages: [{ role: "user", content: "TRANSCRIPT-TEXT-MARKER" }],
  responseFormat: {
    type: "json_schema",
    json_schema: {
      name: "t",
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
};

class FakeStdin extends EventEmitter {
  write(_chunk: string): boolean {
    return true;
  }
  end(): void {}
}

/** A CLI child that immediately returns non-conforming output. */
function nonConformingSpawn(): { spawnImpl: typeof spawn; calls: number } {
  const state = { calls: 0 };
  const spawnImpl = (() => {
    state.calls += 1;
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    Object.assign(child, {
      stdout,
      stderr,
      stdin: new FakeStdin(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      stdout.emit("data", Buffer.from("not JSON"));
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof spawn;
  return {
    spawnImpl,
    get calls() {
      return state.calls;
    },
  };
}

/** Exhaust each independent layer, retaining the last failure for the caller. */
async function exhaustLayers(
  chat: ReturnType<typeof cliChat>,
  initialCalls: number,
  semanticRepairs: number,
  transportRetries: number,
): Promise<void> {
  for (let initial = 0; initial < initialCalls; initial++) {
    for (let repair = 0; repair <= semanticRepairs; repair++) {
      for (let retry = 0; retry <= transportRetries; retry++) {
        await expect(chat.complete(REQUEST)).rejects.toThrow(/no schema-conforming JSON/u);
      }
    }
  }
}

test("scripted exhaustion equals the independent initial, semantic-repair, transport-retry and CLI-shape worst-case call bound", async () => {
  const budget = {
    initialCalls: 2,
    semanticRepairs: 1,
    transportRetries: 2,
    cliShapeAttempts: 3,
  } as const;
  const process = nonConformingSpawn();
  const chat = cliChat({
    backend: "codex",
    spawnImpl: process.spawnImpl,
    maxAttempts: budget.cliShapeAttempts,
  });

  await exhaustLayers(chat, budget.initialCalls, budget.semanticRepairs, budget.transportRetries);

  const estimate = estimateFixedCallSpend({
    backend: "codex-cli",
    model: "test-model",
    budget,
    promptChars: 100,
    completionTokensPerCall: 20,
  });
  const expected = 2 * (1 + 1) * (1 + 2) * 3;
  expect(process.calls).toBe(expected);
  expect(estimate.worstCaseCalls).toBe(expected);
  expect(estimate.attemptsPerInitialCall).toBe((1 + 1) * (1 + 2) * 3);
  expect(estimate.budget).toEqual(budget);
});

test("HTTP has no CLI shape multiplier, production authoring pins one shape attempt, and zero calls produce a zero estimate", async () => {
  const http = estimateFixedCallSpend({
    backend: "openai-compatible",
    model: "test-model",
    budget: {
      initialCalls: 2,
      semanticRepairs: 1,
      transportRetries: 1,
      cliShapeAttempts: 4,
    },
    promptChars: 100,
  });
  expect(http.budget.cliShapeAttempts).toBe(1);
  expect(http.worstCaseCalls).toBe(2 * 2 * 2);

  const authoring = estimateFixedCallSpend({
    backend: "claude-cli",
    model: "test-model",
    budget: { initialCalls: 1, semanticRepairs: 2, transportRetries: 1 },
    promptChars: 100,
  });
  expect(AUTHORING_CLI_SHAPE_ATTEMPTS).toBe(1);
  expect(authoring.budget.cliShapeAttempts).toBe(1);
  expect(authoring.worstCaseCalls).toBe(3 * 2);

  const process = nonConformingSpawn();
  const client = await prepareOperatorBackend({
    backend: "claude-cli",
    requiredCalls: 1,
    preflightImpl: vi.fn(async () => {}),
    spawnImpl: process.spawnImpl,
  });
  await expect(client?.complete(REQUEST)).rejects.toThrow(/after 1 attempt/u);
  expect(process.calls).toBe(1);

  const zero = estimateFixedCallSpend({
    backend: "codex-cli",
    model: "test-model",
    budget: { initialCalls: 0, semanticRepairs: 3, transportRetries: 2 },
    promptChars: 0,
  });
  expect(zero.worstCaseCalls).toBe(0);
  expect(zero.worstCasePromptTokens).toBe(0);
  expect(zero.worstCaseCompletionTokens).toBe(0);
  expect(zero.usd).toBe(0);
});

test("per-attempt prompt growth and completion caps keep the estimate at or above scripted actual cost", async () => {
  const initialCalls = 2;
  const semanticRepairs = 1;
  const transportRetries = 1;
  const promptChars = 101;
  const promptGrowthCharsPerAttempt = 37;
  const completionTokensPerCall = 23;
  const actualUsage: { promptTokens: number; completionTokens: number }[] = [];
  const chat = scriptedChat((request) => {
    const chars = request.messages.reduce((total, message) => total + message.content.length, 0);
    const usage = {
      promptTokens: Math.ceil(chars / 2),
      completionTokens: request.maxTokens ?? DEFAULT_COMPLETION_TOKENS,
    };
    actualUsage.push(usage);
    return { content: '{"ok":true}', usage };
  });

  for (let initial = 0; initial < initialCalls; initial++) {
    let attempt = 0;
    for (let repair = 0; repair <= semanticRepairs; repair++) {
      for (let retry = 0; retry <= transportRetries; retry++) {
        await chat.complete({
          ...REQUEST,
          messages: [
            {
              role: "user",
              content: "x".repeat(promptChars + promptGrowthCharsPerAttempt * attempt),
            },
          ],
          maxTokens: completionTokensPerCall,
        });
        attempt += 1;
      }
    }
  }

  const estimate = estimateFixedCallSpend({
    backend: "openai-compatible",
    model: "test-model",
    budget: { initialCalls, semanticRepairs, transportRetries },
    promptChars,
    promptGrowthCharsPerAttempt,
    completionTokensPerCall,
  });
  const withoutGrowth = estimateFixedCallSpend({
    backend: "openai-compatible",
    model: "test-model",
    budget: { initialCalls, semanticRepairs, transportRetries },
    promptChars,
    completionTokensPerCall,
  });
  const actualPromptTokens = actualUsage.reduce((total, usage) => total + usage.promptTokens, 0);
  const actualCompletionTokens = actualUsage.reduce(
    (total, usage) => total + usage.completionTokens,
    0,
  );
  const actualUsd = priceTokens(estimate.price, actualPromptTokens, actualCompletionTokens);

  expect(actualUsage).toHaveLength(estimate.worstCaseCalls);
  expect(estimate.worstCasePromptTokens).toBeGreaterThanOrEqual(actualPromptTokens);
  expect(actualPromptTokens).toBeGreaterThan(withoutGrowth.worstCasePromptTokens);
  expect(estimate.worstCaseCompletionTokens).toBe(actualCompletionTokens);
  expect(estimate.usd).toBeGreaterThanOrEqual(actualUsd);

  const display = formatFixedCallSpend(estimate, colorsFor({ isTTY: false })).join("\n");
  expect(display).toContain("semantic repairs");
  expect(display).toContain("transport retries");
  expect(display).toContain("upper bound");
});

test("over-ceiling authoring refuses with OperatorError before the first stub call, while override and confirmation retain their semantics", async () => {
  const estimate = estimateFixedCallSpend({
    backend: "openai-compatible",
    model: "test-model",
    budget: { initialCalls: 1 },
    promptChars: 100_000,
    completionTokensPerCall: 10_000,
  });
  const maxSpendUsd = estimate.usd - 0.001;
  const chat = scriptedChat({ content: '{"ok":true}' });
  const spend = vi.fn(async () => {
    await chat.complete(REQUEST);
  });
  const run = async (yes: boolean, ask?: (question: string) => Promise<boolean>) => {
    await enforceOperatorSpendCeiling({
      estimate,
      maxSpendUsd,
      yes,
      ...(ask === undefined ? {} : { confirmation: { ask } }),
    });
    await spend();
  };

  let refusal: unknown;
  try {
    await run(false);
    throw new Error("expected the ceiling to refuse");
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(OperatorError);
  expect(spend).not.toHaveBeenCalled();
  expect(chat.calls).toHaveLength(0);
  expect((refusal as Error).message).toBe(
    `the estimated spend (${usd(estimate.usd)}) is above the ceiling ` +
      `(${usd(maxSpendUsd)}) — the run was refused before any model call (fix: raise the ` +
      `ceiling with --max-spend ${(estimate.usd * 1.1).toFixed(2)}, or confirm the run with --yes)`,
  );

  await run(true);
  expect(spend).toHaveBeenCalledTimes(1);

  const confirm = vi.fn(async (_question: string) => true);
  await run(false, confirm);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(spend).toHaveBeenCalledTimes(2);

  const decline = vi.fn(async (_question: string) => false);
  await expect(run(false, decline)).rejects.toThrow(OperatorError);
  expect(spend).toHaveBeenCalledTimes(2);
});

test("invalid fixed-call budgets are OperatorError refusals, never silent zeroes", () => {
  const base = {
    backend: "openai-compatible",
    model: "test-model",
    promptChars: 10,
  } as const;
  const invalid = [
    { budget: { initialCalls: -1 } },
    { budget: { initialCalls: 1, semanticRepairs: -1 } },
    { budget: { initialCalls: 1, transportRetries: 0.5 } },
    { budget: { initialCalls: 1, cliShapeAttempts: 0 } },
    { budget: { initialCalls: 1 }, promptChars: -1 },
    { budget: { initialCalls: 1 }, promptGrowthCharsPerAttempt: Number.NaN },
    { budget: { initialCalls: 1 }, completionTokensPerCall: Number.POSITIVE_INFINITY },
  ];

  for (const extra of invalid) {
    expect(() => estimateFixedCallSpend({ ...base, ...extra })).toThrow(OperatorError);
  }
});
