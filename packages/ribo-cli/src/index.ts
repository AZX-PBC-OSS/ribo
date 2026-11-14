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
export { createOpenAiCompatibleChat } from "./eval/backend.js";
export { EvalError } from "./eval/error.js";
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
