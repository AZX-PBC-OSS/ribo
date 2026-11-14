/**
 * @file The corpus surface: the loader, its schemas and its types.
 *
 * The corpus format is a corpus directory's own declaration — a manifest, one
 * directory per case, a sparse map of expected answers — and this module is
 * the one place it is read. The format is frozen by this module's contract: a
 * later migration that meets a case the format cannot express records a
 * documented gap rather than widening the format mid-migration.
 *
 * Everything here is library surface. The `ribo` bin grows a command for it
 * later; the loader itself is what the runner, the scorer and the Snugg
 * migration consume.
 */
export { CorpusError } from "./corpus/error.js";
export {
  CorpusManifestSchema,
  CorpusPromptInputsSchema,
  CorpusExampleSchema,
} from "./corpus/manifest.js";
export type {
  CorpusManifest,
  CorpusPromptInputs,
  CorpusExample,
  CorpusProvenance,
} from "./corpus/manifest.js";
export {
  CorpusCaseSchema,
  CorpusCaptureBlockSchema,
  ExpectationEntrySchema,
  ExpectationValueSchema,
  ScopedDefaultSchema,
} from "./corpus/case.js";
export type {
  CorpusCase,
  CorpusCaseKind,
  CorpusCaptureBlock,
  ExpectationEntry,
  ExpectationStatus,
  ExpectationValue,
  ScopedDefault,
  ScopedDefaultStatus,
} from "./corpus/case.js";
export { resolveExpectation } from "./corpus/expectations.js";
export type { ResolvedExpectation, ResolvedExpectationOrigin } from "./corpus/expectations.js";
export { loadCorpus } from "./corpus/loader.js";
export type { LoadedCorpus, LoadedCase, LoadedCaseInput } from "./corpus/loader.js";
