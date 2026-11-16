/**
 * @module @azx/ribo-cli
 *
 * @file The public surface of `@azx/ribo-cli` — the CLI tier's single package
 * (ADR 0037): one bin, `ribo`, over one importable entry with the same input
 * contract. The entry takes the JSON Schema document the bin takes — never a
 * zod object (ADR 0038) — and returns the versioned report of design §7,
 * zod-parsed against the exported `SchemaInspectReportSchema`.
 *
 * The package's second surface is the corpus: the validated corpus format a
 * run is measured over — `loadCorpus` reads a corpus directory and returns it
 * fully validated, and the zod schemas the format is written against are
 * exported beside it, so a writer and the loader cannot drift apart.
 *
 * The package's third surface is the eval runner: `runEval` takes a loaded
 * corpus, a chat client and one settings object, runs one arm — an ordered
 * ladder of core's strategies, optionally wrapped in the consensus modifier —
 * over the corpus, and resolves with one result per case. The corpus enters
 * only through `loadCorpus`, so a run can never happen over a corpus that was
 * not validated.
 *
 * The package's fourth surface is the CLI-backed chat transport: `cliChat`
 * shells the operator's own installed `claude`/`codex` binary instead of
 * calling an HTTP endpoint, under the operator's own login and with no
 * credential at all. It is the transport behind `ribo eval --backend
 * claude-cli|codex-cli`, and it is Node-only by design.
 *
 * The package's fifth surface is the scorer: `scoreEvalRun` judges one run
 * against one loaded corpus, leaf by leaf, and returns a dense grid of
 * per-cell verdicts beside the three rates — the answer rate and the two
 * accuracies, always together, because any two of them read as a
 * contradiction when the third is missing.
 *
 * The package's sixth surface is the run record: the versioned, zod-parsed
 * JSON document a run persists, one per arm, under `./ribo-eval-runs/` or the
 * directory `--out` names. It carries the corpus's identity, the run
 * fingerprint over the schema and the prompt, the backend, the model as its
 * own field, the run's settings as one object, the score and the lineage.
 *
 * The record's identity — backend, model, settings and run fingerprint — is
 * computed here and nowhere else: `runFingerprint`, `corpusFingerprint`,
 * `recordIdentity` and the currency predicate `isRecordCurrent` are the one
 * copy of that arithmetic, so a consumer outside the CLI (the accuracy-page
 * generator, the gate wrapper) judges staleness by the same code the run
 * used.
 */
export { CONTRACT_VERSION, SchemaInspectError, inspectSchema } from "./inspect-schema.js";
export type { SchemaInspectOptions, SchemaInspectReport } from "./inspect-schema.js";
export { SchemaInspectReportSchema } from "./inspect-schema.js";
export { cliVersion, coreVersion } from "./versions.js";
export { CorpusError } from "./corpus.js";
export {
  CorpusCaseSchema,
  CorpusCaptureBlockSchema,
  CorpusExampleSchema,
  CorpusManifestSchema,
  CorpusPromptInputsSchema,
  ExpectationEntrySchema,
  ExpectationValueSchema,
  ScopedDefaultSchema,
  loadCorpus,
  resolveExpectation,
} from "./corpus.js";
export type {
  CorpusCase,
  CorpusCaseKind,
  CorpusCaptureBlock,
  CorpusExample,
  CorpusManifest,
  CorpusProvenance,
  CorpusPromptInputs,
  ExpectationEntry,
  ExpectationStatus,
  ExpectationValue,
  LoadedCase,
  LoadedCaseInput,
  LoadedCorpus,
  ResolvedExpectation,
  ResolvedExpectationOrigin,
  ScopedDefault,
  ScopedDefaultStatus,
} from "./corpus.js";
export { runEval } from "./eval/run.js";
export { scoreEvalRun } from "./eval/score.js";
export { EVAL_VERDICTS } from "./eval/score-types.js";
export type {
  EvalCell,
  EvalScore,
  EvalScoreTotals,
  EvalVerdict,
  ScoredCase,
} from "./eval/score-types.js";
export { RETIRED_VERDICT_TRANSLATION } from "./eval/retired-verdicts.js";
export { createOpenAiCompatibleChat } from "./eval/backend.js";
export { EvalError } from "./eval/error.js";
export { EvalRunRecordSchema } from "./eval/record-schema.js";
export type {
  EvalRunRecord,
  EvalRunRecordDraft,
  EvalRunRecordHazards,
  EvalRunRecordIdentity,
  EvalRunRecordSettings,
} from "./eval/record-schema.js";
export {
  corpusFingerprint,
  isRecordCurrent,
  recordIdentity,
  runFingerprint,
} from "./eval/record-fingerprint.js";
export { buildEvalRunRecord } from "./eval/record-build.js";
export type { EvalRunRecordInput } from "./eval/record-build.js";
export {
  EVAL_RUN_RECORDS_DEFAULT_DIR,
  readEvalRunRecords,
  writeEvalRunRecord,
} from "./eval/record-store.js";
export { cliChat } from "./cli-chat.js";
export type { CliBackendName, CliChatOptions, CliShapeResult } from "./cli-chat.js";
export type { OpenAiCompatibleChatOptions } from "./eval/backend.js";
export type {
  EvalCaseResult,
  EvalConsensusArbiter,
  EvalJsonValue,
  EvalSettings,
  EvalSplitCaps,
  EvalStrategyId,
  EvalUsage,
} from "./eval/types.js";
