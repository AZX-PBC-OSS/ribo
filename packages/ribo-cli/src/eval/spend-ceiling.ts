/**
 * @file The ceiling: what the operator allows, and what happens when the
 * estimate is over it.
 *
 * The ceiling is a plain dollar amount — `--max-spend <usd>` — and the default
 * is the guard's own constant. Over the ceiling, the run is REFUSED with the
 * could-not-run exit code, before any model call, unless the operator
 * overrides it: `--yes` on the command line, or a confirmation on a terminal.
 *
 * Two refusals live here, and they are not the same refusal:
 *
 * - a run whose ESTIMATE is over the ceiling is a spend the operator has not
 *   allowed, and the operator may allow it after seeing the number;
 * - a run whose bound could not be derived at all is refused where the
 *   estimate is computed (the spend guard module), because no flag conjures an
 *   honest bound and a confirmation would only confirm a number nobody can
 *   check.
 *
 * The confirmation is offered only when the operator can actually answer it:
 * both the input and the output must be terminals, or the question would be
 * swallowed by a pipe while the command waited for an answer nobody can give.
 */
import { EvalError } from "./error.js";
import { usd } from "./spend-display.js";
import type { SpendEstimate } from "./spend-guard.js";

/**
 * How the operator is asked whether an over-ceiling run may proceed.
 */
export interface SpendConfirmation {
  /**
   * Ask the question and resolve whether the operator agreed.
   *
   * The question is written to the operator's terminal; the answer comes
   * back as "yes" or "no".
   */
  readonly ask: (question: string) => Promise<boolean>;
}

/**
 * What the ceiling check needs.
 */
export interface SpendCeilingInput {
  /** The estimate the run was priced at. */
  readonly estimate: SpendEstimate;
  /** The ceiling, in US dollars. */
  readonly maxSpendUsd: number;
  /** Whether the operator passed the override flag. */
  readonly yes: boolean;
  /** How to ask the operator, when they can be asked. */
  readonly confirmation?: SpendConfirmation;
}

/**
 * The refusal's message: the estimate, the ceiling and the way through.
 */
const refusalMessage = (estimate: SpendEstimate, maxSpendUsd: number): string =>
  `the estimated spend (${usd(estimate.usd)}) is above the ceiling ` +
  `(${usd(maxSpendUsd)}) — the run was refused before any model call (fix: raise the ` +
  `ceiling with --max-spend ${(estimate.usd * 1.1).toFixed(2)}, or confirm the run with --yes)`;

/**
 * Apply the ceiling to an estimate.
 *
 * Under the ceiling the run proceeds, with no question asked. Over it, the
 * run proceeds only when the operator says so — through the flag or through a
 * confirmation — and is refused otherwise.
 * @param input - The estimate, the ceiling, the override flag and the confirmation.
 * @returns Nothing; the promise settles when the run may (or may not) proceed.
 * @throws {@link EvalError} when the run is over the ceiling and was not allowed.
 */
export async function enforceSpendCeiling(input: SpendCeilingInput): Promise<void> {
  const { estimate, maxSpendUsd, yes, confirmation } = input;
  if (estimate.usd <= maxSpendUsd) return;
  if (yes) return;

  if (confirmation !== undefined) {
    const question =
      `the estimated spend (${usd(estimate.usd)}) is above the ceiling ` +
      `(${usd(maxSpendUsd)}) — continue? [y/N] `;
    if (await confirmation.ask(question)) return;
  }

  throw new EvalError(refusalMessage(estimate, maxSpendUsd));
}
