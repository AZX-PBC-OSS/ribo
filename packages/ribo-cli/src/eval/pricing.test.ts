/**
 * @file The per-model price rows: a model with its own dated row is priced
 * on it; a model with no row falls back to the backend's reference row, and
 * the resolution says which happened — a model is never silently priced.
 *
 * The table is data and the resolution is pure, so no test here spends
 * anything.
 */
import { expect, test } from "vitest";

import { EVAL_BACKENDS } from "./backend.js";
import { MODEL_PRICE_TABLE, PRICE_TABLE, priceFor } from "./pricing.js";

test("a model with its own row resolves to that row, not the backend's reference", () => {
  const resolved = priceFor("claude-cli", "claude-haiku-5-5");

  // Must-fail: a resolution that ignored the model returns the reference
  // row's Sonnet prices and has no `matched` to report.
  expect(resolved.matched).toBe("model");
  expect(resolved.rowName).toBe("claude-haiku-5-5");
  // The model's own row's prices, not the Sonnet reference row's.
  const row = MODEL_PRICE_TABLE.find(
    (entry) => entry.backend === "claude-cli" && entry.model === "claude-haiku-5-5",
  );
  expect(resolved.promptUsdPerThousandTokens).toBe(row?.promptUsdPerThousandTokens);
  expect(resolved.completionUsdPerThousandTokens).toBe(row?.completionUsdPerThousandTokens);
  expect(resolved.promptUsdPerThousandTokens).not.toBe(
    PRICE_TABLE["claude-cli"].promptUsdPerThousandTokens,
  );
  // A dated, sourced row — never an invented number.
  expect(resolved.pricedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(resolved.source).toContain("Anthropic");
});

test("a model with no row falls back to the backend's reference row, and says so", () => {
  const resolved = priceFor("claude-cli", "claude-unlisted-9");

  expect(resolved.matched).toBe("reference");
  expect(resolved.model).toBe("claude-unlisted-9");
  // The reference it used is named, and the prices are the reference row's.
  expect(resolved.rowName).toContain("Claude Sonnet");
  expect(resolved.promptUsdPerThousandTokens).toBe(
    PRICE_TABLE["claude-cli"].promptUsdPerThousandTokens,
  );
  expect(resolved.completionUsdPerThousandTokens).toBe(
    PRICE_TABLE["claude-cli"].completionUsdPerThousandTokens,
  );
  expect(resolved.pricedOn).toBe(PRICE_TABLE["claude-cli"].pricedOn);
  // The subscription assumption travels with the fallback.
  expect(resolved.assumption).toContain("subscription");
});

test("the models the help and the docs mention each resolve to their own row", () => {
  for (const [backend, model] of [
    ["openai-compatible", "gpt-4o"],
    ["claude-cli", "claude-sonnet-5-5"],
    ["claude-cli", "claude-haiku-5-5"],
  ] as const) {
    expect(priceFor(backend, model).matched).toBe("model");
  }
});

test("every model row names a real backend, and is dated and sourced", () => {
  expect(MODEL_PRICE_TABLE.length).toBeGreaterThan(0);
  for (const row of MODEL_PRICE_TABLE) {
    expect(EVAL_BACKENDS).toContain(row.backend);
    expect(row.model.length).toBeGreaterThan(0);
    expect(row.pricedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.source.length).toBeGreaterThan(0);
    expect(row.promptUsdPerThousandTokens).toBeGreaterThan(0);
    expect(row.completionUsdPerThousandTokens).toBeGreaterThan(0);
  }
});
