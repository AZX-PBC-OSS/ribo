/**
 * @file The public surface of `@azx/ribo-core`.
 *
 * This barrel **re-exports only** — it defines nothing. Everything lives in the small module
 * that owns the concept (`provenance.ts`, `recording.ts`, …); this file is the list of what
 * consumers are allowed to depend on. Adding a definition here would make the barrel a place
 * where behavior hides, and would make "what is public?" un-answerable by reading one file.
 *
 * `src/contracts.test.ts` composes the whole vocabulary through this entry point, so it doubles
 * as executable documentation of the pipeline these exports describe.
 */

// Provenance — the envelope every extracted field arrives in, and the checkable
// span-validity signal that replaces confidence for review flagging.
export { extractedSchema, isSpanGrounded } from "./provenance.js";
export type { Extracted } from "./provenance.js";

// Deriving the extraction schema from a writable patch schema — every leaf
// enveloped, nested objects recursed rather than swallowed whole, closed and
// fully required throughout. `ToolAdapter.extractionSchema` is declared against
// `Enveloped<V>` and built with `enveloped(schema)`.
export { enveloped } from "./enveloped.js";
export type { Enveloped } from "./enveloped.js";

// Capture records and their transcripts.
export { baseRecordingSchema, recordingSchema } from "./recording.js";
export type { Recording } from "./recording.js";
export { transcriptSchema } from "./transcript.js";
export type { Transcript } from "./transcript.js";

// Transcription: the contract, the capability model an engine reports itself
// through, and the error that says "this device cannot" rather than "this clip
// failed".
export {
  isPermanentlyUnavailable,
  PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS,
  TRANSCRIBER_UNAVAILABLE_REASONS,
  TranscriberUnavailableError,
} from "./transcriber.js";
export type {
  Transcriber,
  TranscriberCapability,
  TranscriberUnavailableInit,
  TranscriberUnavailableReason,
} from "./transcriber.js";

// Selection: try engines in preference order, first one ready wins. The only
// combinator, and deliberately the only one.
export { DEFAULT_CAPABILITY_TTL_MS, firstCapable } from "./first-capable.js";
export type {
  CompositeTranscriber,
  EngineCapability,
  FirstCapableOptions,
  TranscriberFallback,
} from "./first-capable.js";

// The fake that lets later phases run the pipeline — and drive every capability
// state and both failure kinds — without a model.
export {
  DEFAULT_FAKE_TRANSCRIBER_ENGINE,
  DEFAULT_FAKE_TRANSCRIPT_TEXT,
  FakeTranscriber,
} from "./fake-transcriber.js";
export type {
  FakeTranscribeCall,
  FakeTranscriberOptions,
  FakeTranscriberResponse,
} from "./fake-transcriber.js";

// Microphone capture: negotiated container in, a `Recording` plus its bytes out.
export {
  DEFAULT_MIME_TYPE_PREFERENCES,
  negotiateMimeType,
  Recorder,
  RecorderError,
} from "./recorder.js";
export type {
  Capture,
  EmptyContext,
  RecorderErrorCode,
  RecorderOptions,
  RecorderPhase,
  RecorderState,
  SampleTapOptions,
  SampleTapTeardown,
  Unsubscribe,
} from "./recorder.js";

// Connectivity: the three-state (`offline`/`probing`/`online`) model whose
// stably-online edge drives the relay, over a probe that fails fast on an
// online-but-useless endpoint. Headless — event source, `navigator.onLine`,
// probe and timers are all injected.
export {
  createConnectivity,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_STABILITY_WINDOW_MS,
} from "./connectivity.js";
export type {
  Connectivity,
  ConnectivityEventBinder,
  ConnectivityOptions,
  ConnectivityProbe,
  ConnectivityState,
  ConnectivityStatus,
  ScheduleTimer,
} from "./connectivity.js";

// The durable outbox and its foreground relay. Forwarded wholesale through the
// subsystem's own barrel (`queue/index.ts`) rather than reaching into
// `queue/outbox.ts` & friends: the queue owns the list of names it publishes,
// and this line says only that all of them are public.
export * from "./queue/index.js";

// Write-back: the only tool-specific surface, with a typed host context, both
// field shapes (the writable patch and the derived extraction schema) and the
// per-attempt write metadata that carries the idempotency key.
export type { ToolAdapter, ToolAdapterExample, ValuesSchema, WriteMetadata } from "./adapter.js";

// The composition that hands a reviewed patch to an adapter, and the only place
// `schema.parse` runs before a write. Resolves the destination per item off
// `recording.ctx`, so two queued recordings from two jobs write to two places.
export { toWriteStep } from "./write-step.js";

// Extraction: the pluggable seam a transcript becomes structured fields through,
// the function that collapses any extractor onto the relay's injected step, and
// the fake that drives the pipeline with no model. Strategies live in adapters.
export { FakeExtractor, toExtractStep } from "./extractor.js";
export type {
  Extractor,
  ExtractionResult,
  ExtractionTarget,
  FakeExtractorOptions,
} from "./extractor.js";

// Work safety: the one honest "is my work safe?" answer, derived purely from the
// outbox, the storage persistence grant and connectivity — so every presenter
// classifies identically. Only synced work is truly safe; the rest is a gradient.
export { summarizeWork, workSafety } from "./work-safety.js";
export type { StoragePersistence, WorkOnDevice, WorkSafety } from "./work-safety.js";

// Human review, one leaf at a time: the values schema enumerates the leaves as flat
// dotted paths, each carrying its own schema so a UI can render and validate an edit.
export {
  buildReviewRequest,
  resolveReview,
  ReviewValidationError,
  reviewOutcomeSchema,
} from "./review.js";
export type {
  BuildReviewRequestOptions,
  FieldDecision,
  FieldDecisions,
  FieldPath,
  PersistedReviewOutcome,
  ReviewField,
  ReviewFields,
  ReviewIssue,
  ReviewOutcome,
  ReviewRequest,
  ReviewSubmission,
} from "./review.js";

// The one primitive a review UI needs and could not otherwise get without
// reaching into `/src/...`: stripping a patch leaf's `.optional()`/`.nullable()`
// wrappers to find its real kind (a `ReviewField.schema` is the DECLARED
// schema, wrappers and all — see that field's own doc comment). Public
// precisely so a UI does not have to re-implement this walk against zod's raw
// API to render an editor from a leaf's schema; `enveloped()` and
// `buildReviewRequest` both use this exact function internally, so a UI that
// re-implemented it independently would risk the two walks disagreeing about
// what counts as a wrapper.
export { stripOptionalNullable } from "./field-path.js";
