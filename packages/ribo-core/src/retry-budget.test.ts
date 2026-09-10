import { describe, expect, test } from "vitest";

import { DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_CAP_MS } from "./queue/backoff.js";
import { deriveRetryBudget, PER_CALL_CEILING_MS } from "./retry-budget.js";

// Pure arithmetic — no storage, no browser API. Belongs in the `unit` project.

describe("deriveRetryBudget", () => {
  test("the documented default case derives 2 and reports requested: 2, derived: 2", () => {
    // 15-minute step timeout, 4 concurrency, 7 groups, 2 requested, 120 s ceiling.
    // batches = ceil(7 / 4) = 2; per-group budget at r=2 = 3 * 120_000 + 3_000 = 363_000;
    // worst case = 2 * 363_000 = 726_000 <= 900_000 — fits, so derived = 2.
    const budget = deriveRetryBudget({
      requested: 2,
      batches: Math.ceil(7 / 4),
      stepTimeoutMs: 900_000,
      perCallCeilingMs: PER_CALL_CEILING_MS,
      baseMs: DEFAULT_BACKOFF_BASE_MS,
      capMs: DEFAULT_BACKOFF_CAP_MS,
    });
    expect(budget.derived).toBe(2);
    expect(budget.requested).toBe(2);
  });

  test("a step timeout too tight for even one attempt derives 0", () => {
    // One batch, one call at the ceiling already exceeds the step timeout.
    const budget = deriveRetryBudget({
      requested: 5,
      batches: 1,
      stepTimeoutMs: 10_000,
      perCallCeilingMs: 120_000,
      baseMs: DEFAULT_BACKOFF_BASE_MS,
      capMs: DEFAULT_BACKOFF_CAP_MS,
    });
    expect(budget.derived).toBe(0);
    expect(budget.requested).toBe(5);
  });

  test("requested: 0 derives 0 without looping", () => {
    const budget = deriveRetryBudget({
      requested: 0,
      batches: 4,
      stepTimeoutMs: 900_000,
      perCallCeilingMs: 120_000,
      baseMs: DEFAULT_BACKOFF_BASE_MS,
      capMs: DEFAULT_BACKOFF_CAP_MS,
    });
    expect(budget.derived).toBe(0);
    expect(budget.requested).toBe(0);
  });

  test("the returned batches and perCallCeilingMs echo the inputs", () => {
    const budget = deriveRetryBudget({
      requested: 2,
      batches: 3,
      stepTimeoutMs: 900_000,
      perCallCeilingMs: 60_000,
      baseMs: DEFAULT_BACKOFF_BASE_MS,
      capMs: DEFAULT_BACKOFF_CAP_MS,
    });
    expect(budget.batches).toBe(3);
    expect(budget.perCallCeilingMs).toBe(60_000);
  });
});

// --- Moved from per-group.test.ts — the no-behaviour-change proof ----------
// These three cases are the regression gate: the expected values are identical
// to what `deriveMaxRetries` produced. Only the call shape changed (options
// object + `.derived` instead of positional args + bare number).

describe("deriveRetryBudget — moved derivation cases (no behaviour change)", () => {
  const snuggGroups = 7;

  test("default ceiling keeps existing callers at the requested retry count", () => {
    expect(
      deriveRetryBudget({
        requested: 2,
        batches: Math.ceil(snuggGroups / 4),
        stepTimeoutMs: 900_000,
        perCallCeilingMs: 120_000,
        baseMs: DEFAULT_BACKOFF_BASE_MS,
        capMs: DEFAULT_BACKOFF_CAP_MS,
      }).derived,
    ).toBe(2);
  });

  test("serializing under the default ceiling yields zero retries", () => {
    expect(
      deriveRetryBudget({
        requested: 2,
        batches: snuggGroups,
        stepTimeoutMs: 900_000,
        perCallCeilingMs: 120_000,
        baseMs: DEFAULT_BACKOFF_BASE_MS,
        capMs: DEFAULT_BACKOFF_CAP_MS,
      }).derived,
    ).toBe(0);
  });

  test("a lower ceiling lets a serial delegate honour the requested retries", () => {
    expect(
      deriveRetryBudget({
        requested: 4,
        batches: snuggGroups,
        stepTimeoutMs: 900_000,
        perCallCeilingMs: 15_000,
        baseMs: DEFAULT_BACKOFF_BASE_MS,
        capMs: DEFAULT_BACKOFF_CAP_MS,
      }).derived,
    ).toBe(4);
  });
});
