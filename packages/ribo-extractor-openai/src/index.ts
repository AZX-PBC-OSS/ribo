/**
 * @file The public surface of `@azx/ribo-extractor-openai`.
 *
 * A tool-agnostic extractor plasmid: the single-shot managed-LLM strategy and its
 * OpenAI-compatible chat transport. It works against any `ExtractionTarget<F>` from
 * `@azx/ribo-core`, so it lives outside every tool adapter — a SnuggPro adapter, a
 * future adapter, or a test target all wire the same extractor. Re-exports only.
 */

// The single-shot managed-LLM extractor (the built default) and its options.
export { singleShotExtractor } from "./strategies/single-shot.js";
export type { SingleShotOptions } from "./strategies/single-shot.js";

// The per-group schema split — the pure, model-free half of R3. Takes a target's
// `extractionSchema` and returns one entry per top-level group (or one fallback
// entry covering the whole schema). The per-group extractor consumes this. The
// split packs against two caps — nullable unions and, when the caller supplies
// it, serialized size — both as options (`SplitOptions`); the library carries no
// provider's byte cap. The split's top-level classifier and its nesting-depth
// measure are exported beside it: `describeExtraction` reports with them, and a
// host comparing a piece against its route's depth cap reads the same walk.
export {
  MAX_NULLABLE_UNIONS_PER_CALL,
  serializedNestingDepth,
  splitExtractionSchema,
  topLevelKeyKinds,
} from "./schema/split-schema.js";
export type {
  ExtractionGroup,
  SplitOptions,
  TopLevelKey,
  TopLevelKeyKind,
  TopLevelKeyKinds,
} from "./schema/split-schema.js";

// The dry run of the split: what a schema will become — keys, path, call
// shape, per-piece measurements, and the refusal construction would raise —
// reported synchronously, before an extractor is constructed and without a
// model. Reads everything off the split's own code, so it cannot drift from
// what construction actually does.
export { describeExtraction } from "./schema/describe-extraction.js";
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
} from "./schema/describe-extraction.js";

// The entry point that takes a RAW zod schema: the `enveloped()` derivation and
// the single-shot-vs-per-group selection run inside, so a newcomer hands over
// the schema they wrote, a chat client and a model, and gets an `Extractor`.
export { schemaExtractor } from "./strategies/schema-extractor.js";
export type {
  EnvelopedSchemaExtractorOptions,
  RawSchemaExtractorOptions,
} from "./strategies/schema-extractor.js";

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
export { deriveExtractionShape, deriveExtractionShapePartially } from "./shape/shape-operations.js";
export type { DeriveExtractionShapeOptions } from "./shape/shape-operations.js";
export type {
  PartiallyDerivedShape,
  ShapeRefusal,
  ShapeRefusalCause,
  ShapeRefusalClass,
} from "./shape/shape-refusal.js";
export type { ShapeOperation } from "./shape/shape-operation.js";
export type { DerivedExtractionShape } from "./shape/derived-shape.js";
export { assertShapeMapping, retypeToPatchValue } from "./shape/shape-mapping.js";
export type { LeafKind, LeafMapping, Retype, ShapeMapping } from "./shape/shape-mapping.js";
export { reverseShapedFields } from "./shape/shape-reverse.js";
export { reshapedExtractor } from "./shape/reshaped-extractor.js";
export { generateShapedValue } from "./shape/shape-generate.js";
export type { GenerateOptions } from "./shape/shape-generate.js";
export { proposeExtractionShape, proposeShapeOperations } from "./shape/operations-proposer.js";
export type { ProposeOptions } from "./shape/operations-proposer.js";
export { renderLeafInventory, walkLeafInventory } from "./shape/leaf-inventory.js";
export type { LeafInventoryEntry } from "./shape/leaf-inventory.js";

// Projection of an extraction target onto one top-level group key — the pure
// narrow half of per-group prompt assembly, reusable by any strategy.
export { projectTarget } from "./prompt/project-target.js";
export type { ProjectTargetOptions } from "./prompt/project-target.js";

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
} from "./strategies/per-group.js";
export type {
  GroupOverride,
  GroupTargets,
  PerGroupOptions,
  PerGroupPlan,
} from "./strategies/per-group.js";

// Task 16 — the R1.6 instance-modeling strategy ladder: three tiers composed
// through `fallbackExtractor` so that the strongest strategy can fall back to
// weaker ones, with the accepted tier stamped on `usage.strategy`.
export { instanceLadder } from "./strategies/instance-ladder.js";
export type { InstanceLadderOptions } from "./strategies/instance-ladder.js";

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
} from "./gap-fill/gap-fill.js";
export type { AbstainedLeaf, GapFillOptions, GapFillTarget } from "./gap-fill/gap-fill.js";

// The gap-fill follow-up phase itself — the second phase of the
// `gapFillExtractor` preset, exported so a host can assemble and extend the
// phase list by hand (design `phased-extraction-design.md` §4.7).
export { gapFillPhase } from "./gap-fill/gap-fill-phase.js";
export type { GapFillPhaseOptions } from "./gap-fill/gap-fill-phase.js";

// The scoped-instance inventory phase — the first phase of the
// `scopedInstanceExtractor` port, exported (with the note key its roster
// crosses the phase boundary under) so a host can assemble and extend the
// phase list by hand.
export { inventoryPhase, rosterNoteKey } from "./scoped-instance/inventory-phase.js";
export type { InventoryPhaseOptions } from "./scoped-instance/inventory-phase.js";

// The scoped-instance fill phase — the second phase of the port: one job per
// `(group, piece, instance)`, recombined with `mergeGroupPieces`. Exported for
// the same hand-assembly a host may want.
export { fillPhase } from "./scoped-instance/fill-phase.js";
export type { FillPhaseOptions } from "./scoped-instance/fill-phase.js";

// The schema-retry combinator: wraps a base extractor with a bounded
// self-correction loop that feeds a `SchemaParseError` back to the model as
// conversation turns — the failed output as an assistant turn, the validation
// error as a user turn — never by touching the transcript.
export { schemaRetryExtractor } from "./strategies/schema-retry.js";
export type { SchemaRetryOptions } from "./strategies/schema-retry.js";

// Per-group prompt assembly: `buildGroupMessages` builds per-group chat messages
// (instructions + projected examples + transcript), and `projectExample` narrows
// a few-shot example to a single group's key. Exported for testing (R3 Task 4).
export {
  assertStopFinishReason,
  assertWireSafeSchemaName,
  buildGroupMessages,
  buildMessages,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
  projectExample,
} from "./prompt/extraction-common.js";

// The Task 9 inventory-pass extraction phase: one house-wide call that returns a
// roster of candidate instances per collection group, parsed through a supplied
// roster schema.
export { extractInventory } from "./scoped-instance/inventory.js";
export type { InventoryOptions } from "./scoped-instance/inventory.js";

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
} from "./scoped-instance/instance-fill.js";
export type {
  FillScope,
  PreparedGroup,
  Roster,
  RosterCandidate,
  ScopedFillOptions,
} from "./scoped-instance/instance-fill.js";

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
