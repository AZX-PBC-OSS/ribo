/**
 * @file The price table: what a token costs, per backend, on a stated date.
 *
 * Pricing is CALLER configuration, never core's business: core knows nothing
 * about money, and the estimate that guards a run's spend lives in this
 * package, beside the command that spends. The table is DATED, because a price
 * that is not dated is a guess presented as a fact: the estimate prints the
 * date the row carries, so a stale row is visible rather than silent.
 *
 * The table is per BACKEND, not per model, on purpose: an
 * openai-compatible endpoint may serve any model, and the estimate cannot know
 * which. Each row therefore carries the reference model class whose public
 * list price it holds, and says so — the model-dependence is a stated
 * assumption, not hidden precision. The two subscription CLI backends carry
 * the same kind of statement: their own use is not metered per token, so the
 * estimate puts them on the metered backends' scale through a stated
 * token-equivalent assumption.
 *
 * Prefix caching and every other discount are ignored. Ignoring a discount
 * overcounts the run, which is the safe direction: an estimate that refuses
 * too early costs the operator one flag, and an estimate that refuses too late
 * costs money that is already spent.
 */
import type { EvalBackendName } from "./backend.js";

/**
 * One backend's price row.
 */
export interface BackendPrice {
  /** The backend the row prices. */
  readonly backend: EvalBackendName;
  /** The price of a thousand prompt tokens, in US dollars. */
  readonly promptUsdPerThousandTokens: number;
  /** The price of a thousand completion tokens, in US dollars. */
  readonly completionUsdPerThousandTokens: number;
  /** The day the row was last priced, as `YYYY-MM-DD`. */
  readonly pricedOn: string;
  /** Where the prices come from. */
  readonly source: string;
  /**
   * The assumption the row prices under, where it carries one.
   *
   * A row without one prices what it says it prices; a row with one prices a
   * stand-in, and the reader is told what the stand-in is.
   */
  readonly assumption?: string;
}

/**
 * The dated price table, one row per backend.
 *
 * The three rows carry the public list prices of their reference model class
 * as published on the date each row carries; the subscription rows carry the
 * token-equivalent assumption that puts an unmetered subscription on the same
 * scale as a metered endpoint.
 */
export const PRICE_TABLE: Readonly<Record<EvalBackendName, BackendPrice>> = {
  "openai-compatible": {
    backend: "openai-compatible",
    promptUsdPerThousandTokens: 0.0025,
    completionUsdPerThousandTokens: 0.01,
    pricedOn: "2026-11-13",
    source: "OpenAI's published list price for the gpt-4o model class",
    assumption:
      "the row prices the gpt-4o model class; an openai-compatible endpoint may serve any " +
      "model, so the price is the reference class's, not the endpoint's own",
  },
  "claude-cli": {
    backend: "claude-cli",
    promptUsdPerThousandTokens: 0.003,
    completionUsdPerThousandTokens: 0.015,
    pricedOn: "2026-11-13",
    source: "Anthropic's published list price for the Claude Sonnet model class",
    assumption:
      "the claude CLI is a subscription: its use is not metered per token, so the estimate " +
      "prices the tokens at the token-equivalent list price of the Claude Sonnet class — the " +
      "operator's actual marginal cost is the subscription fee",
  },
  "codex-cli": {
    backend: "codex-cli",
    promptUsdPerThousandTokens: 0.00125,
    completionUsdPerThousandTokens: 0.01,
    pricedOn: "2026-11-13",
    source: "OpenAI's published list price for the gpt-5 model class",
    assumption:
      "the codex CLI is a subscription: its use is not metered per token, so the estimate " +
      "prices the tokens at the token-equivalent list price of the gpt-5 class — the operator's " +
      "actual marginal cost is the subscription fee",
  },
};

/**
 * The price row for a backend.
 * @param backend - The backend to price.
 * @returns The dated row.
 */
export function priceFor(backend: EvalBackendName): BackendPrice {
  return PRICE_TABLE[backend];
}

/**
 * The dollar cost of a token count under a price row.
 *
 * The tokens are counted as they are: a fraction of a million is a fraction of
 * a dollar, and no rounding is applied here — the display rounds, so the
 * comparison against a ceiling is made on the full number.
 * @param price - The row to price under.
 * @param promptTokens - The prompt tokens.
 * @param completionTokens - The completion tokens.
 * @returns The cost in US dollars.
 */
export function priceTokens(
  price: BackendPrice,
  promptTokens: number,
  completionTokens: number,
): number {
  return (
    (promptTokens / 1_000) * price.promptUsdPerThousandTokens +
    (completionTokens / 1_000) * price.completionUsdPerThousandTokens
  );
}
