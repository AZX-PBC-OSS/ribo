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
 * not validated. A document case runs on its PDF's transcribed text:
 * `transcribeDocumentCases` reads it under Node through the real
 * `PdfjsTranscriber` over pdf.js's legacy build (spike 0013), once per run,
 * shared by every arm.
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
 *
 * The package's seventh surface is the comparison: `compareEvalRunRecords`
 * lines two run records up and reports the identity fields they differ on
 * (the axes), the leaf intersection with each side's exclusion counts, and
 * every differing cell pair with both sides' persisted cells — the
 * computation behind the `ribo compare` command and behind a multi-arm
 * `ribo eval` run's cross-arm summary.
 */
export { CONTRACT_VERSION, SchemaInspectError, inspectSchema } from "./inspect-schema.js";
export type { SchemaInspectOptions, SchemaInspectReport } from "./inspect-schema.js";
export { SchemaInspectReportSchema } from "./inspect-schema.js";
export { planSchema, schemaPlanFreshness } from "./schema-plan.js";
export type {
  PlanSchemaOptions,
  SchemaPlanFreshness,
  SchemaPlanFreshnessStatus,
} from "./schema-plan.js";
export { initSchema } from "./schema-init.js";
export type {
  InitSchemaOptions,
  SchemaInitCollectionDeclaration,
  SchemaInitDraft,
  SchemaInitEnumMember,
  SchemaInitEvidence,
  SchemaInitLeafDeclaration,
  SchemaInitLeafKind,
  SchemaInitNodeDeclaration,
  SchemaInitObjectDeclaration,
  SchemaInitOpenApiCollection,
  SchemaInitOpenApiLeaf,
  SchemaInitOpenApiNode,
  SchemaInitOpenApiObject,
  SchemaInitPropertyDeclaration,
  SchemaInitProposal,
  SchemaInitProvenance,
  SchemaInitSample,
  SchemaInitSampleInput,
} from "./schema-init.js";
export { cliVersion, coreVersion } from "./versions.js";
export { CorpusError } from "./corpus.js";
export {
  CorpusCaseSchema,
  CorpusCaseInputSchema,
  CorpusCaptureBlockSchema,
  CorpusCombineOptionsSchema,
  CorpusExampleSchema,
  CorpusManifestSchema,
  CorpusPromptInputsSchema,
  ExpectationEntrySchema,
  ExpectationProposalSchema,
  ExpectationReviewSchema,
  ExpectationValueSchema,
  ProposalEvidenceMapSchema,
  ProposalEvidenceSchema,
  ProposalEvidenceSetSchema,
  ScopedDefaultSchema,
  loadCorpus,
  resolveExpectation,
} from "./corpus.js";
export type {
  CorpusCase,
  CorpusCaseInput,
  CorpusCombineOptions,
  CorpusCaptureBlock,
  CorpusExample,
  CorpusInputKind,
  CorpusManifest,
  CorpusProvenance,
  CorpusPromptInputs,
  ExpectationEntry,
  ExpectationProposal,
  ExpectationReview,
  ExpectationReviewClass,
  ExpectationStatus,
  ExpectationValue,
  LoadedCase,
  LoadedCaseInput,
  LoadedCorpus,
  ProposalEvidence,
  ResolvedExpectation,
  ResolvedExpectationOrigin,
  ScopedDefault,
  ScopedDefaultStatus,
} from "./corpus.js";
export { runEval, runEvalWithSettings } from "./eval/run.js";
export type { RunEvalOptions, RunEvalWithSettingsResult } from "./eval/run.js";
export { transcribeDocumentCases } from "./eval/documents.js";
export type { DocumentTexts, DocumentTranscriptionOptions } from "./eval/documents.js";
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
export {
  EVAL_COMPARE_AXES,
  EVAL_COMPARE_CONTRACT_VERSION,
  EvalCompareDifferenceSchema,
  EvalCompareReportSchema,
  EvalCompareSideSchema,
} from "./eval/compare-report.js";
export { compareEvalRunRecords } from "./eval/compare.js";
export type {
  EvalCompareAxis,
  EvalCompareDifference,
  EvalCompareReport,
  EvalCompareSide,
} from "./eval/compare-report.js";
export type { EvalCompareOptions } from "./eval/compare.js";
export { cliChat } from "./cli-chat.js";
export type { CliBackendName, CliChatOptions, CliShapeResult } from "./cli-chat.js";
export type { OpenAiCompatibleChatOptions } from "./eval/backend.js";
export type {
  EvalCaseResult,
  EvalConsensusArbiter,
  EvalJsonValue,
  EvalSettings,
  EvalSettingsInput,
  EvalSplitCaps,
  EvalStrategyId,
  EvalUsage,
} from "./eval/types.js";
