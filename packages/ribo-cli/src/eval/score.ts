/**
 * @file The scorer: one run against one corpus, judged leaf by leaf.
 *
 * The public entry and the internal entry share one implementation — the
 * pattern the runner sets. The public
 * entry takes a loaded corpus: the corpus enters the package only through
 * `loadCorpus`, so a run can never be scored against a corpus that was not
 * validated. The internal entry takes the schema, the cases and the results
 * directly, so a test can score the same run against a schema that never went
 * through the loader.
 *
 * The scorer is pure and synchronous: no I/O, no clock, no randomness, no
 * transport. The same inputs produce the same output, and the output is
 * plain JSON-able data, so a record can persist it verbatim.
 *
 * The leaf set is the one field inventory reports (`walkFieldInventory`), and
 * the expectation precedence is the corpus's own rule (`resolveExpectation`).
 * Neither is reimplemented here: a second walk or a second precedence rule
 * would be a second answer to a question the codebase already answers once.
 */
import type { LeafInventoryEntry } from "@azx/ribo-core";
import type { z } from "zod";

import type { CorpusCase, LoadedCorpus } from "../corpus.js";
import { resolveExpectation } from "../corpus.js";
import { walkFieldInventory } from "../inspect/field-inventory.js";
import { EvalError } from "./error.js";
import { judgeLeaf } from "./score-cell.js";
import { readProducedLeaf } from "./score-fields.js";
import { computeTotals } from "./score-totals.js";
import type { EvalCell, EvalScore, ScoredCase } from "./score-types.js";
import type { EvalCaseResult } from "./types.js";

/**
 * One case as the scorer reads it: its id, its expected answers and its
 * scoped defaults.
 *
 * The corpus's own loader hands over exactly this much of a case, and no
 * more: the scorer reads a case's expectations, never its input.
 * @category Eval
 */
export interface ScoreCase {
  /** The case's id. */
  readonly id: string;
  /** The expected answer, as the case file declares it. */
  readonly expected: CorpusCase["expected"];
  /** The scoped defaults, as the case file declares them. */
  readonly defaults: CorpusCase["defaults"];
}

/**
 * A score driven from a schema, a set of cases and a set of results — the
 * internal seam the round-trip test drives both sides of.
 * @category Eval
 */
export interface EvalSchemaScore {
  /** The corpus's schema. */
  readonly schema: z.ZodObject;
  /** The cases to score, in order. */
  readonly cases: readonly ScoreCase[];
  /** The run's results, one per case. */
  readonly results: readonly EvalCaseResult[];
}

/**
 * Index the run's results by case id, refusing a malformed pairing.
 *
 * A well-formed caller — the runner — never produces these; a hand-assembled
 * one gets a loud refusal rather than a partially-scored run that misreports.
 * @param cases - The cases to score.
 * @param results - The run's results.
 * @returns The results, by case id.
 * @throws {@link EvalError} when a result names no case, a case has no result, or a case id repeats.
 */
const indexResults = (
  cases: readonly ScoreCase[],
  results: readonly EvalCaseResult[],
): Map<string, EvalCaseResult> => {
  const byCase = new Map<string, EvalCaseResult>();
  for (const result of results) {
    if (byCase.has(result.caseId)) {
      throw new EvalError(
        `eval: the run's results name the case "${result.caseId}" twice — a run produces one ` +
          "result per case (fix: score the run's own results, not a hand-assembled list)",
      );
    }
    byCase.set(result.caseId, result);
  }
  const caseIds = new Set(cases.map((entry) => entry.id));
  for (const result of results) {
    if (caseIds.has(result.caseId)) continue;
    throw new EvalError(
      `eval: the run's results name the case "${result.caseId}", which is no case of the corpus — ` +
        `the corpus's cases are: ${[...caseIds].join(", ")} (fix: score the run's own results)`,
    );
  }
  for (const entry of cases) {
    if (byCase.has(entry.id)) continue;
    throw new EvalError(
      `eval: the corpus's case "${entry.id}" has no result in the run — a run produces one result ` +
        "per case (fix: score a run that covered every case)",
    );
  }
  return byCase;
};

/**
 * Is this corpus proposal-bearing? Any explicit entry carrying a `proposal`
 * makes it one, and only a proposal-bearing corpus's cells carry the `review`
 * member (D10): the member is provenance ABOUT proposals, so a corpus that
 * holds none writes none, keeping every existing record byte-identical.
 * @param cases - The cases to score.
 * @returns Whether any case carries a proposal-bearing entry.
 */
const isProposalBearing = (cases: readonly ScoreCase[]): boolean =>
  cases.some((entry) => Object.values(entry.expected).some((leaf) => leaf.proposal !== undefined));

/**
 * Score one case: every leaf of the schema, judged.
 * @param entry - The case to score.
 * @param result - The run's result for that case.
 * @param inventory - The schema's leaf inventory.
 * @param withReview - Whether the corpus is proposal-bearing.
 * @returns The scored case.
 */
const scoreCase = (
  entry: ScoreCase,
  result: EvalCaseResult,
  inventory: readonly LeafInventoryEntry[],
  withReview: boolean,
): ScoredCase => {
  const fields = result.status === "failed" ? undefined : result.fields;
  const cells: Record<string, EvalCell> = {};
  for (const leaf of inventory) {
    const expectation = resolveExpectation(
      { expected: entry.expected, defaults: entry.defaults },
      leaf.path,
    );
    const produced = readProducedLeaf(fields, leaf.path, leaf.inArray);
    cells[leaf.path] = judgeLeaf({
      leaf,
      expectation,
      produced: produced.values,
      caseFailed: result.status === "failed",
      withReview,
    });
  }
  return {
    caseId: entry.id,
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
    cells,
  };
};

/**
 * Score a run against a set of cases, over a leaf inventory.
 * @param inventory - The schema's leaf inventory.
 * @param cases - The cases to score, in order.
 * @param results - The run's results.
 * @returns The score.
 * @throws {@link EvalError} when the results do not pair with the cases.
 */
const scoreWithInventory = (
  inventory: readonly LeafInventoryEntry[],
  cases: readonly ScoreCase[],
  results: readonly EvalCaseResult[],
): EvalScore => {
  const byCase = indexResults(cases, results);
  const withReview = isProposalBearing(cases);
  const scored = cases.map((entry) => {
    const result = byCase.get(entry.id);
    if (result === undefined) {
      // `indexResults` refuses a case with no result, so this cannot happen.
      throw new EvalError(`eval: the corpus's case "${entry.id}" has no result in the run`);
    }
    return scoreCase(entry, result, inventory, withReview);
  });
  return {
    leafPaths: inventory.map((entry) => entry.path),
    cases: scored,
    totals: computeTotals(scored),
  };
};

/**
 * Score a run against a schema and a set of cases.
 *
 * This is the internal seam: it takes a schema, so a test can score the same
 * run against a directly-built schema as against a loader-round-tripped one.
 * The public entry is the corpus-shaped one; this one is not exported from
 * the barrel.
 * @param score - The schema, the cases and the run's results.
 * @returns The score.
 * @throws {@link EvalError} when the results do not pair with the cases.
 * @category Eval
 */
export function scoreEvalOverSchema(score: EvalSchemaScore): EvalScore {
  return scoreWithInventory(walkFieldInventory(score.schema), score.cases, score.results);
}

/**
 * Score a run against a loaded corpus.
 *
 * The corpus enters here and nowhere else: the scorer reads no corpus files
 * itself and accepts no other corpus representation.
 *
 * A failed case is judged over every leaf and earns no credit for silence:
 * every asserted leaf is `missed`, and every declared-absent leaf is
 * `missed` too — a failure said nothing, so its silence is not a chosen
 * abstention. The cells stay judged, so a run that produced nothing scores
 * zero over all rather than reading as accurate, and its answer rate is
 * visibly zero rather than quietly absent.
 * @param corpus - The loaded corpus, from `loadCorpus`.
 * @param results - The run's results, one per case.
 * @returns The score.
 * @throws {@link EvalError} when the results do not pair with the corpus's cases.
 * @category Eval
 */
export function scoreEvalRun(corpus: LoadedCorpus, results: readonly EvalCaseResult[]): EvalScore {
  return scoreWithInventory(
    corpus.leafInventory,
    corpus.cases.map((entry) => ({
      id: entry.id,
      expected: entry.expected,
      defaults: entry.defaults,
    })),
    results,
  );
}
