/**
 * @file The public surface of `@azx/ribo-extractor-openai`.
 *
 * A tool-agnostic extractor plasmid: the two chat transports, plus re-exports
 * of the transport-agnostic strategy cluster that lives in `@azx/ribo-core`
 * and once lived here — the strategies, presets, schema split and shape
 * derivation over the chat seam. Re-exporting keeps existing consumers
 * working, the same compatibility move the chat seam itself already made.
 * Everything works against any `ExtractionTarget<F>` from `@azx/ribo-core`,
 * so it lives outside every tool adapter — a SnuggPro adapter, a future
 * adapter, or a test target all wire the same extractor.
 */

// The single-shot managed-LLM extractor (the built default) and its options —
// moved into `@azx/ribo-core` beside the chat seam it speaks, and re-exported
// here so no consumer breaks.
export { singleShotExtractor } from "@azx/ribo-core";
export type { SingleShotOptions } from "@azx/ribo-core";

// The per-group schema split — the pure, model-free half of R3. Takes a target's
// `extractionSchema` and returns one entry per top-level group (or one fallback
// entry covering the whole schema). The per-group extractor consumes this. The
// split packs against two caps — nullable unions and, when the caller supplies
// it, serialized size — both as options (`SplitOptions`); the library carries no
// provider's byte cap. The split's top-level classifier and its nesting-depth
// measure are exported beside it: `describeExtraction` reports with them, and a
// host comparing a piece against its route's depth cap reads the same walk.
// Moved to `@azx/ribo-core` with the strategies that consume it; re-exported
// for compatibility.
export {
  MAX_NULLABLE_UNIONS_PER_CALL,
  serializedNestingDepth,
  splitExtractionSchema,
  topLevelKeyKinds,
} from "@azx/ribo-core";
export type {
  ExtractionGroup,
  SplitOptions,
  TopLevelKey,
  TopLevelKeyKind,
  TopLevelKeyKinds,
} from "@azx/ribo-core";

// The dry run of the split: what a schema will become — keys, path, call
// shape, per-piece measurements, and the refusal construction would raise —
// reported synchronously, before an extractor is constructed and without a
// model. Reads everything off the split's own code, so it cannot drift from
// what construction actually does.
export { describeExtraction } from "@azx/ribo-core";
export type {
  DescribeDerivedSchemaOptions,
  DescribeExtractionOptions,
  DescribeRawSchemaOptions,
  ExtractionDescription,
  ExtractionFlatReason,
  ExtractionPieceDescription,
  ExtractionRefusal,
  ExtractionRefusalStage,
  SchemaMeasures,
} from "@azx/ribo-core";

// The entry point that takes a RAW zod schema: the `enveloped()` derivation and
// the single-shot-vs-per-group selection run inside, so a newcomer hands over
// the schema they wrote, a chat client and a model, and gets an `Extractor`.
export { schemaExtractor } from "@azx/ribo-core";
export type { EnvelopedSchemaExtractorOptions, RawSchemaExtractorOptions } from "@azx/ribo-core";

// The derived extraction shape: apply explicit shape operations to a caller's
// plain zod schema and get the artifact pair — an extraction schema, and the
// mapping back as data — plus the reversal combinator that turns an extractor
// over the extraction shape into one over the derived patch.
//
// Two derivation surfaces. `deriveExtractionShape` is the model-free applier:
// the caller hands in explicit operations and the artifact comes out, or it
// throws the first refusal. Its sibling `deriveExtractionShapePartially` is
// the same applier collecting instead: every refusal it can find in one pass,
// classified (local / consequential / set, with the consequential culprit
// named), plus the artifact derived from the operations that survived — a
// host applying a model's proposal gets the middle option between "throw the
// set away" and "catch, parse the message by hand, strip one op, retry". The
// model-driven counterpart is `proposeShapeOperations` — the model emits the
// operations, the same applier applies them. `proposeExtractionShape` is the
// one-call convenience that composes the two for a host that wants the
// artifact directly.
export { deriveExtractionShape, deriveExtractionShapePartially } from "@azx/ribo-core";
export type { DeriveExtractionShapeOptions } from "@azx/ribo-core";
export type {
  PartiallyDerivedShape,
  ShapeRefusal,
  ShapeRefusalCause,
  ShapeRefusalClass,
} from "@azx/ribo-core";
export type { ShapeOperation } from "@azx/ribo-core";
export type { DerivedExtractionShape } from "@azx/ribo-core";
export { assertShapeMapping, retypeToPatchValue } from "@azx/ribo-core";
export type { LeafKind, LeafMapping, Retype, ShapeMapping } from "@azx/ribo-core";
export { reverseShapedFields } from "@azx/ribo-core";
export { reshapedExtractor } from "@azx/ribo-core";
export { generateShapedValue } from "@azx/ribo-core";
export type { GenerateOptions } from "@azx/ribo-core";
export { proposeExtractionShape, proposeShapeOperations } from "@azx/ribo-core";
export type { ProposeOptions } from "@azx/ribo-core";
export { renderLeafInventory, walkLeafInventory } from "@azx/ribo-core";
export type { LeafInventoryEntry } from "@azx/ribo-core";

// Projection of an extraction target onto one top-level group key — the pure
// narrow half of per-group prompt assembly, reusable by any strategy. Moved to
// `@azx/ribo-core` with the single-shot cluster; re-exported for compatibility.
export { projectTarget } from "@azx/ribo-core";
export type { ProjectTargetOptions } from "@azx/ribo-core";

// The per-group managed-LLM extractor (R3 Task 2) — one chat call per top-level
// group, concurrently with a bounded pool, assembled into one result. The
// sibling of `singleShotExtractor`; same `Extractor` seam. Composition plan
// Task 12 re-expressed it as a preset over core's `groupedExtractor`: the
// derived plan (`perGroupPlan`) and the per-group override layer
// (`overrideGroups`) are exported so a host can take the defaults everywhere
// and replace or wrap one group — per piece, so a partitioned group's override
// applies to every piece — without rebuilding the other nineteen.
export {
  overrideGroups,
  perGroupArrayExtractor,
  perGroupExtractor,
  perGroupPlan,
  perGroupSingletonExtractor,
} from "@azx/ribo-core";
export type { GroupOverride, GroupTargets, PerGroupOptions, PerGroupPlan } from "@azx/ribo-core";

// The presence-narrowed fill phase and its preset — the managed path's ADR
// 0026 narrowing. A presence phase seeds every group key into the draft; the
// fill phase then makes one value-extraction call per group with at least one
// present leaf, over a `projectTarget`-narrowed target carrying exactly the
// active leaves. Both moved to `@azx/ribo-core` (the phase beside the phases
// it follows, the preset beside the strategies it composes) and are
// re-exported from there. The preset takes the presence phase as a PARAMETER
// (core's chat-backed `presencePhase`, or the System One one) rather than
// importing one, and ships opt-in — no existing default changed. A host
// wanting engine knobs hand-assembles the same list through core's
// `phasedExtractor`.
export { presenceFillPhase } from "@azx/ribo-core";
export type { PresenceFillPhaseOptions } from "@azx/ribo-core";
export { presenceNarrowedExtractor } from "@azx/ribo-core";

// Task 16 — the R1.6 instance-modeling strategy ladder: three tiers composed
// through `fallbackExtractor` so that the strongest strategy can fall back to
// weaker ones, with the accepted tier stamped on `usage.strategy`.
export { instanceLadder } from "@azx/ribo-core";
export type { InstanceLadderOptions } from "@azx/ribo-core";

// The gap-fill combinator: wraps a base extractor with one bounded follow-up
// call over leaves that abstained despite quoting evidence. It is a
// `phasedExtractor` preset — an `extractorPhase` base followed by the
// follow-up phase — so a host can assemble the same phase list by hand and
// extend it with phases of its own. The leaf-walk and merge helpers are
// exported for testing, as `buildGroupMessages` is.
export {
  findAbstainedLeaves,
  findUngroundedLeaves,
  formatLeafPath,
  gapFillExtractor,
  mergeGapFilledLeaves,
} from "@azx/ribo-core";
export type { AbstainedLeaf, GapFillOptions, GapFillTarget } from "@azx/ribo-core";

// The gap-fill follow-up phase itself — the second phase of the
// `gapFillExtractor` preset, exported so a host can assemble and extend the
// phase list by hand (design `phased-extraction-design.md` §4.7).
export { gapFillPhase } from "@azx/ribo-core";
export type { GapFillPhaseOptions } from "@azx/ribo-core";

// The scoped-instance inventory phase — the first phase of the
// `scopedInstanceExtractor` port, exported (with the note key its roster
// crosses the phase boundary under) so a host can assemble and extend the
// phase list by hand.
export { inventoryPhase, rosterNoteKey } from "@azx/ribo-core";
export type { InventoryPhaseOptions } from "@azx/ribo-core";

// The scoped-instance fill phase — the second phase of the port: one job per
// `(group, piece, instance)`, recombined with `mergeGroupPieces`. Exported for
// the same hand-assembly a host may want.
export { fillPhase } from "@azx/ribo-core";
export type { FillPhaseOptions } from "@azx/ribo-core";

// The schema-retry combinator: wraps a base extractor with a bounded
// self-correction loop that feeds a `SchemaParseError` back to the model as
// conversation turns — the failed output as an assistant turn, the validation
// error as a user turn — never by touching the transcript.
export { schemaRetryExtractor } from "@azx/ribo-core";
export type { SchemaRetryOptions } from "@azx/ribo-core";

// Per-group prompt assembly: `buildGroupMessages` builds per-group chat messages
// (instructions + projected examples + transcript), and `projectExample` narrows
// a few-shot example to a single group's key. Exported for testing (R3 Task 4).
// The helpers moved to `@azx/ribo-core` with the single-shot cluster; re-exported
// for compatibility.
export {
  assertStopFinishReason,
  assertWireSafeSchemaName,
  buildGroupMessages,
  buildMessages,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
  projectExample,
} from "@azx/ribo-core";

// The Task 9 inventory-pass extraction phase: one house-wide call that returns a
// roster of candidate instances per collection group, parsed through a supplied
// roster schema.
export { extractInventory } from "@azx/ribo-core";
export type { InventoryOptions } from "@azx/ribo-core";

// Task 10 — scoped per-instance fills and assembly: one inventory call followed by
// one fill call per current instance, with a scope block that names siblings and
// excluded candidates. Exports the extractor, prompt assembly helpers, and the
// generic roster/fill-scope types that the adapter's `buildFillInstructions` consumes.
// `PreparedGroup` is the per-piece shape the two scoped-instance phases take, and
// `prepareGroups` is its ONE construction site — a host composing its own phase
// list builds the same groups the preset builds.
export {
  buildFillMessages,
  prepareGroups,
  projectFillExample,
  scopedInstanceExtractor,
} from "@azx/ribo-core";
export type {
  FillScope,
  PreparedGroup,
  Roster,
  RosterCandidate,
  ScopedFillOptions,
} from "@azx/ribo-core";

// The OpenAI-compatible chat transport and its options.
export { openAiChat } from "./chat/openai-chat.js";
export type { OpenAiChatOptions } from "./chat/openai-chat.js";

// The Helix platform LLM route transport and its options — a second
// `ChatClient` beside `openAiChat`, for the provider-neutral `/_api/llm/chat`
// route (not OpenAI-compatible).
export { helixChat } from "./chat/helix-chat.js";
export type { HelixChatOptions } from "./chat/helix-chat.js";

// The chat transport seam now lives in `@azx/ribo-core` (the phases moved there
// with it, SP4a wave 5). This re-export is compatibility for existing consumers;
// `openAiChat` and `helixChat` above remain the implementations, still here.
export { ChatError } from "@azx/ribo-core";
export type {
  CapableChatClient,
  ChatCallOptions,
  ChatCapability,
  ChatClient,
  ChatCompletion,
  ChatErrorKind,
  ChatFinishReason,
  ChatUnavailableReason,
  ChatMessage,
  ChatRequest,
  ChatResponseFormat,
  ChatRole,
  ChatUsage,
} from "@azx/ribo-core";
