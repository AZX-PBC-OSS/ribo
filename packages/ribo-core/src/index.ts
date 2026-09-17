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
export {
  extractedSchema,
  isExtractedSchema,
  isSpanGrounded,
  spanGroundedness,
} from "./provenance.js";
export type { SpanGroundedness } from "./provenance.js";

// The extraction sibling of `firstCapable`: choose between engines per extraction. Lives here,
// beside the `Extractor` seam it composes, for the same reason `firstCapable` lives beside
// `Transcriber` — it is a combinator over a core contract, not a transport concern.
export { compositeExtractor } from "./composite-extractor.js";
export type {
  CapabilitySource,
  CompositeExtractor,
  CompositeExtractorEntry,
  CompositeExtractorOptions,
  SelectableCapability,
} from "./composite-extractor.js";
export type { Extracted } from "./provenance.js";

// Deriving the extraction schema from a writable patch schema — every leaf
// enveloped, nested objects recursed rather than swallowed whole, closed and
// fully required throughout. `ToolAdapter.extractionSchema` is declared against
// `Enveloped<V>` and built with `enveloped(schema)`.
// A group may declare a coarser unit of provenance than a leaf — see `ProvenanceGranularity`.
export { enveloped, ROW_SOURCE_SPAN_KEY } from "./enveloped.js";
export type {
  Enveloped,
  EnvelopedOptions,
  NoProvenance,
  ProvenanceGranularity,
  ProvenanceMap,
} from "./enveloped.js";

// Capture records and their transcripts.
export { baseRecordingSchema, recordingSchema } from "./recording.js";
export type { Recording } from "./recording.js";
export {
  captureItemSchema,
  baseCaptureItemSchema,
  documentCaptureSchema,
  baseDocumentCaptureSchema,
} from "./capture-item.js";
export type { CaptureItem, DocumentCapture } from "./capture-item.js";
export { transcriptSchema } from "./transcript.js";
export type { Transcript } from "./transcript.js";
export { decodeEntities } from "./decode-entities.js";
export type { AnnotatedTranscript, CaptureAnnotations } from "./annotated-transcript.js";

// Transcript combination: the pure contract that turns per-capture
// transcripts into one, and the default combiner that reproduces the previous
// `joinSessionTranscript` output. Injected through `RelayOptions.combineTranscripts`
// so a host can replace the policy without forking the I/O.
export { createDefaultTranscriptCombiner } from "./transcript-combiner.js";
export type {
  DefaultTranscriptCombinerOptions,
  TranscriptCombiner,
} from "./transcript-combiner.js";

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
  TranscribeOptions,
  TranscriberCapability,
  TranscriberUnavailableInit,
  TranscriberUnavailableReason,
} from "./transcriber.js";

// The third failure class: "this engine cannot handle this item, and that says
// nothing about the engine". Terminal for the queue (so it does not burn the
// retry budget) but not for the item (a composition layer routes to the next
// engine). See D4 in the document-transcription plan.
export { UNSUPPORTED_ITEM_REASONS, UnsupportedItemError } from "./unsupported-item.js";
export type { UnsupportedItemInit, UnsupportedItemReason } from "./unsupported-item.js";

// restrictToKind: lift a narrow transcriber into a slot that can see any
// CaptureItem, refusing other kinds with UnsupportedItemError. The compiler is
// what sends a host to it — see D7a.
export { restrictToKind } from "./restrict-to-kind.js";

// Live transcription: the streaming seam — utterance-level preview during
// recording. Defined here, implemented by the on-device engine. Not composed
// through `firstCapable`; held directly by the live orchestrator.
export type { LiveSegment, LiveSegmentKind, LiveSession, LiveTranscriber } from "./live.js";

// Selection: try engines in preference order, first one ready wins. The
// sequential combinator — deliberately the only one until hedging was added.
export { DEFAULT_CAPABILITY_TTL_MS, firstCapable } from "./first-capable.js";
export type {
  CompositeTranscriber,
  EngineCapability,
  FirstCapableOptions,
  TranscriberFallback,
} from "./first-capable.js";

// Hedging: race a preferred engine against a fallback on a latency budget.
// A sibling of `firstCapable`, not a flag inside it — rule 5 stays untouched.
// `ribo-core` does not know what a real-time factor is; the delay policy
// receives a function returning milliseconds, supplied by the host.
export {
  DEFAULT_HEDGE_BUDGET_MS,
  DEFAULT_HEDGE_FACTOR,
  DEFAULT_HEDGE_FLOOR_MS,
  hedgeDelay,
  hedged,
} from "./hedged.js";
export type {
  HedgeDelayOptions,
  HedgeDelayPolicy,
  HedgedOptions,
  PredictedDurationMs,
  TranscriberHedgeEvent,
} from "./hedged.js";

// Transcription arbitration: the decision vocabulary that lets a host
// classify transcriber candidate outcomes — the sibling of the extractor
// arbitration exports above. The core accumulates outcomes in settlement
// order; the host decides whether to accept, continue, or give up. The default
// arbiter (unsupportedFallsThrough) accepts the first success, continues past
// UnsupportedItemError and TranscriberUnavailableError, and at exhaustion gives
// up with the first retryable error if there is one (D7 rule 2).
export { unsupportedFallsThrough } from "./transcription-arbitration.js";
export type {
  TranscriptionArbiter,
  TranscriptionArbiterInput,
  TranscriptionArbiterVerdict,
  TranscriptionOutcome,
} from "./transcription-arbitration.js";

// Transcriber fallback: try transcribers in order without consulting
// capability(), letting an arbiter decide whether each outcome is acceptable.
// The per-item sibling of firstCapable — a reader who thinks it is
// "firstCapable with retries" will wire it wrongly.
export { fallbackTranscriber } from "./fallback-transcriber.js";
export type { FallbackTranscriberOptions } from "./fallback-transcriber.js";

// The fake that lets later phases run the pipeline — and drive every capability
// state and all three failure kinds — without a model.
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

// A model response that parsed as JSON but violated the extraction schema.
// Thrown by the managed extractors and read by the default arbiter, so it lives
// in core rather than in the extractor package — core cannot import from
// `@azx/ribo-extractor-openai`.
export { SchemaParseError } from "./schema-parse-error.js";

// The durable outbox and its foreground relay. Forwarded wholesale through the
// subsystem's own barrel (`queue/index.ts`) rather than reaching into
// `queue/outbox.ts` & friends: the queue owns the list of names it publishes,
// and this line says only that all of them are public.
export * from "./queue/index.js";

// Write-back: the only tool-specific surface, with a typed host context, both
// field shapes (the writable patch and the derived extraction schema) and the
// per-attempt write metadata that carries the idempotency key.
export type {
  RequiredOnCreate,
  ToolAdapter,
  ToolAdapterExample,
  ValuesSchema,
  WriteMetadata,
} from "./adapter.js";

// Inventory/fill vocabulary shared between an adapter (which builds the roster and
// fill instructions) and the scoped instance fill strategy (which consumes them).
// Both packages already depend on core, so this is the neutral home.
export type { FillScope, Roster, RosterCandidate } from "./inventory-types.js";

// The composition that hands a reviewed patch to an adapter, and the only place
// `schema.parse` runs before a write. Resolves the destination per item off
// `recording.ctx`, so two queued recordings from two jobs write to two places.
export { toWriteStep } from "./write-step.js";

// Per-instance write-back: a sibling of `toWriteStep` that writes each collection
// instance separately with a derived idempotency key, and persists per-instance
// progress in the outbox so a retry resumes after the instances already written.
export { deriveInstanceIdempotencyKey, toInstanceWriteStep } from "./instance-write-step.js";
export type { ToInstanceWriteStepOptions } from "./instance-write-step.js";

// Extraction: the pluggable seam a transcript becomes structured fields through,
// the function that collapses any extractor onto the relay's injected step, and
// the fake that drives the pipeline with no model. Strategies live in adapters.
export { FakeExtractor, toSessionExtractStep } from "./extractor.js";
export type {
  Extractor,
  ExtractionResult,
  ExtractionUsage,
  ExtractionTarget,
  FakeExtractorOptions,
  ExtractOptions,
} from "./extractor.js";

// Arbitration: the decision vocabulary that lets a host classify extraction
// strategy outcomes. The core accumulates outcomes in settlement order; the host
// decides whether to accept, continue, or give up. The two defaults are the
// conservative policy (terminal errors fall through, transient ones stop) and the
// degraded-experience policy (any success is accepted). The shared engine
// underpins `fallbackExtractor`, the reimplemented `compositeExtractor`, and
// `raceExtractor`; it is exported because Task 3's `compositeExtractor` consumes
// the sequential engine directly.
export {
  acceptAnySuccess,
  createConcurrentExtractor,
  createSequentialExtractor,
  errorOutcome,
  resultOutcome,
  terminalFallsThrough,
} from "./arbitration.js";
export type {
  AdmissionVerdict,
  ArbiterInput,
  ArbiterVerdict,
  ConcurrentExtractorCandidate,
  ConcurrentExtractorOptions,
  ErrorOutcome,
  ExtractionArbiter,
  ExtractionOutcome,
  ExtractorEngineCandidate,
  ResultOutcome,
  SequentialExtractorOptions,
} from "./arbitration.js";

// Cancellation: the brand a foreign transport's error may carry, so a combinator
// in core can recognise "the caller stopped this" without importing the
// transport's error type — the edge runs from producer packages to core only.
export { CANCELLATION, CancellationError, isCancellation } from "./cancellation.js";
export type { CancellationBranded } from "./cancellation.js";

// Strategy fallback: try extraction strategies in order and let an arbiter
// decide whether each outcome is acceptable, continuing past failures the host
// classifies as recoverable. Lives in core because it composes the core
// Extractor seam and the arbiter vocabulary, not any model or transport.
export { fallbackExtractor } from "./fallback-extractor.js";
export type { FallbackCandidate } from "./fallback-extractor.js";

// Strategy race: start every strategy at once and let an arbiter accept an
// outcome as it settles, wait for more, or give up. A separate constructor from
// `fallbackExtractor` so concurrency is opt-in by name, not a scheduling flag.
export { raceExtractor } from "./race-extractor.js";
export type { RaceCandidate } from "./race-extractor.js";

// Strategy retry: wrap one extractor with the attempt loop — transient failures
// retried with full-jitter backoff, terminal errors and cancellations rethrown
// untouched. Follows the same positional combinator shape as its siblings above.
export { retryExtractor } from "./retry-extractor.js";
export type { RetryExtractorOptions } from "./retry-extractor.js";

// The attempt loop itself, extracted from `retryExtractor` so the phased engine can
// retry items whose `run` is not an `Extractor` without growing a sixth copy of the
// policy. Same rules, same order of checks; `onAttempt` is what makes a retry
// observable to the unit stream.
export { retryAsync } from "./retry-async.js";
export type { RetryAsyncOptions } from "./retry-async.js";

// Strategy timeout: bound one extractor to a deadline with a signal the inner
// extractor can honour, racing the work against a timer so a hung inner cannot
// hang the run. Its error is deliberately not cancellation-branded — a deadline
// elapsing and a caller cancelling are different events.
export { ExtractionTimeoutError, timeoutExtractor } from "./timeout-extractor.js";
export type { TimeoutExtractorOptions } from "./timeout-extractor.js";

// The grouped run: take a per-key map of group extractors and own the
// cross-group work — coverage at construction, a bounded pool, the derived
// retry budget, sibling abort, the merge, the second trust-boundary parse,
// usage and `statedEmptyGroups`. A third combinator over the same `Extractor`
// seam, so per-group heterogeneity is composition rather than options
// (per-group-composition-design.md §4.2).
export { groupedExtractor } from "./grouped-extractor.js";
export type { GroupedExtractorOptions, GroupMap } from "./grouped-extractor.js";

// The primitives `groupedExtractor` composes, exported because the extractor
// strategies in `ribo-extractor-openai` share them: `mapWithPool` was two
// byte-identical copies there (per-group and instance-fill) before it moved
// here; `mergeGroupPieces` recombines a partitioned group's pieces; and
// `parseWithSchema` is THE trust-boundary parse every extractor crosses.
export { mapWithPool } from "./map-with-pool.js";
export { mergeGroupPieces } from "./merge-group-pieces.js";
export { parseWithSchema } from "./parse-with-schema.js";

// Work safety: the one honest "is my work safe?" answer, derived purely from the
// outbox, the storage persistence grant and connectivity — so every presenter
// classifies identically. Only synced work is truly safe; the rest is a gradient.
export { summarizeWork, workSafety } from "./work-safety.js";
export type { StoragePersistence, WorkOnDevice, WorkSafety } from "./work-safety.js";

// Instance identity: existing records enter at review, and a human decides whether to
// link each dictated instance to one or create a new record.
export type {
  ExistingRecord,
  InstanceLinkDecision,
  LinkTarget,
  LinkTargets,
  RankedCandidate,
} from "./instance-identity.js";

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
  ReviewCollectionNode,
  ReviewField,
  ReviewFields,
  ReviewGroupState,
  ReviewInstanceNode,
  ReviewIssue,
  ReviewLeafNode,
  ReviewNode,
  ReviewObjectNode,
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

// Field-path grammar: one shared implementation for building and parsing dotted
// and bracketed paths. Object-key and instance-key segments are distinct at the
// type level so `resolveReview` cannot silently rebuild `hvac[k3].leaf` as an
// object whose key is the literal text `hvac[k3]`.
export { buildFieldPath, parseFieldPath } from "./field-path.js";
export type { FieldPathSegment } from "./field-path.js";

// Retry-budget derivation: the shared worst-case-fit calculation every managed
// extractor uses to cap retries inside a step timeout. Hoisted here so the two
// extractor copies do not drift — see extraction-observability-design.md §0.4.
// `RetryBudgetObserver` is the options mixin a later task wires into each
// extractor's options type.
export { deriveRetryBudget, PER_CALL_CEILING_MS } from "./retry-budget.js";
export type { RetryBudget, RetryBudgetObserver } from "./retry-budget.js";

// Extraction observability — one optional progress hook every strategy reports
// through, plus the unit variants it carries and the id/strategy helpers.
// Declared once here and inherited by every extractor's options, so a reviewer
// watching a ten-minute extraction sees each unit of work start and settle.
export { nextUnitId, stampStrategy } from "./extraction-observer.js";
export type {
  ExtractionObserver,
  ExtractionUnit,
  GroupUnit,
  PhaseUnit,
  WholeUnit,
} from "./extraction-observer.js";

// Phased extraction, wave 3a — the phase vocabulary, with no engine yet. A phase becomes a
// value a caller can construct, inspect and validate; nothing runs one (the engine is a
// later wave). Branded note keys and the immutable bag they address: the cross-phase
// channel whose keys are typed so two phases cannot silently clobber or misread, while the
// keys stay plain strings at runtime for `requires`/`produces` and a model-emitted plan.
export { emptyNotes, noteKey } from "./phase-notes.js";
export type { NoteKey, Notes } from "./phase-notes.js";
// The draft a phased run's phases progressively fill, and its homomorphic deep partial —
// the shape that lets a phase write one leaf's `sourceSpan` without claiming its siblings.
// `readonly` throughout: `merge` owns every write, and a `run` cannot write through the
// draft it is handed.
export { emptyDraft } from "./phase-draft.js";
export type { DeepPartial, PhaseDraft } from "./phase-draft.js";
// What one item's work produced and how it settled — the per-item vocabulary a phase's
// `run` and `merge` speak. Discriminated on `outcome`, matching `arbitration.ts`'s
// `ExtractionOutcome` rather than inventing a second outcome vocabulary.
export type { PhaseItemOutcome, PhaseOutput } from "./phase-outcome.js";
// The phase type itself: plan/run/merge with the item and contribution types hidden
// EXISTENTIALLY behind one `with` member — never erased with a cast — so the engine that
// lands in a later wave cannot hand one phase's items to another phase's `run` without a
// compile error. The metadata stays on the outside for the construction check and a
// planner. `phaseBuilder<V, P>()` is curried: V/P fixed once per strategy, I/C inferred
// per phase.
export { phaseBuilder } from "./phase.js";
export type { Phase, PhaseContext, PhaseDef, PhaseMeta } from "./phase.js";
// The construction-time phase-list validator: reject a mis-wired list — empty, duplicate
// id, a `requires` no earlier phase `produces`, a bad concurrency or retry count — before
// the first call is paid for, naming the offending phase and key or value. The
// per-phase-boundary `produces` verification is a different check that runs during a run
// and belongs with the engine (Wave 3b), not here.
export { validatePhases } from "./validate-phases.js";
// Any Extractor becomes a phase: the primitive that makes the later `phasedExtractor` the
// outer shell for the whole family rather than a fourth sibling beside the existing
// combinators. One item (the whole document), `signal`/`deadline` forwarded, usage on the
// `PhaseOutput`, and a shallow top-level merge into the draft.
export { extractorPhase } from "./extractor-phase.js";

// The phased-extraction engine (wave 3b): run a list of phases in order, fanning each
// phase's items out through a bounded pool, threading the draft through each `merge`,
// then normalize once and parse once. Owns scheduling, retry, cancellation, the running
// deadline and the `PhaseUnit` progress stream, so a multi-pass strategy is a list of
// narrowing steps rather than a bespoke loop.
export { phasedExtractor } from "./phased-extractor.js";
export type { PhasedExtractorOptions } from "./phased-extractor.js";
