/**
 * @file What a corpus holds that a run can judge, counted once.
 *
 * The refusal and the partial-review line in `ribo eval` read the same
 * predicate — a leaf is judgeable when its resolved expectation is neither
 * unmentioned nor a pending proposal — so a caller can never refuse on one
 * definition and report on another. The precedence and review
 * classification are `resolveExpectation`'s own, never re-implemented here.
 */
import type { LoadedCorpus } from "../corpus.js";
import { resolveExpectation } from "../corpus.js";

/**
 * The judged-and-pending counts over a corpus's cases, leaf by leaf.
 * @category Eval
 */
export interface ReviewCoverage {
  /** The corpus's cases, all of them. */
  readonly cases: number;
  /** The cases holding at least one judgeable expectation. */
  readonly judgeableCases: number;
  /** The cases holding no judgeable expectation at all. */
  readonly unjudgeableCases: number;
  /** The pending proposal cells, across every case. */
  readonly pendingCells: number;
}

/**
 * Count what a corpus holds that a run can judge.
 * @param corpus - The loaded corpus, from `loadCorpus`.
 * @returns The coverage counts.
 * @category Eval
 */
export function reviewCoverage(corpus: LoadedCorpus): ReviewCoverage {
  let judgeableCases = 0;
  let pendingCells = 0;
  for (const entry of corpus.cases) {
    let judgeable = false;
    for (const leaf of corpus.leafInventory) {
      const expectation = resolveExpectation(
        { expected: entry.expected, defaults: entry.defaults },
        leaf.path,
      );
      if (
        expectation.status !== "unmentioned" &&
        expectation.origin === "explicit" &&
        expectation.reviewClass === "pending"
      ) {
        pendingCells += 1;
        continue;
      }
      if (expectation.status !== "unmentioned") judgeable = true;
    }
    if (judgeable) judgeableCases += 1;
  }
  return {
    cases: corpus.cases.length,
    judgeableCases,
    unjudgeableCases: corpus.cases.length - judgeableCases,
    pendingCells,
  };
}
