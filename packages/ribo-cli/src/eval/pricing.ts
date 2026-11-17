/**
 * @file The price table: what a token costs, per backend and per model, on a
 * stated date.
 *
 * Pricing is CALLER configuration, never core's business: core knows nothing
 * about money, and the estimate that guards a run's spend lives in this
 * package, beside the command that spends. Every row is DATED, because a
 * price that is not dated is a guess presented as a fact: the estimate
 * prints the date the row carries, so a stale row is visible rather than
 * silent.
 *
 * The table is keyed by backend AND by model id. The per-backend reference
 * row prices the model class the docs and examples name, because an
 * openai-compatible endpoint may serve any model and a subscription CLI is
 * not metered at all; a per-model row prices one model id at its own public
 * list price, for the models the docs and help mention. A model with no row
 * of its own is priced on its backend's reference row — and the resolution
 * SAYS that is what happened and which reference stood in, because a model
 * that is silently priced at the wrong class is how a cheap model gets
 * estimated at a dear one's prices with nobody told. A model whose list
 * price cannot be stated from a public source gets no row and takes the
 * fallback: no price here is invented.
 *
 * The subscription CLI backends carry the same kind of statement on every
 * row: their own use is not metered per token, so the estimate puts them on
 * the metered backends' scale through a stated token-equivalent assumption.
 *
 * Prefix caching and every other discount are ignored. Ignoring a discount
 * overcounts the run, which is the safe direction: an estimate that refuses
 * too early costs the operator one flag, and an estimate that refuses too late
 * costs money that is already spent.
 */
import type { EvalBackendName } from "./backend.js";

/**
 * The two per-token prices every row carries.
 */
export interface TokenPrices {
  /** The price of a thousand prompt tokens, in US dollars. */
  readonly promptUsdPerThousandTokens: number;
  /** The price of a thousand completion tokens, in US dollars. */
  readonly completionUsdPerThousandTokens: number;
}

/**
 * One backend's reference price row.
 */
export interface BackendPrice extends TokenPrices {
  /** The backend the row prices. */
  readonly backend: EvalBackendName;
  /** The day the row was last priced, as `YYYY-MM-DD`. */
  readonly pricedOn: string;
  /** Where the prices come from. */
  readonly source: string;
  /** The reference model class whose public list price the row holds. */
  readonly referenceClass: string;
  /**
   * The assumption the row prices under, where it carries one.
   *
   * A row without one prices what it says it prices; a row with one prices a
   * stand-in, and the reader is told what the stand-in is.
   */
  readonly assumption?: string;
}

/**
 * One model's price row on one backend: the public list price of a model the
 * docs and help mention, dated and sourced like the reference rows.
 */
export interface ModelPrice extends TokenPrices {
  /** The backend the row prices. */
  readonly backend: EvalBackendName;
  /** The model id the row prices, spelled the way `--model` spells it. */
  readonly model: string;
  /** The day the row was last priced, as `YYYY-MM-DD`. */
  readonly pricedOn: string;
  /** Where the prices come from. */
  readonly source: string;
  /** The assumption the row prices under, where it carries one. */
  readonly assumption?: string;
}

/**
 * The dated reference price table, one row per backend.
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
    referenceClass: "gpt-4o",
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
    referenceClass: "Claude Sonnet",
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
    referenceClass: "gpt-5",
    assumption:
      "the codex CLI is a subscription: its use is not metered per token, so the estimate " +
      "prices the tokens at the token-equivalent list price of the gpt-5 class — the operator's " +
      "actual marginal cost is the subscription fee",
  },
};

/** The subscription token-equivalent assumption, worded for a model row of the named CLI. */
const subscriptionAssumption = (binary: string): string =>
  `the ${binary} CLI is a subscription: its use is not metered per token, so the estimate ` +
  "prices the tokens at the token-equivalent list price of the named model — the operator's " +
  "actual marginal cost is the subscription fee";

/**
 * The dated per-model price rows, keyed by backend and model id.
 *
 * One row per model the docs and the command's help mention, at that model's
 * public list price on the stated date. A model with no row here takes its
 * backend's reference row, and the estimate says so — see the file header.
 */
export const MODEL_PRICE_TABLE: readonly ModelPrice[] = [
  {
    backend: "openai-compatible",
    model: "gpt-4o",
    promptUsdPerThousandTokens: 0.0025,
    completionUsdPerThousandTokens: 0.01,
    pricedOn: "2026-11-17",
    source: "OpenAI's published list price for gpt-4o",
  },
  {
    backend: "claude-cli",
    model: "claude-sonnet-5-5",
    promptUsdPerThousandTokens: 0.002,
    completionUsdPerThousandTokens: 0.01,
    pricedOn: "2026-11-17",
    source: "Anthropic's published list price for claude-sonnet-5-5",
    assumption: subscriptionAssumption("claude"),
  },
  {
    backend: "claude-cli",
    model: "claude-haiku-5-5",
    promptUsdPerThousandTokens: 0.0005,
    completionUsdPerThousandTokens: 0.0025,
    pricedOn: "2026-11-17",
    source:
      "Anthropic's published list price for claude-haiku-5-5, at its long-prompt tier " +
      "(prompts over 100K tokens) so the estimate stays an upper bound",
    assumption: subscriptionAssumption("claude"),
  },
];

/**
 * The price an estimate runs under: the row that was found, and how.
 *
 * The resolution is never silent about which of the two happened — a model
 * priced on its own row, or a model the backend's reference row stood in for
 * — because the difference between the two is exactly the difference between
 * a stated price and a guessed one.
 */
export interface PriceResolution extends TokenPrices {
  /** The backend the estimate prices. */
  readonly backend: EvalBackendName;
  /** The model the run names. */
  readonly model: string;
  /**
   * Which row priced the estimate: `"model"` — the model's own dated row;
   * `"reference"` — the model has no row, so the backend's reference row
   * stood in.
   */
  readonly matched: "model" | "reference";
  /**
   * The row the estimate prices under, named for the reader: the model id
   * for a matched row, or the reference class's row for a fallback.
   */
  readonly rowName: string;
  /** The day the row that priced the estimate was last priced, as `YYYY-MM-DD`. */
  readonly pricedOn: string;
  /** Where the row's prices come from. */
  readonly source: string;
  /** The assumption the row prices under, where it carries one. */
  readonly assumption?: string;
}

/**
 * The price row for a backend and a model.
 *
 * The model's own dated row when the table carries one; the backend's
 * reference row otherwise, with `matched: "reference"` and the reference
 * named, so the estimate can say it fell back and to what.
 * @param backend - The backend to price.
 * @param model - The model id the run names.
 * @returns The dated resolution.
 */
export function priceFor(backend: EvalBackendName, model: string): PriceResolution {
  const own = MODEL_PRICE_TABLE.find((row) => row.backend === backend && row.model === model);
  if (own !== undefined) {
    return {
      backend,
      model,
      matched: "model",
      rowName: own.model,
      promptUsdPerThousandTokens: own.promptUsdPerThousandTokens,
      completionUsdPerThousandTokens: own.completionUsdPerThousandTokens,
      pricedOn: own.pricedOn,
      source: own.source,
      ...(own.assumption === undefined ? {} : { assumption: own.assumption }),
    };
  }
  const reference = PRICE_TABLE[backend];
  return {
    backend,
    model,
    matched: "reference",
    rowName: `the ${reference.referenceClass} reference row`,
    promptUsdPerThousandTokens: reference.promptUsdPerThousandTokens,
    completionUsdPerThousandTokens: reference.completionUsdPerThousandTokens,
    pricedOn: reference.pricedOn,
    source: reference.source,
    ...(reference.assumption === undefined ? {} : { assumption: reference.assumption }),
  };
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
  price: TokenPrices,
  promptTokens: number,
  completionTokens: number,
): number {
  return (
    (promptTokens / 1_000) * price.promptUsdPerThousandTokens +
    (completionTokens / 1_000) * price.completionUsdPerThousandTokens
  );
}
