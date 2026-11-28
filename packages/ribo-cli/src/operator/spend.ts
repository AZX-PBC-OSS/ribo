/**
 * @file Fixed-call authoring estimates, neutral display helpers and the shared
 * ceiling decision. Corpus estimation remains eval's own call model.
 *
 * Every retry layer is multiplied independently. Prompt growth is priced per
 * attempt, with rounding done in the conservative direction, so an estimate may
 * overcount but never prices a scripted worst case below its actual usage.
 */
import type { Colors } from "../colors.js";
import { priceFor, priceTokens } from "../eval/pricing.js";
import type { PriceResolution } from "../eval/pricing.js";
import { AUTHORING_CLI_SHAPE_ATTEMPTS, isOperatorCliBackend } from "./backend.js";
import type { OperatorBackendName } from "./backend.js";
import { OperatorError } from "./error.js";

/** The ceiling when a command's operator names none. */
export const DEFAULT_MAX_SPEND_USD = 10;

/** The completion-side bound when the caller sets no response cap. */
export const DEFAULT_COMPLETION_TOKENS = 4096;

/** Conservative characters-per-token assumption shared with eval. */
export const CHARS_PER_TOKEN = 2;

/** A dollar amount with up to four decimals and insignificant zeroes removed. */
export const usd = (value: number): string =>
  `USD ${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;

/** Group digits for a readable bound without changing its value. */
export const groupDigits = (value: number): string =>
  Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The independent call layers an authoring operation can exhaust. */
export interface FixedCallBudget {
  /** Independent initial requests. Zero is valid and performs no work. */
  readonly initialCalls: number;
  /** Semantic repair rounds after each initial request. Defaults to zero. */
  readonly semanticRepairs?: number;
  /** Transport retries after each semantic attempt. Defaults to zero. */
  readonly transportRetries?: number;
  /** Total CLI shape attempts inside each transport attempt. Authoring defaults to one. */
  readonly cliShapeAttempts?: number;
}

/** A normalized budget, including the backend's effective shape layer. */
export type NormalizedFixedCallBudget = Required<FixedCallBudget>;

/** Inputs for a fixed-call upper bound. */
export interface FixedCallSpendInput {
  readonly backend: OperatorBackendName;
  readonly model: string;
  readonly budget: FixedCallBudget;
  /** Characters in an initial request's measured prompt. */
  readonly promptChars: number;
  /** The most a subsequent attempt's prompt can grow over its predecessor. */
  readonly promptGrowthCharsPerAttempt?: number;
  /** Per-call completion cap; the shared default applies when absent. */
  readonly completionTokensPerCall?: number;
}

/** The full fixed-call bound and its dated price basis. */
export interface FixedCallSpendEstimate {
  readonly backend: OperatorBackendName;
  readonly model: string;
  readonly price: PriceResolution;
  readonly budget: NormalizedFixedCallBudget;
  readonly attemptsPerInitialCall: number;
  readonly worstCaseCalls: number;
  readonly promptTokensPerCall: number;
  readonly completionTokensPerCall: number;
  readonly worstCasePromptTokens: number;
  readonly worstCaseCompletionTokens: number;
  readonly usd: number;
}

const refuseBudget = (field: string, value: number, requirement: string): never => {
  throw new OperatorError(
    `${field} must be ${requirement}, got ${String(value)} ` +
      "(fix: pass a finite budget that describes the planned work)",
  );
};

const nonNegativeInteger = (field: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuseBudget(field, value, "a non-negative safe integer");
  }
  return value;
};

const positiveInteger = (field: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    refuseBudget(field, value, "a positive safe integer");
  }
  return value;
};

const safeMultiply = (left: number, right: number, label: string): number => {
  const product = left * right;
  if (!Number.isSafeInteger(product)) {
    throw new OperatorError(
      `${label} exceeds JavaScript's safe integer range — no honest upper bound can be quoted ` +
        "(fix: reduce the fixed-call budget)",
    );
  }
  return product;
};

const safeAdd = (left: number, right: number, label: string): number => {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new OperatorError(
      `${label} exceeds JavaScript's safe integer range — no honest upper bound can be quoted ` +
        "(fix: reduce the fixed-call budget or prompt size)",
    );
  }
  return sum;
};

const normalizeBudget = (
  backend: OperatorBackendName,
  budget: FixedCallBudget,
): NormalizedFixedCallBudget => {
  const initialCalls = nonNegativeInteger("initialCalls", budget.initialCalls);
  const semanticRepairs = nonNegativeInteger("semanticRepairs", budget.semanticRepairs ?? 0);
  const transportRetries = nonNegativeInteger("transportRetries", budget.transportRetries ?? 0);
  const requestedShapeAttempts = positiveInteger(
    "cliShapeAttempts",
    budget.cliShapeAttempts ?? AUTHORING_CLI_SHAPE_ATTEMPTS,
  );
  return {
    initialCalls,
    semanticRepairs,
    transportRetries,
    cliShapeAttempts: isOperatorCliBackend(backend) ? requestedShapeAttempts : 1,
  };
};

/**
 * Price every initial, semantic-repair, transport-retry and CLI-shape attempt.
 * HTTP has no CLI shape loop, so its effective shape multiplier is always one.
 */
export function estimateFixedCallSpend(input: FixedCallSpendInput): FixedCallSpendEstimate {
  if (input.model.length === 0) {
    throw new OperatorError("model must be a non-empty string (fix: name the model to price)");
  }
  const budget = normalizeBudget(input.backend, input.budget);
  const promptChars = nonNegativeInteger("promptChars", input.promptChars);
  const promptGrowth = nonNegativeInteger(
    "promptGrowthCharsPerAttempt",
    input.promptGrowthCharsPerAttempt ?? 0,
  );
  const completionTokensPerCall = nonNegativeInteger(
    "completionTokensPerCall",
    input.completionTokensPerCall ?? DEFAULT_COMPLETION_TOKENS,
  );

  const semanticMultiplier = safeAdd(1, budget.semanticRepairs, "the semantic-attempt bound");
  const transportMultiplier = safeAdd(1, budget.transportRetries, "the transport-attempt bound");
  const attemptsPerInitialCall = safeMultiply(
    safeMultiply(semanticMultiplier, transportMultiplier, "the semantic/transport call bound"),
    budget.cliShapeAttempts,
    "the per-initial call bound",
  );
  const worstCaseCalls = safeMultiply(
    budget.initialCalls,
    attemptsPerInitialCall,
    "the fixed-call bound",
  );

  // Rounding base and growth separately can only overcount the sum of each
  // attempt's rounded token count, which is the safe direction for a ceiling.
  const basePromptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  const growthPromptTokens = Math.ceil(promptGrowth / CHARS_PER_TOKEN);
  const growthSteps =
    safeMultiply(attemptsPerInitialCall, attemptsPerInitialCall - 1, "the prompt-growth bound") / 2;
  const promptTokensPerInitial = safeAdd(
    safeMultiply(attemptsPerInitialCall, basePromptTokens, "the base prompt bound"),
    safeMultiply(growthSteps, growthPromptTokens, "the grown prompt bound"),
    "the per-initial prompt bound",
  );
  const worstCasePromptTokens = safeMultiply(
    budget.initialCalls,
    promptTokensPerInitial,
    "the prompt-token bound",
  );
  const worstCaseCompletionTokens = safeMultiply(
    worstCaseCalls,
    completionTokensPerCall,
    "the completion-token bound",
  );
  const lastPromptChars = safeAdd(
    promptChars,
    safeMultiply(promptGrowth, Math.max(attemptsPerInitialCall - 1, 0), "the last prompt bound"),
    "the last prompt bound",
  );
  const price = priceFor(input.backend, input.model);
  const cost = priceTokens(price, worstCasePromptTokens, worstCaseCompletionTokens);
  if (!Number.isFinite(cost) || cost < 0) {
    throw new OperatorError(
      "the fixed-call spend estimate is not a finite non-negative amount " +
        "(fix: reduce the token budget)",
    );
  }

  return {
    backend: input.backend,
    model: input.model,
    price,
    budget,
    attemptsPerInitialCall,
    worstCaseCalls,
    promptTokensPerCall: worstCaseCalls === 0 ? 0 : Math.ceil(lastPromptChars / CHARS_PER_TOKEN),
    completionTokensPerCall,
    worstCasePromptTokens,
    worstCaseCompletionTokens,
    usd: cost,
  };
}

/** Render the dated price basis shared by fixed-call and eval displays. */
export function formatPriceResolution(price: PriceResolution, colors: Colors): string[] {
  const which =
    price.matched === "model"
      ? `${price.backend} — model ${price.model}, priced on its own dated row`
      : `${price.backend} — model ${price.model} has no dated row of its own, so the estimate ` +
        `fell back to ${price.rowName}`;
  const lines = [
    colors.dim(
      `  price: ${which}: USD ${price.promptUsdPerThousandTokens} per 1K ` +
        `prompt tokens, USD ${price.completionUsdPerThousandTokens} per 1K completion ` +
        `tokens (priced ${price.pricedOn}; ${price.source})`,
    ),
  ];
  if (price.assumption !== undefined) {
    lines.push(colors.dim(`  assumption: ${price.assumption}`));
  }
  return lines;
}

/** Render a fixed-call estimate with every multiplier visible to the operator. */
export function formatFixedCallSpend(estimate: FixedCallSpendEstimate, colors: Colors): string[] {
  const { budget } = estimate;
  const lines = [
    colors.yellow(
      `spend estimate: at most ${usd(estimate.usd)} for this operation — an upper bound, not a forecast.`,
    ),
    colors.dim(
      `  calls: at most ${groupDigits(estimate.worstCaseCalls)} — ` +
        `initial ${budget.initialCalls}, semantic repairs +${budget.semanticRepairs} ` +
        `(×${budget.semanticRepairs + 1}), transport retries +${budget.transportRetries} ` +
        `(×${budget.transportRetries + 1}), CLI shape attempts ×${budget.cliShapeAttempts}`,
    ),
    colors.dim(
      `  tokens: at most ${groupDigits(estimate.worstCasePromptTokens)} prompt ` +
        `(${groupDigits(estimate.promptTokensPerCall)} on the last attempt, including per-attempt ` +
        `growth) + ${groupDigits(estimate.worstCaseCompletionTokens)} completion ` +
        `(${groupDigits(estimate.completionTokensPerCall)} per call)`,
    ),
  ];
  lines.push(...formatPriceResolution(estimate.price, colors));
  return lines;
}

/**
 * The invocation-wide aggregate over per-case fixed-call estimates: every
 * case's own measured bound, summed. One command run prices one backend and
 * one model, so the dated price basis is shared; a caller that mixes them is
 * refused rather than silently priced at the first row.
 */
export interface FixedCallSpendTotal {
  /** The priced cases — those whose work contributed a bound. */
  readonly caseCount: number;
  /** The summed upper-bound dollars. */
  readonly usd: number;
  /** The summed worst-case transport calls. */
  readonly worstCaseCalls: number;
  /** The summed worst-case prompt tokens. */
  readonly worstCasePromptTokens: number;
  /** The summed worst-case completion tokens. */
  readonly worstCaseCompletionTokens: number;
  /** The completion cap every case priced its calls at. */
  readonly completionTokensPerCall: number;
  /** The per-case budget every estimate shared. */
  readonly budget: NormalizedFixedCallBudget;
  /** The shared dated price basis; absent when no case was priced. */
  readonly price?: PriceResolution;
}

/**
 * Sum per-case fixed-call estimates into one invocation-wide bound. The sum
 * is over every case's own measured prompt — never one corpus-sized call,
 * never every case at the largest — and a non-finite total is refused rather
 * than undercounted.
 */
export function sumFixedCallSpendEstimates(
  estimates: readonly FixedCallSpendEstimate[],
): FixedCallSpendTotal {
  const first = estimates[0];
  if (first === undefined) {
    return {
      caseCount: 0,
      usd: 0,
      worstCaseCalls: 0,
      worstCasePromptTokens: 0,
      worstCaseCompletionTokens: 0,
      completionTokensPerCall: 0,
      budget: {
        initialCalls: 0,
        semanticRepairs: 0,
        transportRetries: 0,
        cliShapeAttempts: 1,
      },
    };
  }
  const budgetJson = JSON.stringify(first.budget);
  let usd = first.usd;
  let worstCaseCalls = first.worstCaseCalls;
  let worstCasePromptTokens = first.worstCasePromptTokens;
  let worstCaseCompletionTokens = first.worstCaseCompletionTokens;
  for (const estimate of estimates.slice(1)) {
    if (estimate.backend !== first.backend || estimate.model !== first.model) {
      throw new OperatorError(
        `the per-case estimates mix backends or models (${first.backend}/${first.model} and ` +
          `${estimate.backend}/${estimate.model}) — one invocation prices one backend and one ` +
          "model (fix: run each backend's cases as its own command)",
      );
    }
    if (JSON.stringify(estimate.budget) !== budgetJson) {
      throw new OperatorError(
        "the per-case estimates mix call budgets — one invocation prices one call model " +
          "(fix: report the mixed budgets to the command's maintainer)",
      );
    }
    usd += estimate.usd;
    worstCaseCalls = safeAdd(worstCaseCalls, estimate.worstCaseCalls, "the summed call bound");
    worstCasePromptTokens = safeAdd(
      worstCasePromptTokens,
      estimate.worstCasePromptTokens,
      "the summed prompt bound",
    );
    worstCaseCompletionTokens = safeAdd(
      worstCaseCompletionTokens,
      estimate.worstCaseCompletionTokens,
      "the summed completion bound",
    );
  }
  if (!Number.isFinite(usd) || usd < 0) {
    throw new OperatorError(
      "the summed spend estimate is not a finite non-negative amount " +
        "(fix: reduce the per-case budgets)",
    );
  }
  return {
    caseCount: estimates.length,
    usd,
    worstCaseCalls,
    worstCasePromptTokens,
    worstCaseCompletionTokens,
    completionTokensPerCall: first.completionTokensPerCall,
    budget: first.budget,
    price: first.price,
  };
}

/** Render the per-case aggregate with its shared call model and price basis visible. */
export function formatFixedCallSpendTotal(total: FixedCallSpendTotal, colors: Colors): string[] {
  if (total.caseCount === 0) {
    return [
      colors.yellow(
        "spend estimate: USD 0 — every case has nothing to propose, so no model call is made.",
      ),
    ];
  }
  const { budget } = total;
  const lines = [
    colors.yellow(
      `spend estimate: at most ${usd(total.usd)} for this operation — an upper bound, not a forecast.`,
    ),
    colors.dim(
      `  cases: ${groupDigits(total.caseCount)} priced — one initial proposal call each, summed ` +
        "over each case's own measured prompt",
    ),
    colors.dim(
      `  calls: at most ${groupDigits(total.worstCaseCalls)} — per case initial ` +
        `${budget.initialCalls}, semantic repairs +${budget.semanticRepairs} ` +
        `(×${budget.semanticRepairs + 1}), transport retries +${budget.transportRetries} ` +
        `(×${budget.transportRetries + 1}), CLI shape attempts ×${budget.cliShapeAttempts}`,
    ),
    colors.dim(
      `  tokens: at most ${groupDigits(total.worstCasePromptTokens)} prompt + ` +
        `${groupDigits(total.worstCaseCompletionTokens)} completion ` +
        `(${groupDigits(total.completionTokensPerCall)} per call)`,
    ),
  ];
  if (total.price !== undefined) lines.push(...formatPriceResolution(total.price, colors));
  return lines;
}

/** How an operator confirms an otherwise-refused spend. */
export interface SpendConfirmation {
  readonly ask: (question: string) => Promise<boolean>;
}

/** The shared ceiling input; any estimate with a dollar bound can use it. */
export interface OperatorSpendCeilingInput {
  readonly estimate: { readonly usd: number };
  readonly maxSpendUsd: number;
  readonly yes: boolean;
  readonly confirmation?: SpendConfirmation;
  /**
   * A second fix named in the refusal, for a command that can shrink the priced
   * work (schema init names `--draft-from`); absent keeps the message unchanged.
   */
  readonly cheaperFix?: string;
}

const refusalMessage = (
  estimateUsd: number,
  maxSpendUsd: number,
  cheaperFix: string | undefined,
): string =>
  `the estimated spend (${usd(estimateUsd)}) is above the ceiling ` +
  `(${usd(maxSpendUsd)}) — the run was refused before any model call (fix: raise the ` +
  `ceiling with --max-spend ${(estimateUsd * 1.1).toFixed(2)}` +
  `${cheaperFix === undefined ? "" : `, ${cheaperFix}`}, or confirm the run with --yes)`;

/** Enforce the ceiling before the caller's first model call. */
export async function enforceOperatorSpendCeiling(input: OperatorSpendCeilingInput): Promise<void> {
  const { estimate, maxSpendUsd, yes, confirmation } = input;
  if (!Number.isFinite(estimate.usd) || estimate.usd < 0) {
    throw new OperatorError(
      "the estimated spend must be a finite non-negative amount — no ceiling decision can be made",
    );
  }
  if (!Number.isFinite(maxSpendUsd) || maxSpendUsd < 0) {
    throw new OperatorError("maxSpendUsd must be a finite non-negative amount");
  }
  if (estimate.usd <= maxSpendUsd || yes) return;

  if (confirmation !== undefined) {
    const question =
      `the estimated spend (${usd(estimate.usd)}) is above the ceiling ` +
      `(${usd(maxSpendUsd)}) — continue? [y/N] `;
    if (await confirmation.ask(question)) return;
  }

  throw new OperatorError(refusalMessage(estimate.usd, maxSpendUsd, input.cheaperFix));
}
