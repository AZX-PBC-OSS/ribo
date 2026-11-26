/**
 * @file Eval's ceiling adapter. The decision, confirmation question and legacy
 * diagnostic live in the shared operator layer; this wrapper retains EvalError.
 */
import { OperatorError } from "../operator/error.js";
import { enforceOperatorSpendCeiling } from "../operator/spend.js";
import type { SpendConfirmation as OperatorSpendConfirmation } from "../operator/spend.js";
import { EvalError } from "./error.js";
import type { SpendEstimate } from "./spend-guard.js";

/** How the operator is asked whether an over-ceiling run may proceed. */
export type SpendConfirmation = OperatorSpendConfirmation;

/** What eval's ceiling check needs. */
export interface SpendCeilingInput {
  readonly estimate: SpendEstimate;
  readonly maxSpendUsd: number;
  readonly yes: boolean;
  readonly confirmation?: SpendConfirmation;
}

/**
 * Apply the shared ceiling and translate its refusal to eval's fault class.
 * The message and terminal-confirmation behavior are unchanged.
 */
export async function enforceSpendCeiling(input: SpendCeilingInput): Promise<void> {
  try {
    await enforceOperatorSpendCeiling(input);
  } catch (error) {
    if (error instanceof OperatorError) throw new EvalError(error.message);
    throw error;
  }
}
