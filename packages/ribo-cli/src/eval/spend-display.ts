/**
 * @file How the estimate is shown: the lines the operator reads before the
 * run spends anything.
 *
 * The estimate is an UPPER BOUND, and it says so on its face: a number a
 * reader takes for a forecast is a number they will be surprised by. The lines
 * state the basis — the per-rung call counts the call model reported, the
 * retry and consensus multipliers and their values, the case count, the
 * per-call token bound, and the price row with the day it was priced — so a
 * reader can check the arithmetic rather than trust it.
 *
 * The colour comes from the package's one colour wiring (`colorsFor`), so a
 * piped run carries no escape bytes and a terminal run reads the same as every
 * other diagnostic in this package.
 */
import type { Colors } from "../colors.js";
import {
  DEFAULT_COMPLETION_TOKENS,
  formatPriceResolution,
  groupDigits,
  usd,
} from "../operator/spend.js";
import type { SpendEstimate } from "./spend-guard.js";

export { usd } from "../operator/spend.js";

/**
 * One arm's call line: the ladder, the rung counts and the multipliers.
 */
const armCallLine = (estimate: SpendEstimate, index: number): string => {
  const arm = estimate.arms[index];
  if (arm === undefined) return "";
  const rungs = arm.rungs.map((rung) => `${rung.strategy} ${rung.calls}`).join(", ");
  // The multiplier is the sum it came from, named by the flag that sets it —
  // the reader should not have to discover the control to change the number.
  const multipliers =
    `retries ×${arm.retryMultiplier} (1 + --max-retries ${arm.retryMultiplier - 1}), ` +
    `consensus ×${arm.consensusCandidates}`;
  return (
    `arm ${index + 1} (${arm.strategies.join(" → ")}): ${arm.callsPerCase} per case ` +
    `(${rungs}; ${multipliers})`
  );
};

/**
 * The estimate's lines, ready to write to stderr.
 *
 * Every line is a plain string: the caller owns the prefix and the stream, so
 * the same rendering serves a terminal and a pipe.
 * @param estimate - The estimate to render.
 * @param colors - The package's colour wiring.
 * @returns The lines, in order.
 */
export function formatSpendEstimate(estimate: SpendEstimate, colors: Colors): string[] {
  const lines: string[] = [];
  lines.push(
    colors.yellow(
      `spend estimate: at most ${usd(estimate.usd)} for this run — an upper bound, not a forecast.`,
    ),
  );

  const arms = estimate.arms.map((_arm, index) => armCallLine(estimate, index));
  lines.push(
    colors.dim(
      `  calls: at most ${groupDigits(estimate.worstCaseCalls)} over ` +
        `${groupDigits(estimate.caseCount)} case(s) — ${arms.join("; ")}`,
    ),
  );

  const promptPerCall = Math.max(...estimate.arms.map((arm) => arm.promptTokensPerCall), 0);
  const completionPerCall = Math.max(...estimate.arms.map((arm) => arm.completionTokensPerCall), 0);
  const capped = estimate.arms.some(
    (arm) => arm.completionTokensPerCall !== DEFAULT_COMPLETION_TOKENS,
  );
  lines.push(
    colors.dim(
      `  tokens: at most ${groupDigits(estimate.worstCasePromptTokens)} prompt ` +
        `(${groupDigits(promptPerCall)} per call, measured from the run's prompts) + ` +
        `${groupDigits(estimate.worstCaseCompletionTokens)} completion ` +
        `(${groupDigits(completionPerCall)} per call, ` +
        `${capped ? "the run's response cap" : "the response-cap default"})`,
    ),
  );

  lines.push(...formatPriceResolution(estimate.price, colors));
  return lines;
}
