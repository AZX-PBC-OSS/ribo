/**
 * @file The run's totals: the cell counts and the rates.
 *
 * The rates answer different questions, and each of them reads as a
 * contradiction when another is missing — so they are computed together and
 * always travel together:
 *
 * - the answer rate — of the judged cells, the fraction where the run produced
 *   a value at all: coverage;
 * - the accuracy over answered — of the cells where the run produced a value,
 *   the fraction that were correct: the quality of what was said;
 * - the accuracy over all — of the judged cells, the fraction that were
 *   correct: the quality of the whole run.
 *
 * A rate is null when its denominator is zero. Never NaN, never absent.
 */
import type { EvalCell, EvalScoreTotals, ScoredCase } from "./score-types.js";

/**
 * A rate, or null when its denominator is zero.
 * @param numerator - The numerator.
 * @param denominator - The denominator.
 * @returns The rate, or null when there is nothing to divide.
 */
const rate = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

/**
 * Does the cell count as answered — did the run produce a value for it?
 *
 * A correct cell on a declared-absent leaf is correct and unanswered: the
 * case said nothing happened, and nothing did.
 * @param cell - The cell.
 * @returns Whether the run produced a value.
 */
const isAnswered = (cell: EvalCell): boolean => cell.got !== null;

/**
 * Count the run's cells and compute its rates.
 * @param cases - The scored cases.
 * @returns The run's totals.
 * @category Eval
 */
export function computeTotals(cases: readonly ScoredCase[]): EvalScoreTotals {
  let correct = 0;
  let wrong = 0;
  let missed = 0;
  let hallucinated = 0;
  let unscorable = 0;
  let answered = 0;
  let correctAnswered = 0;
  for (const entry of cases) {
    for (const cell of Object.values(entry.cells)) {
      if (cell.verdict === "correct") correct += 1;
      else if (cell.verdict === "wrong") wrong += 1;
      else if (cell.verdict === "missed") missed += 1;
      else if (cell.verdict === "hallucinated") hallucinated += 1;
      else unscorable += 1;
      if (cell.verdict === "unscorable" || !isAnswered(cell)) continue;
      answered += 1;
      // The accuracy over what was said counts the correct cells AMONG the
      // answered ones: a correct cell that abstained (a declared-absent leaf
      // the run left alone) is correct, but it was never said.
      if (cell.verdict === "correct") correctAnswered += 1;
    }
  }
  const judged = correct + wrong + missed + hallucinated;
  return {
    cases: cases.length,
    correct,
    wrong,
    missed,
    hallucinated,
    unscorable,
    judged,
    answered,
    answerRate: rate(answered, judged),
    accuracyOverAnswered: rate(correctAnswered, answered),
    accuracyOverAll: rate(correct, judged),
  };
}
