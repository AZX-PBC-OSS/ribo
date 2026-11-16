/**
 * @file The test support the record suites drive: one run over a corpus, the
 * score of that run, and the record the two make.
 *
 * The run is driven over the stub chat, so no suite here reaches a model, a
 * network or a credential — and the number of calls the stub saw is carried
 * out, so a suite that drove nothing fails instead of passing vacuously.
 */
import { loadCorpus } from "../../corpus/loader.js";
import type { LoadedCorpus } from "../../corpus/loader.js";
import { buildEvalRunRecord } from "../record-build.js";
import { runEval } from "../run.js";
import type { EvalRunRecordDraft } from "../record-schema.js";
import { scoreEvalRun } from "../score.js";
import type { EvalScore } from "../score-types.js";
import { stubChat } from "./stub-chat.js";
import type { StubChatOptions } from "./stub-chat.js";
import type { EvalBackendName } from "../backend.js";
import type { EvalCaseResult, EvalSettings } from "../types.js";

/**
 * One run over a corpus, and the record it produced.
 * @category Eval
 */
export interface EvalRecordRun {
  /** The loaded corpus the run measured. */
  readonly corpus: LoadedCorpus;
  /** The run's results, one per case. */
  readonly results: readonly EvalCaseResult[];
  /** The run's score. */
  readonly score: EvalScore;
  /** The record the run made, without its lineage. */
  readonly record: EvalRunRecordDraft;
  /** How many calls the stub chat saw — zero means the run drove nothing. */
  readonly calls: number;
}

/**
 * Run one arm over a corpus and build its record.
 * @param corpusDir - The corpus directory to run over.
 * @param settings - The arm's settings.
 * @param options - The backend the run used, the capture time to stamp, and how the stub answers.
 * @returns The run, its score and its record.
 * @category Eval
 */
export async function recordOverCorpus(
  corpusDir: string,
  settings: EvalSettings,
  options: {
    readonly backend?: EvalBackendName;
    readonly capturedAt?: string;
    readonly stub?: StubChatOptions;
  } = {},
): Promise<EvalRecordRun> {
  const corpus = loadCorpus(corpusDir);
  const chat = stubChat(options.stub ?? {});
  const results = await runEval(corpus, chat, settings);
  const score = scoreEvalRun(corpus, results);
  const record = buildEvalRunRecord({
    corpus,
    backend: options.backend ?? "openai-compatible",
    settings,
    results,
    score,
    ...(options.capturedAt === undefined ? {} : { capturedAt: options.capturedAt }),
  });
  return { corpus, results, score, record, calls: chat.calls.length };
}
