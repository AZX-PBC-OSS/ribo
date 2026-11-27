/**
 * @file The record's assembly: a run, a corpus and a score, one record.
 *
 * The builder is PURE: it reads no file, writes no file and takes no clock
 * reading it was not given (the capture time defaults to now, which a test
 * overrides). It computes both fingerprints, projects the model out of the
 * settings, and re-keys the scorer's grid leaf-major.
 *
 * The lineage is NOT built here: it is a fact of the records directory, so
 * the store owns it. The record's constructor exists exactly once, and the
 * gate wrapper that builds records of its own goes through this one.
 */
import type { LoadedCorpus } from "../corpus.js";
import { EXPECTATION_REVIEW_CLASSES } from "../corpus/expectations.js";
import { EvalError } from "./error.js";
import { corpusFingerprint, runFingerprint } from "./record-fingerprint.js";
import {
  EVAL_RUN_RECORD_CONTRACT_VERSION,
  type EvalRunRecord,
  type EvalRunRecordDraft,
  type EvalRunRecordExpectations,
  type EvalRunRecordHazards,
  type EvalRunRecordSettings,
} from "./record-schema.js";
import type { EvalScore } from "./score-types.js";
import type { EvalBackendName } from "./backend.js";
import type { EvalCaseResult, EvalSettings } from "./types.js";

/**
 * What a record is built from.
 * @category Eval
 */
export interface EvalRunRecordInput {
  /** The corpus the run measured. */
  readonly corpus: LoadedCorpus;
  /** The backend the run used. */
  readonly backend: EvalBackendName;
  /** The runner-issued effective settings, including any semantic plan identity. */
  readonly settings: EvalSettings;
  /** The arm's results, one per case. */
  readonly results: readonly EvalCaseResult[];
  /** The arm's score, as the scorer computed it. */
  readonly score: EvalScore;
  /** When the run was captured. Defaults to now. */
  readonly capturedAt?: string;
  /** The optional hazard extension. */
  readonly hazards?: EvalRunRecordHazards;
}

/**
 * The settings as the record persists them: the runner's settings without the
 * model, which is the record's own field.
 * @param settings - The runner's settings.
 * @returns The persisted settings.
 */
const persistedSettings = (settings: EvalSettings): EvalRunRecordSettings => ({
  strategies: settings.strategies,
  ...(settings.planFingerprint === undefined ? {} : { planFingerprint: settings.planFingerprint }),
  ...(settings.consensusCandidates === undefined
    ? {}
    : { consensusCandidates: settings.consensusCandidates }),
  ...(settings.consensusArbiter === undefined
    ? {}
    : { consensusArbiter: settings.consensusArbiter }),
  ...(settings.maxRetries === undefined ? {} : { maxRetries: settings.maxRetries }),
  ...(settings.responseCap === undefined ? {} : { responseCap: settings.responseCap }),
  ...(settings.splitCaps === undefined ? {} : { splitCaps: settings.splitCaps }),
});

/**
 * The grid, re-keyed leaf-major: `grid[leafPath][caseId]`.
 *
 * The scorer's cells are per case; the record's grid is read leaf by leaf,
 * with the cases as its columns. The scorer computed the leaf set through the
 * one field inventory, and this builder never walks the schema itself.
 * @param score - The arm's score.
 * @returns The grid, keyed leaf-major.
 */
const leafMajorGrid = (score: EvalScore): EvalRunRecord["grid"] => {
  const grid: EvalRunRecord["grid"] = {};
  for (const leafPath of score.leafPaths) grid[leafPath] = {};
  for (const scored of score.cases) {
    for (const leafPath of score.leafPaths) {
      const cell = scored.cells[leafPath];
      if (cell === undefined) {
        throw new EvalError(
          `eval: the score of the case "${scored.caseId}" has no cell for the leaf "${leafPath}" — ` +
            "the scorer judges every leaf of every case (fix: score the run's own score)",
        );
      }
      grid[leafPath]![scored.caseId] = cell;
    }
  }
  return grid;
};

/**
 * Refuse a score that does not describe the run's own results.
 *
 * A record is the source of truth every view renders, so a score of a
 * different run must never be persisted under this one's name.
 * @param results - The arm's results.
 * @param score - The arm's score.
 * @throws {@link EvalError} when the score's cases are not the results' cases.
 */
const checkScoreMatchesResults = (results: readonly EvalCaseResult[], score: EvalScore): void => {
  const resultIds = results.map((entry) => entry.caseId).sort();
  const scoredIds = score.cases.map((entry) => entry.caseId).sort();
  if (resultIds.join(",") === scoredIds.join(",")) return;
  throw new EvalError(
    `eval: the score describes the cases [${scoredIds.join(", ")}] but the run produced the cases ` +
      `[${resultIds.join(", ")}] — a record is the source of truth, so a score of another run ` +
      "must never be persisted under this one's name (fix: score the run's own results)",
  );
};

/**
 * The judged cells' expectation origins, from the scored cells and nothing
 * else (R8): every count reads the cells the scorer already wrote — never a
 * re-read case file. The summary exists only when the corpus is
 * proposal-bearing, which the cells themselves declare: a cell carries a
 * proposer exactly when its entry carried a proposal.
 *
 * A judged cell without a `review` member — one resolved from a covering
 * default, whose blanket claim carries no review class — counts as
 * hand-written. No rate is split by origin: corrected cells are selected for
 * difficulty, so a rate over them would mislead (D5).
 * @param score - The arm's score.
 * @param backend - The backend the run scored, which a same-model count is
 * judged against.
 * @param model - The model the run scored.
 * @returns The summary, or undefined over a proposal-free corpus.
 */
const expectationsSummary = (
  score: EvalScore,
  backend: EvalBackendName,
  model: string,
): EvalRunRecordExpectations | undefined => {
  let sawProposer = false;
  let sameModelAcceptedUnchanged = 0;
  const classes = new Map<string, number>();
  const proposers = new Map<string, { backend: string; model: string; cells: number }>();
  for (const scored of score.cases) {
    for (const cell of Object.values(scored.cells)) {
      const review = cell.review;
      sawProposer ||= review?.proposerBackend !== undefined;
      if (cell.verdict === "unscorable") continue;
      const reviewClass = review?.class ?? "hand-written";
      classes.set(reviewClass, (classes.get(reviewClass) ?? 0) + 1);
      const { proposerBackend, proposerModel } = review ?? {};
      if (proposerBackend === undefined || proposerModel === undefined) continue;
      const key = `${proposerBackend}\u0000${proposerModel}`;
      const known = proposers.get(key);
      proposers.set(key, {
        backend: proposerBackend,
        model: proposerModel,
        cells: (known?.cells ?? 0) + 1,
      });
      if (
        reviewClass === "accepted-unchanged" &&
        proposerBackend === backend &&
        proposerModel === model
      ) {
        sameModelAcceptedUnchanged += 1;
      }
    }
  }
  if (!sawProposer) return undefined;
  const reviewClasses: EvalRunRecordExpectations["reviewClasses"] = {};
  for (const name of EXPECTATION_REVIEW_CLASSES) {
    const count = classes.get(name);
    if (count !== undefined) reviewClasses[name] = count;
  }
  return {
    reviewClasses,
    proposers: [...proposers.values()].sort(
      (left, right) =>
        left.backend.localeCompare(right.backend) || left.model.localeCompare(right.model),
    ),
    sameModelAcceptedUnchanged,
  };
};

/**
 * Build a run record from a run and its score.
 *
 * The record carries the corpus's identity — its name, its fingerprint and
 * its declared provenance — the run fingerprint over the schema and the
 * prompt, the backend, the model as its own field, the arm's settings, the
 * scorer's totals, the leaf set and the dense grid, and optionally the
 * hazard counts.
 *
 * The lineage is left to the store: this builder produces the record
 * WITHOUT it, because a lineage is a fact of the directory the record is
 * written into.
 * @param input - The corpus, the backend, the arm's settings, its results and its score.
 * @returns The record, without its lineage.
 * @throws {@link EvalError} when the score does not describe the run's results.
 * @category Eval
 */
export function buildEvalRunRecord(input: EvalRunRecordInput): EvalRunRecordDraft {
  checkScoreMatchesResults(input.results, input.score);
  const expectations = expectationsSummary(input.score, input.backend, input.settings.model);
  return {
    contractVersion: EVAL_RUN_RECORD_CONTRACT_VERSION,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    corpus: {
      name: input.corpus.manifest.name,
      fingerprint: corpusFingerprint(input.corpus),
      provenance: input.corpus.manifest.provenance,
    },
    fingerprint: runFingerprint(input.corpus.schemaDocument, input.corpus.manifest.prompt),
    backend: input.backend,
    model: input.settings.model,
    settings: persistedSettings(input.settings),
    totals: input.score.totals,
    leafPaths: [...input.score.leafPaths],
    grid: leafMajorGrid(input.score),
    ...(expectations === undefined ? {} : { expectations }),
    ...(input.hazards === undefined ? {} : { hazards: input.hazards }),
  };
}
