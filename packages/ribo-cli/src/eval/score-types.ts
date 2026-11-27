/**
 * @file The scorer's vocabulary and its data shapes: the verdict vocabulary,
 * the reasons a cell is unscorable, and the score the scorer returns.
 *
 * The verdict vocabulary is a runtime constant, not a type alone, so a
 * consumer — the records ticket's persisted schema — can parse a cell against
 * the same list the scorer wrote, the pattern the old Snugg record's
 * `CELL_VERDICTS` set.
 *
 * Everything here is plain JSON-able data — string verdicts, numbers, nulls,
 * plain objects and arrays. A record persists the score verbatim, so nothing
 * in it may be a class, a date or a function.
 */
import type { EvalJsonValue } from "./types.js";

/**
 * The verdicts a cell can carry.
 *
 * `unscorable` covers what the ticket's own wording leaves out: a leaf the
 * corpus says nothing about, and a leaf whose expectation cannot be compared
 * to what the schema allows, are neither right nor wrong.
 * @category Eval
 */
export const EVAL_VERDICTS = ["correct", "wrong", "missed", "hallucinated", "unscorable"] as const;

/**
 * One verdict.
 * @category Eval
 */
export type EvalVerdict = (typeof EVAL_VERDICTS)[number];

/**
 * The reasons a cell is unscorable.
 *
 * `unmentioned` is the design's own word for a leaf the corpus says nothing
 * about; `incomparable-expectation` names the case where the corpus expects
 * a value the schema cannot hold; `unreviewed-proposal` names a pending
 * proposal — an unreviewed model answer is never a measurement (R5).
 * @category Eval
 */
export const EVAL_UNSCORABLE_REASONS = [
  "unmentioned",
  "incomparable-expectation",
  "unreviewed-proposal",
] as const;

/**
 * Why a cell is unscorable.
 * @category Eval
 */
export type EvalUnscorableReason = (typeof EVAL_UNSCORABLE_REASONS)[number];

/**
 * Where a cell's expectation came from: an explicit entry, a covering
 * default, or nothing at all.
 *
 * A blanket statement and a per-leaf statement are different claims about the
 * same leaf, and a reader of a record is owed the difference.
 * @category Eval
 */
export type EvalCellOrigin = "explicit" | "default" | "none";

/**
 * One scored cell: one leaf of one case.
 *
 * The cell carries what it judged — the verdict — beside what it judged it
 * from: the expectation, the value the run produced, the corpus's own source
 * span (carried, never scored) and where the expectation came from.
 * @category Eval
 */
export interface EvalCell {
  /** The verdict the cell carries. */
  readonly verdict: EvalVerdict;
  /** The expectation's value as JSON, or null when the corpus declared absence or said nothing. */
  readonly expected: EvalJsonValue | null;
  /** The value the run produced as JSON, or null when the run produced nothing. */
  readonly got: EvalJsonValue | null;
  /** The corpus's verbatim span, when it recorded one. Carried, never scored. */
  readonly sourceSpan?: string;
  /** Where the expectation came from. */
  readonly origin: EvalCellOrigin;
  /** Why the cell is unscorable. Present exactly when the verdict is `unscorable`. */
  readonly reason?: EvalUnscorableReason;
}

/**
 * One scored case: every leaf of the corpus's schema, judged.
 *
 * The cell map is dense: a case that said nothing about a leaf still has a
 * cell for it, so a record's grid never has a hole to explain.
 * @category Eval
 */
export interface ScoredCase {
  /** The case's id. */
  readonly caseId: string;
  /** Whether the run extracted the case or failed on it. */
  readonly status: "extracted" | "failed";
  /** The failure's message, on a failed case. */
  readonly error?: string;
  /** One cell per leaf path, dense. */
  readonly cells: Readonly<Record<string, EvalCell>>;
}

/**
 * The run-level totals: the cell counts and the rates.
 *
 * The rates are always present together — answer rate, accuracy over answered
 * and accuracy over all — because each of them reads as a contradiction when
 * another is missing. Each is null when its denominator is zero: never NaN,
 * never absent.
 * @category Eval
 */
export interface EvalScoreTotals {
  /** The number of scored cases. */
  readonly cases: number;
  /** The cells judged correct. */
  readonly correct: number;
  /** The cells judged wrong. */
  readonly wrong: number;
  /** The cells judged missed. */
  readonly missed: number;
  /** The cells judged hallucinated. */
  readonly hallucinated: number;
  /** The cells that could not be judged. */
  readonly unscorable: number;
  /** The judged cells — every cell that is not unscorable. */
  readonly judged: number;
  /** The judged cells where the run produced a value. */
  readonly answered: number;
  /** Coverage: answered over judged. Null when nothing was judged. */
  readonly answerRate: number | null;
  /** Quality of what was said: correct over answered. Null when nothing was answered. */
  readonly accuracyOverAnswered: number | null;
  /** Quality of the whole run: correct over judged. Null when nothing was judged. */
  readonly accuracyOverAll: number | null;
}

/**
 * A scored run: the leaf set, one scored case per corpus case, and the
 * run-level totals.
 * @category Eval
 */
export interface EvalScore {
  /** The scoring leaf set, in the field inventory's order. */
  readonly leafPaths: readonly string[];
  /** One entry per corpus case, in the corpus's case order. */
  readonly cases: readonly ScoredCase[];
  /** The run-level totals. */
  readonly totals: EvalScoreTotals;
}
