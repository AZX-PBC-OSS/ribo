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
} from "./provenance/provenance.js";
export type { SpanGroundedness } from "./provenance/provenance.js";

// The extraction sibling of `firstCapable`: choose between engines per extraction. Lives here,
// beside the `Extractor` seam it composes, for the same reason `firstCapable` lives beside
// `Transcriber` — it is a combinator over a core contract, not a transport concern.
export { compositeExtractor } from "./extraction/composite-extractor.js";
export type {
  CapabilitySource,
  CompositeExtractor,
  CompositeExtractorEntry,
  CompositeExtractorOptions,
  SelectableCapability,
} from "./extraction/composite-extractor.js";
export type { Extracted } from "./provenance/provenance.js";

// The codebase's one generic RUNTIME walk over enveloped data, as a
// structure-preserving map over its leaf envelopes — moved out of
// `gapFillExtractor`, where it was module-private, because a core combinator
// that judges results has to walk them (sp2-judging-combinators-design.md
// §4.6). The walker in `enveloped()` is schema-time and serves a different
// purpose.
export { isExtractedLeaf, mapExtractedLeaves } from "./provenance/extracted-leaves.js";
export type { LeafPath } from "./provenance/extracted-leaves.js";

// The construction-time `"leaf"`-granularity guard the judging combinators build
// on (sp2-judging-combinators-design.md §4.5): refuse a target whose groups are
// not derived at `"leaf"` provenance granularity, before any call is made — the
// walk above passes `"row"` and `"none"` groups straight through, so a combinator
// that can only serve per-leaf envelopes would otherwise compare nothing and
// count nothing exactly where hallucination is worst. A bare assertion function;
// no combinator-facing API sits on top of it.
export { assertLeafGranularity } from "./extraction/assert-leaf-granularity.js";

// The pure grounding census — a tally of how well an extraction result is cited:
// three independent facts per leaf (committed, cited, groundedness — null when
// nothing was cited, so an honest abstention stays distinguishable from a
// fabrication), plus the stated-empty group spans, plus counts derived from the
// leaves. Useful alone; `validateExtractor`'s policy decides from it
// (sp2-judging-combinators-design.md §4.2).
export { groundingCensus } from "./provenance/grounding-census.js";
export type {
  CensusEmptyGroup,
  CensusLeaf,
  GroundingCensus,
  GroundingCensusCounts,
} from "./provenance/grounding-census.js";

// The first judging combinator: wrap any extractor, tally how well its result is
// cited (the census above), and hand that tally to a caller-supplied policy —
// returning the result untouched or throwing a TERMINAL rejection an arbitration
// ladder falls through on (sp2-judging-combinators-design.md §4.2). The rejection
// being terminal is load-bearing: `terminalFallsThrough` continues on a terminal
// error and gives up on a transient one, so a transient classification would
// produce the opposite behaviour plus a relay retry loop over the hallucinating
// rung. Construction refuses a target whose groups are not leaf granularity.
export {
  rejectUngroundedCommitments,
  ValidationRejectedError,
  validateExtractor,
} from "./extraction/validate-extractor.js";
export type {
  ValidateExtractorOptions,
  ValidationPolicy,
  ValidationVerdict,
} from "./extraction/validate-extractor.js";

// The spend-ceiling detector: wrap one extractor, read the returned result's
// usage against the caller's ceilings, throw a TERMINAL error a ladder falls
// through on (sp2-judging-combinators-design.md §4.3). A detector, not a
// governor — it reports a spend it cannot prevent, and is honest around one
// strategy rather than around a ladder. No options-bag observer: a wrapper that
// delegates and judges reports nothing (ADR 0004).
export { BudgetExceededError, budgetExtractor } from "./extraction/budget-extractor.js";
export type { BudgetExtractorOptions } from "./extraction/budget-extractor.js";

// The memoisation combinator: derive a key from the transcript text and the WHOLE
// extraction target (instructions and examples are the prompt — a key omitting
// them serves one target's result for another), serve repeat calls from an
// injected store (in-memory Map by default; PluginStorage is the wrong lifetime)
// (sp2-judging-combinators-design.md §4.4). Failures are never cached; neither a
// read nor a write may fail the extraction; a hit rewrites usage to
// `calls: 0` — this run made no model calls, and the stored count is exactly
// what `budgetExtractor` reads and the session is told. No options-bag observer.
export { cachedExtractor } from "./extraction/cached-extractor.js";
export type { CachedExtractorOptions, ExtractionCache } from "./extraction/cached-extractor.js";

// The consensus arbiter contract and the two shipped policies. A policy returns
// an INDEX into the samples it was handed — not an envelope — so it cannot
// fabricate a value, a confidence or a citation; it can only point at evidence
// it was given (sp2-judging-combinators-design.md §4.1). The envelope-returning
// encoding the design's first draft specified bought one guarantee out of
// three: `Extracted<T>`'s `value` is `T | null` and its other two members never
// mention `T`, so only the fabricated non-null literal was a compile error.
// `unanimousValues` is the default because it fails safe under any reordering
// of collection instances; `majorityValues` is unsound over reordered
// collections and says so.
export { majorityValues, unanimousValues } from "./extraction/consensus-arbiter.js";
export type { ConsensusArbiter, ConsensusVerdict } from "./extraction/consensus-arbiter.js";

// The substantial judging combinator: run a list of candidates over the same
// transcript, compare the survivors leaf by leaf, and null the value of every
// leaf they disagree about while keeping a citation — the shape gap-fill
// re-asks about and review flags (sp2-judging-combinators-design.md §4.1).
// Costs N times a single extraction, and says so first. Candidates settle
// independently (not mapWithPool — no sibling is ever aborted); a caller
// cancellation is consulted before the survivor count and rethrown unchanged;
// below quorum the run throws ConsensusFailedError, which is TRANSIENT — the
// deliberate opposite of ValidationRejectedError, because candidates failing
// usually means the transport is down and the next rung shares it. The first
// survivor is structurally authoritative: put the most trusted candidate
// first. The `onContested` notification is the only channel for the contested
// count, and escapes ADR 0004's no-observer rule because it is new vocabulary
// no inner extractor emits.
export { ConsensusFailedError, consensusExtractor } from "./extraction/consensus-extractor.js";
export type { ConsensusExtractorOptions, OnContested } from "./extraction/consensus-extractor.js";

// Deriving the extraction schema from a writable patch schema — every leaf
// enveloped, nested objects recursed rather than swallowed whole, closed and
// fully required throughout. `ToolAdapter.extractionSchema` is declared against
// `Enveloped<V>` and built with `enveloped(schema)`.
// A group may declare a coarser unit of provenance than a leaf — see `ProvenanceGranularity`.
export { enveloped, ROW_SOURCE_SPAN_KEY } from "./provenance/enveloped.js";
export type {
  Enveloped,
  EnvelopedOptions,
  NoProvenance,
  ProvenanceGranularity,
  ProvenanceMap,
} from "./provenance/enveloped.js";

// Capture records and their transcripts.
export { baseRecordingSchema, recordingSchema } from "./capture/recording.js";
export type { Recording } from "./capture/recording.js";
export {
  capturePayloadSchema,
  basePayloadSchema,
  documentCaptureSchema,
  baseDocumentCaptureSchema,
} from "./capture/capture-item.js";
export type { CapturePayload, DocumentCapture } from "./capture/capture-item.js";
export { transcriptSchema } from "./capture/transcript.js";
export type { Transcript } from "./capture/transcript.js";
export { decodeEntities } from "./capture/decode-entities.js";
export type { AnnotatedTranscript, CaptureAnnotations } from "./capture/annotated-transcript.js";

// Transcript combination: the pure contract that turns per-capture
// transcripts into one, and the default combiner that reproduces the previous
// `joinSessionTranscript` output. Injected through `RelayOptions.combineTranscripts`
// so a host can replace the policy without forking the I/O.
export { createDefaultTranscriptCombiner } from "./capture/transcript-combiner.js";
export type {
  DefaultTranscriptCombinerOptions,
  TranscriptCombiner,
} from "./capture/transcript-combiner.js";

// Transcription: the contract, the capability model an engine reports itself
// through, and the error that says "this device cannot" rather than "this clip
// failed".
export {
  isPermanentlyUnavailable,
  PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS,
  TRANSCRIBER_UNAVAILABLE_REASONS,
  TranscriberUnavailableError,
} from "./transcription/transcriber.js";
export type {
  Transcriber,
  TranscribeOptions,
  TranscriberCapability,
  TranscriberUnavailableInit,
  TranscriberUnavailableReason,
} from "./transcription/transcriber.js";

// The third failure class: "this engine cannot handle this item, and that says
// nothing about the engine". Terminal for the queue (so it does not burn the
// retry budget) but not for the item (a composition layer routes to the next
// engine). See D4 in the document-transcription plan.
export { UNSUPPORTED_ITEM_REASONS, UnsupportedItemError } from "./transcription/unsupported-item.js";
export type { UnsupportedItemInit, UnsupportedItemReason } from "./transcription/unsupported-item.js";

// restrictToKind: lift a narrow transcriber into a slot that can see any
// CapturePayload, refusing other kinds with UnsupportedItemError. The compiler is
// what sends a host to it — see D7a.
export { restrictToKind } from "./transcription/restrict-to-kind.js";

// Live transcription: the streaming seam — utterance-level preview during
// recording. Defined here, implemented by the on-device engine. Not composed
// through `firstCapable`; held directly by the live orchestrator.
export type { LiveSegment, LiveSegmentKind, LiveSession, LiveTranscriber } from "./transcription/live.js";

// Selection: try engines in preference order, first one ready wins. The
// sequential combinator — deliberately the only one until hedging was added.
export { DEFAULT_CAPABILITY_TTL_MS, firstCapable } from "./transcription/first-capable.js";
export type {
  CompositeTranscriber,
  EngineCapability,
  FirstCapableOptions,
  TranscriberFallback,
} from "./transcription/first-capable.js";

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
} from "./transcription/hedged.js";
export type {
  HedgeDelayOptions,
  HedgeDelayPolicy,
  HedgedOptions,
  PredictedDurationMs,
  TranscriberHedgeEvent,
} from "./transcription/hedged.js";

// Transcription arbitration: the decision vocabulary that lets a host
// classify transcriber candidate outcomes — the sibling of the extractor
// arbitration exports above. The core accumulates outcomes in settlement
// order; the host decides whether to accept, continue, or give up. The default
// arbiter (unsupportedFallsThrough) accepts the first success, continues past
// UnsupportedItemError and TranscriberUnavailableError, and at exhaustion gives
// up with the first retryable error if there is one (D7 rule 2).
// The default stays unsupportedFallsThrough (first success wins — right for a
// ladder, where settlement order IS preference order). preferEngineOrder is the
// alternative a concurrent combinator wants: a race breaks that identity, so it
// accepts the best-ranked success instead of the fastest one.
export { preferEngineOrder, unsupportedFallsThrough } from "./transcription/transcription-arbitration.js";
export type {
  TranscriptionArbiter,
  TranscriptionArbiterInput,
  TranscriptionArbiterVerdict,
  TranscriptionOutcome,
} from "./transcription/transcription-arbitration.js";

// The TTL-keyed capability cache the transcription combinators share, extracted
// when `raceTranscriber` became the third copy of the shape. `firstCapable` and
// `hedged` still carry their own copies — a deliberate, unfinished migration
// (see capability-cache.ts's header).
export { CapabilityCache } from "./transcription/capability-cache.js";
export type { CapabilityCacheOptions } from "./transcription/capability-cache.js";

// Transcriber fallback: try transcribers in order without consulting
// capability(), letting an arbiter decide whether each outcome is acceptable.
// The per-item sibling of firstCapable — a reader who thinks it is
// "firstCapable with retries" will wire it wrongly.
export { fallbackTranscriber } from "./transcription/fallback-transcriber.js";
export type { FallbackTranscriberOptions } from "./transcription/fallback-transcriber.js";

// Transcriber race: start every capable engine at once and let an arbiter
// accept a transcript as it settles, wait for more, or give up. The
// transcription-side counterpart of raceExtractor — a separate constructor so
// concurrency is opt-in by name, not a scheduling flag. Dispatches to every
// capable engine, so a race that includes a managed engine sends the audio
// every time; a deployment that will not pay for that composes firstCapable.
export { raceTranscriber } from "./transcription/race-transcriber.js";
export type { RaceTranscriberOptions } from "./transcription/race-transcriber.js";

// The fake that lets later phases run the pipeline — and drive every capability
// state and all three failure kinds — without a model.
export {
  DEFAULT_FAKE_TRANSCRIBER_ENGINE,
  DEFAULT_FAKE_TRANSCRIPT_TEXT,
  FakeTranscriber,
} from "./transcription/fake-transcriber.js";
export type {
  FakeTranscribeCall,
  FakeTranscriberOptions,
  FakeTranscriberResponse,
} from "./transcription/fake-transcriber.js";

// Microphone capture: negotiated container in, a `Recording` plus its bytes out.
export {
  DEFAULT_MIME_TYPE_PREFERENCES,
  negotiateMimeType,
  Recorder,
  RecorderError,
} from "./recorder.js";
export type {
  RecorderCapture,
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
} from "./connectivity/connectivity.js";
export type {
  Connectivity,
  ConnectivityEventBinder,
  ConnectivityOptions,
  ConnectivityProbe,
  ConnectivityState,
  ConnectivityStatus,
} from "./connectivity/connectivity.js";

// The cancellable timer seam the connectivity model and the hedging/timeout
// combinators share — its consumers span the transcription and extraction
// combinator families, so the type lives beside neither of them.
export type { ScheduleTimer } from "./async/schedule-timer.js";

// A model response that parsed as JSON but violated the extraction schema.
// Thrown by the managed extractors and read by the default arbiter, so it lives
// in core rather than in the extractor package — core cannot import from
// `@azx/ribo-extractor-openai`.
export { SchemaParseError } from "./extraction/schema-parse-error.js";

// Storage and its foreground relay. Forwarded wholesale through the subsystem's
// own barrel (`storage/index.ts`) rather than reaching into `storage/captures.ts`
// & friends: the subsystem owns the list of names it publishes, and this line
// says only that all of them are public.
export * from "./storage/index.js";

// Write-back: the only tool-specific surface, with a typed host context, both
// field shapes (the writable patch and the derived extraction schema) and the
// per-attempt write metadata that carries the idempotency key.
export type {
  IdentifyingFields,
  RequiredOnCreate,
  ToolAdapter,
  ToolAdapterExample,
  ValuesSchema,
  WriteMetadata,
} from "./write/adapter.js";

// Inventory/fill vocabulary shared between an adapter (which builds the roster and
// fill instructions) and the scoped instance fill strategy (which consumes them).
// Both packages already depend on core, so this is the neutral home.
export type { FillScope, Roster, RosterCandidate } from "./extraction/inventory-types.js";

// The composition that hands a reviewed patch to an adapter, and the only place
// `schema.parse` runs before a write. Resolves the destination per item off
// `recording.ctx`, so two queued recordings from two jobs write to two places.
export { toWriteStep } from "./write/write-step.js";

// Per-instance write-back: a sibling of `toWriteStep` that writes each collection
// instance separately with a derived idempotency key, and persists per-instance
// progress in the storage so a retry resumes after the instances already written.
export { deriveInstanceIdempotencyKey, toInstanceWriteStep } from "./write/instance-write-step.js";
export type { ToInstanceWriteStepOptions } from "./write/instance-write-step.js";

// Extraction: the pluggable seam a transcript becomes structured fields through,
// the function that collapses any extractor onto the relay's injected step, and
// the fake that drives the pipeline with no model. Strategies live in adapters.
export { FakeExtractor, toSessionExtractStep } from "./extraction/extractor.js";
export type {
  Extractor,
  ExtractionResult,
  ExtractionUsage,
  ExtractionTarget,
  FakeExtractorOptions,
  ExtractOptions,
} from "./extraction/extractor.js";

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
} from "./extraction/arbitration.js";
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
} from "./extraction/arbitration.js";

// Cancellation: the brand a foreign transport's error may carry, so a combinator
// in core can recognise "the caller stopped this" without importing the
// transport's error type — the edge runs from producer packages to core only.
export { CANCELLATION, CancellationError, isCancellation } from "./async/cancellation.js";
export type { CancellationBranded } from "./async/cancellation.js";

// Strategy fallback: try extraction strategies in order and let an arbiter
// decide whether each outcome is acceptable, continuing past failures the host
// classifies as recoverable. Lives in core because it composes the core
// Extractor seam and the arbiter vocabulary, not any model or transport.
export { fallbackExtractor } from "./extraction/fallback-extractor.js";
export type { FallbackCandidate } from "./extraction/fallback-extractor.js";

// Strategy race: start every strategy at once and let an arbiter accept an
// outcome as it settles, wait for more, or give up. A separate constructor from
// `fallbackExtractor` so concurrency is opt-in by name, not a scheduling flag.
export { raceExtractor } from "./extraction/race-extractor.js";
export type { RaceCandidate } from "./extraction/race-extractor.js";

// Strategy retry: wrap one extractor with the attempt loop — transient failures
// retried with full-jitter backoff, terminal errors and cancellations rethrown
// untouched. Follows the same positional combinator shape as its siblings above.
export { retryExtractor } from "./extraction/retry-extractor.js";
export type { RetryExtractorOptions } from "./extraction/retry-extractor.js";

// The attempt loop itself, extracted from `retryExtractor` so the phased engine can
// retry items whose `run` is not an `Extractor` without growing a sixth copy of the
// policy. Same rules, same order of checks; `onAttempt` is what makes a retry
// observable to the unit stream.
export { retryAsync } from "./async/retry-async.js";
export type { RetryAsyncOptions } from "./async/retry-async.js";

// Strategy timeout: bound one extractor to a deadline with a signal the inner
// extractor can honour, racing the work against a timer so a hung inner cannot
// hang the run. Its error is deliberately not cancellation-branded — a deadline
// elapsing and a caller cancelling are different events.
export { ExtractionTimeoutError, timeoutExtractor } from "./extraction/timeout-extractor.js";
export type { TimeoutExtractorOptions } from "./extraction/timeout-extractor.js";

// Strategy hedge: start a primary and fire a hedge on a delay, taking whichever
// settles first and cancelling the loser so the usual case bills for one. The
// extraction counterpart of `hedged`, keeping `timeoutExtractor`'s signal and
// deadline discipline; deliberately not built on the concurrent engine, which
// forwards options unchanged and constructs no controller, so a loser there
// runs to completion and bills.
export { hedgedExtractor } from "./extraction/hedged-extractor.js";
export type {
  ExtractionHedgeEvent,
  HedgeDelay,
  HedgedExtractorOptions,
} from "./extraction/hedged-extractor.js";

// The grouped run: take a per-key map of group extractors and own the
// cross-group work — coverage at construction, a bounded pool, the derived
// retry budget, sibling abort, the merge, the second trust-boundary parse,
// usage and `statedEmptyGroups`. A third combinator over the same `Extractor`
// seam, so per-group heterogeneity is composition rather than options
// (per-group-composition-design.md §4.2).
export { groupedExtractor } from "./extraction/grouped-extractor.js";
export type { GroupedExtractorOptions, GroupMap } from "./extraction/grouped-extractor.js";

// The primitives `groupedExtractor` composes, exported because the extractor
// strategies in `ribo-extractor-openai` share them: `mapWithPool` was two
// byte-identical copies there (per-group and instance-fill) before it moved
// here; `mergeGroupPieces` recombines a partitioned group's pieces; and
// `parseWithSchema` is THE trust-boundary parse every extractor crosses.
export { mapWithPool } from "./async/map-with-pool.js";
export { mergeGroupPieces } from "./extraction/merge-group-pieces.js";
export { parseWithSchema } from "./extraction/parse-with-schema.js";

// Work safety: the one honest "is my work safe?" answer, derived purely from the
// storage, the storage persistence grant and connectivity — so every presenter
// classifies identically. Only synced work is truly safe; the rest is a gradient.
export { summarizeWork, workSafety } from "./connectivity/work-safety.js";
export type { StoragePersistence, WorkOnDevice, WorkSafety } from "./connectivity/work-safety.js";

// Instance identity: existing records enter at review, and a human decides whether to
// link each dictated instance to one or create a new record.
export { contradictionMatcher } from "./review/instance-identity.js";
export type {
  ExistingRecord,
  IdentifyingFieldsMap,
  InstanceEvidence,
  InstanceFacts,
  InstanceLinkDecision,
  InstanceMatcher,
  InstanceSameness,
  LinkTarget,
  LinkTargets,
  RankedCandidate,
} from "./review/instance-identity.js";

// Human review, one leaf at a time: the values schema enumerates the leaves as flat
// dotted paths, each carrying its own schema so a UI can render and validate an edit.
export {
  buildReviewRequest,
  resolveReview,
  ReviewValidationError,
  reviewOutcomeSchema,
} from "./review/review.js";
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
} from "./review/review.js";

// The one primitive a review UI needs and could not otherwise get without
// reaching into `/src/...`: stripping a patch leaf's `.optional()`/`.nullable()`
// wrappers to find its real kind (a `ReviewField.schema` is the DECLARED
// schema, wrappers and all — see that field's own doc comment). Public
// precisely so a UI does not have to re-implement this walk against zod's raw
// API to render an editor from a leaf's schema; `enveloped()` and
// `buildReviewRequest` both use this exact function internally, so a UI that
// re-implemented it independently would risk the two walks disagreeing about
// what counts as a wrapper.
export { stripOptionalNullable } from "./provenance/field-path.js";

// Field-path grammar: one shared implementation for building and parsing dotted
// and bracketed paths. Object-key and instance-key segments are distinct at the
// type level so `resolveReview` cannot silently rebuild `hvac[k3].leaf` as an
// object whose key is the literal text `hvac[k3]`.
export { buildFieldPath, parseFieldPath } from "./provenance/field-path.js";
export type { FieldPathSegment } from "./provenance/field-path.js";

// Retry-budget derivation: the shared worst-case-fit calculation every managed
// extractor uses to cap retries inside a step timeout. Hoisted here so the two
// extractor copies do not drift — see extraction-observability-design.md §0.4.
// `RetryBudgetObserver` is the options mixin a later task wires into each
// extractor's options type.
export { deriveRetryBudget, PER_CALL_CEILING_MS } from "./async/retry-budget.js";
export type { RetryBudget, RetryBudgetObserver } from "./async/retry-budget.js";

// Extraction observability — one optional progress hook every strategy reports
// through, plus the unit variants it carries and the id/strategy helpers.
// Declared once here and inherited by every extractor's options, so a reviewer
// watching a ten-minute extraction sees each unit of work start and settle.
export { nextUnitId, stampStrategy } from "./extraction/extraction-observer.js";
export type {
  ExtractionObserver,
  ExtractionUnit,
  GroupUnit,
  PhaseUnit,
  WholeUnit,
} from "./extraction/extraction-observer.js";

// Phased extraction, wave 3a — the phase vocabulary, with no engine yet. A phase becomes a
// value a caller can construct, inspect and validate; nothing runs one (the engine is a
// later wave). Branded note keys and the immutable bag they address: the cross-phase
// RUNTIME channel, whose keys are typed so two phases cannot silently clobber or misread.
// Declaration is phase ids (`PhaseMeta.requires`); a phase that reads a note demands it
// at its read site — `demandNote` is that throw (ADR 0008).
export { demandNote, emptyNotes, noteKey } from "./phases/phase-notes.js";
export type { NoteKey, Notes } from "./phases/phase-notes.js";
// The draft a phased run's phases progressively fill, and its homomorphic deep partial —
// the shape that lets a phase write one leaf's `sourceSpan` without claiming its siblings.
// `readonly` throughout: `merge` owns every write, and a `run` cannot write through the
// draft it is handed. `PhaseFold` is the shared spelling for a phase's own typed write
// into the draft — the caller's fold, at the caller's value type.
export { emptyDraft } from "./phases/phase-draft.js";
export type { DeepPartial, PhaseDraft, PhaseFold } from "./phases/phase-draft.js";
// What one item's work produced and how it settled — the per-item vocabulary a phase's
// `run` and `merge` speak. Discriminated on `outcome`, matching `arbitration.ts`'s
// `ExtractionOutcome` rather than inventing a second outcome vocabulary.
export type { PhaseItemOutcome, PhaseOutput } from "./phases/phase-outcome.js";
// The phase type itself: plan/run/merge with the item and contribution types hidden
// EXISTENTIALLY behind one `with` member — never erased with a cast — so the engine that
// lands in a later wave cannot hand one phase's items to another phase's `run` without a
// compile error. The metadata stays on the outside for the construction check and a
// planner. `phaseBuilder<V, P>()` is curried: V/P fixed once per strategy, I/C inferred
// per phase.
export { phaseBuilder } from "./phases/phase.js";
export type { Phase, PhaseContext, PhaseDef, PhaseMeta } from "./phases/phase.js";
// The construction-time phase-list validator: reject a mis-wired list — empty, duplicate
// id, a `requires` naming a phase that does not appear earlier in the list, a bad
// concurrency or retry count — before the first call is paid for, naming the offending
// phase and id or value.
export { validatePhases } from "./phases/validate-phases.js";
// Any Extractor becomes a phase: the primitive that makes the later `phasedExtractor` the
// outer shell for the whole family rather than a fourth sibling beside the existing
// combinators. One item (the whole document), `signal`/`deadline` forwarded, usage on the
// `PhaseOutput`, and a shallow top-level merge into the draft.
export { extractorPhase } from "./phases/extractor-phase.js";
export type { ExtractorPhaseOptions } from "./phases/extractor-phase.js";

// The chat transport seam — moved here from `@azx/ribo-extractor-openai` (SP4a wave 5)
// beside the transport-agnostic phases that consume it. Core stays IMPLEMENTATION-free:
// the transports (`openAiChat`, `helixChat`, the on-device one) live in the extractor
// packages and are injected. `ChatError` is a VALUE export (a class); the rest are types.
export { ChatError } from "./phases/chat-client.js";
export type {
  CapableChatClient,
  ChatCallOptions,
  ChatCapability,
  ChatClient,
  ChatCompletion,
  ChatErrorKind,
  ChatFinishReason,
  ChatMessage,
  ChatRequest,
  ChatResponseFormat,
  ChatRole,
  ChatUnavailableReason,
  ChatUsage,
} from "./phases/chat-client.js";
// The managed-completion call-and-parse chain, moved from the same package's
// `extraction-common` (which re-exports it) so `askPhase` composes the chain its managed
// cousins do — one copy of the terminal/transient classification semantics, beside the
// seam.
export { assertStopFinishReason, completeOrClassify, parseJsonContent } from "./phases/chat-parse.js";

// The three-phase walk, moved here from `@azx/ribo-extractor-ondevice` (SP4a wave 5):
// the phases ask a `ChatClient` which leaves are present, what spans support them, and
// which are unsupported — nothing on-device — and core owns the phase vocabulary. The
// on-device package keeps the preset; a host composes the phases from here, the way
// `public-composition.test.ts` does.
export { extractGroups, presencePhase, presenceNoteKey } from "./phases/presence-phase.js";
export type { Group, JsonSchema, Leaf, PresencePhaseOptions } from "./phases/presence-phase.js";
export { spanPhase, spansNoteKey } from "./phases/span-phase.js";
export type { SpanPhaseOptions } from "./phases/span-phase.js";
export { classifyPhase, classifyWrappedPhase, unsupportedNoteKey } from "./phases/classify-phase.js";
export type { ClassifyPhaseOptions } from "./phases/classify-phase.js";

// The phased-extraction engine (wave 3b): run a list of phases in order, fanning each
// phase's items out through a bounded pool, threading the draft through each `merge`,
// then normalize once and parse once. Owns scheduling, retry, cancellation, the running
// deadline and the `PhaseUnit` progress stream, so a multi-pass strategy is a list of
// narrowing steps rather than a bespoke loop.
export { phasedExtractor } from "./phases/phased-extractor.js";
export type { PhasedExtractorOptions } from "./phases/phased-extractor.js";

// The caller-owned kinds beside the shipped ones: a deterministic, model-free fold
// between passes (`computePhase` — one marker item, no I/O, no usage), and one model
// call against the CALLER'S own schema, result type and note key (`askPhase` — the
// curried factory whose `T` unifies `z.ZodType<T>` and `NoteKey<T>` in one options
// object). Neither declares a `requires` of its own, so the option is the whole list
// (ADR 0008); a fold's completeness is checked at the closing parse, not mid-list
// (ADR 0012).
export { askPhase } from "./phases/ask-phase.js";
export type { AskPhaseBase, AskPhaseOptions, AskPhaseSink } from "./phases/ask-phase.js";
export { computePhase } from "./phases/compute-phase.js";
export type { ComputePhaseOptions } from "./phases/compute-phase.js";

// Chunking was built here and REMOVED after measurement. `chunkedExtractor` split a
// transcript past a context window, extracted each piece and merged. Measured against
// the real corpus it inflated a collection group's instance count in 13 of 14
// transcripts — one phantom instance per chunk, because each chunk sees a fragment of
// one unit and reports a unit. And the problem it solved does not occur here: the whole
// corpus is 21KB of text, while the constraint that actually binds is SCHEMA size, which
// per-group extraction already handles. The SP3 design's §4.3 records the measurement.
