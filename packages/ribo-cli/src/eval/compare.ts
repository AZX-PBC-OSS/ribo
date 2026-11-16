/**
 * @file The comparison: two run records, one report — the computation behind
 * `ribo compare` and behind `ribo eval`'s cross-arm summary.
 *
 * The function is PURE: it reads the two drafts it is given and nothing else
 * — no file, no corpus, no schema, no re-walk of the field inventory. The
 * leaf sets come from each record's persisted `leafPaths`, which the scorer
 * computed through the one inventory walk at record time; comparing records
 * means comparing what they measured, not re-deriving it.
 *
 * Three refusals, all the could-not-run class, and everything else is a
 * finding: a corpus-fingerprint mismatch without the explicit override, an
 * empty leaf intersection, and — reachable only under the override — an
 * empty case intersection. A difference in any of the four identity fields
 * is never a refusal: it is an axis, the reader's first question.
 */
import { canonicalJson, jsonValue } from "../inspect/fingerprint.js";
import { EvalError } from "./error.js";
import {
  EVAL_COMPARE_CONTRACT_VERSION,
  type EvalCompareAxis,
  type EvalCompareReport,
} from "./compare-report.js";
import type { EvalRunRecordCell, EvalRunRecordDraft } from "./record-schema.js";

/**
 * What a comparison is computed with.
 * @category Eval
 */
export interface EvalCompareOptions {
  /**
   * Allow comparing records whose corpus fingerprints differ, and record
   * the override in the report. The override is recorded whenever it is
   * passed — even when the fingerprints turned out to match — because it
   * records what the caller asserted, not what was true.
   */
  readonly allowCorpusMismatch?: boolean;
}

/**
 * Settings equality, under the package's ONE canonicaliser: a settings
 * object is compared as one JSON value, so key order and whitespace never
 * move the comparison and any option's change does.
 */
const sameSettings = (left: EvalRunRecordDraft, right: EvalRunRecordDraft): boolean =>
  canonicalJson(jsonValue(left.settings)) === canonicalJson(jsonValue(right.settings));

/**
 * The case ids a record's grid carries, in the grid's own order.
 *
 * The builder writes a dense grid — every leaf's row in the corpus's case
 * order — so the union over the rows reads in that order; the union is for a
 * record whose rows disagree, which the comparison then treats as the
 * record's own case set rather than guessing one row's.
 * @param grid - The record's leaf-major grid.
 * @returns The case ids, in first-seen order.
 */
const caseIdsOf = (grid: EvalRunRecordDraft["grid"]): string[] => {
  const ids = new Set<string>();
  for (const row of Object.values(grid)) {
    for (const id of Object.keys(row)) ids.add(id);
  }
  return [...ids];
};

/**
 * The report's side block for one record: what the record says about itself,
 * beside what the intersection dropped.
 * @param draft - The record.
 * @param excludedLeaves - The record's leaves the intersection dropped.
 * @param excludedCases - The record's cases the intersection dropped.
 * @returns The side block.
 */
const sideOf = (
  draft: EvalRunRecordDraft,
  excludedLeaves: number,
  excludedCases: number,
): EvalCompareReport["left"] => ({
  corpus: { name: draft.corpus.name, fingerprint: draft.corpus.fingerprint },
  identity: {
    backend: draft.backend,
    model: draft.model,
    settings: draft.settings,
    fingerprint: draft.fingerprint,
  },
  totals: draft.totals,
  excludedLeaves,
  excludedCases,
});

/**
 * Compare two run records and produce the full report.
 *
 * The input is the draft shape, so both a persisted record and the eval
 * command's in-memory per-arm draft satisfy it — compare renders records,
 * and never re-reads a corpus, a schema or an extraction.
 * @param left - The left record: the baseline the intersection is ordered by.
 * @param right - The right record.
 * @param options - The comparison's options: the corpus override, and nothing else.
 * @returns The comparison report.
 * @throws {@link EvalError} when the corpora differ without the override, when the records share no leaf, or — under the override — when they share no case.
 * @category Eval
 */
export function compareEvalRunRecords(
  left: EvalRunRecordDraft,
  right: EvalRunRecordDraft,
  options: EvalCompareOptions = {},
): EvalCompareReport {
  if (
    left.corpus.fingerprint !== right.corpus.fingerprint &&
    options.allowCorpusMismatch !== true
  ) {
    throw new EvalError(
      `eval: the two records come from different corpora — the corpus fingerprints ` +
        `${left.corpus.fingerprint} and ${right.corpus.fingerprint} differ, and a comparison that ` +
        "silently lined up two corpora it could not prove were the same would report differences " +
        "that mean nothing (fix: pass --allow-corpus-mismatch to compare records from different " +
        "corpora)",
    );
  }
  const axes: EvalCompareAxis[] = [];
  if (left.backend !== right.backend) axes.push("backend");
  if (left.model !== right.model) axes.push("model");
  if (!sameSettings(left, right)) axes.push("settings");
  if (left.fingerprint !== right.fingerprint) axes.push("fingerprint");

  // The leaf sets are the persisted inventories — never a fresh walk.
  const rightLeaves = new Set(right.leafPaths);
  const leafPaths = left.leafPaths.filter((leafPath) => rightLeaves.has(leafPath));
  const leftCaseIds = caseIdsOf(left.grid);
  const rightCaseIds = new Set(caseIdsOf(right.grid));
  const caseIds = leftCaseIds.filter((caseId) => rightCaseIds.has(caseId));

  if (leafPaths.length === 0) {
    throw new EvalError(
      `eval: the two records share no leaf — the left record carries ${left.leafPaths.length} ` +
        `leaf(s) and the right ${right.leafPaths.length}, with none in common, so there is nothing ` +
        "to line up and an empty comparison dressed as a result would hide it (fix: compare " +
        "records taken over the same schema, or pass --allow-corpus-mismatch when the corpora " +
        "genuinely differ)",
    );
  }
  if (caseIds.length === 0) {
    throw new EvalError(
      `eval: the two records share no case — the left record carries ${leftCaseIds.length} ` +
        `case(s) and the right ${rightCaseIds.size}, with none in common, so there is nothing to ` +
        "line up and an empty comparison dressed as a result would hide it (fix: compare records " +
        "taken over the same corpus, or drop the --allow-corpus-mismatch override when the " +
        "corpora do match)",
    );
  }
  const caseSet = new Set(caseIds);
  for (const leafPath of leafPaths) {
    if (left.grid[leafPath] === undefined || right.grid[leafPath] === undefined) {
      throw new EvalError(
        `eval: the leaf "${leafPath}" is in a record's leaf paths but has no grid row — a record ` +
          "whose grid disagrees with its own leaf list would compare as nothing rather than as " +
          "the fault it is (fix: repair or re-run the record)",
      );
    }
  }
  const differences: EvalCompareReport["differences"] = [];
  for (const leafPath of leafPaths) {
    const leftRow = left.grid[leafPath]!;
    const rightRow = right.grid[leafPath]!;
    // The left record's own case order decides the entry order, per leaf.
    for (const [caseId, leftCell] of Object.entries(leftRow)) {
      if (!caseSet.has(caseId)) continue;
      const rightCell = rightRow[caseId];
      if (rightCell === undefined) {
        throw new EvalError(
          `eval: the case "${caseId}" has a cell for the leaf "${leafPath}" in the left record ` +
            "but none in the right — a record whose grid disagrees with its own case set would " +
            "compare as nothing rather than as the fault it is (fix: repair or re-run the record)",
        );
      }
      if (verdictsDiffer(leftCell, rightCell)) {
        differences.push({ leafPath, caseId, left: leftCell, right: rightCell });
      }
    }
  }
  return {
    contractVersion: EVAL_COMPARE_CONTRACT_VERSION,
    corpusOverride: options.allowCorpusMismatch === true,
    axes,
    leafPaths,
    differences,
    left: sideOf(
      left,
      left.leafPaths.length - leafPaths.length,
      leftCaseIds.length - caseIds.length,
    ),
    right: sideOf(
      right,
      right.leafPaths.length - leafPaths.length,
      rightCaseIds.size - caseIds.length,
    ),
  };
}

/**
 * Do two cells disagree at the granularity the eval measures?
 *
 * The verdict is the scorer's own judgement vocabulary — two `correct` cells
 * with different phrasing agree — so the verdict is the entry rule, and each
 * side's full cell travels with the difference for the values behind it.
 * @param left - The left cell.
 * @param right - The right cell.
 * @returns Whether the verdicts differ.
 */
const verdictsDiffer = (left: EvalRunRecordCell, right: EvalRunRecordCell): boolean =>
  left.verdict !== right.verdict;
