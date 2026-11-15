/**
 * @file The test support the scorer's suites drive: the envelope a run's
 * fields carry, and the shapes a result takes.
 *
 * The envelope is the shape core's own extraction produces — `{ value,
 * confidence, sourceSpan }` — so a hand-written result is the same shape a
 * real run's is, and the scorer is exercised over the data it will actually
 * read.
 */
import type { EvalCaseResult, EvalJsonValue } from "../types.js";

/**
 * The envelope around one produced value.
 * @param value - The value the run produced.
 * @returns The envelope.
 * @category Eval
 */
export function envelope(value: EvalJsonValue): EvalJsonValue {
  return { value, confidence: 0.9, sourceSpan: "span" };
}

/**
 * A result for a case that extracted.
 * @param caseId - The case's id.
 * @param fields - The extraction's fields.
 * @returns The result.
 * @category Eval
 */
export function extracted(caseId: string, fields: EvalJsonValue): EvalCaseResult {
  return { caseId, status: "extracted", fields };
}

/**
 * A result for a case that failed.
 * @param caseId - The case's id.
 * @param error - The failure's message.
 * @returns The result.
 * @category Eval
 */
export function failed(caseId: string, error: string): EvalCaseResult {
  return { caseId, status: "failed", error };
}
