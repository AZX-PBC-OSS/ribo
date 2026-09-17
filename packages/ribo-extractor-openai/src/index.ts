/**
 * @file The public surface of `@azx/ribo-extractor-openai`.
 *
 * A tool-agnostic extractor plasmid: the single-shot managed-LLM strategy and its
 * OpenAI-compatible chat transport. It works against any `ExtractionTarget<F>` from
 * `@azx/ribo-core`, so it lives outside every tool adapter — a SnuggPro adapter, a
 * future adapter, or a test target all wire the same extractor. Re-exports only.
 */

// The single-shot managed-LLM extractor (the built default) and its options.
export { singleShotExtractor } from "./single-shot.js";
export type { SingleShotOptions } from "./single-shot.js";

// The per-group schema split — the pure, model-free half of R3. Takes a target's
// `extractionSchema` and returns one entry per top-level group (or one fallback
// entry covering the whole schema). The per-group extractor consumes this.
export { MAX_NULLABLE_UNIONS_PER_CALL, splitExtractionSchema } from "./split-schema.js";
export type { ExtractionGroup } from "./split-schema.js";

// Projection of an extraction target onto one top-level group key — the pure
// narrow half of per-group prompt assembly, reusable by any strategy.
export { projectTarget } from "./project-target.js";
export type { ProjectTargetOptions } from "./project-target.js";

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
} from "./per-group.js";
export type { GroupOverride, GroupTargets, PerGroupOptions, PerGroupPlan } from "./per-group.js";

// Task 16 — the R1.6 instance-modeling strategy ladder: three tiers composed
// through `fallbackExtractor` so that the strongest strategy can fall back to
// weaker ones, with the accepted tier stamped on `usage.strategy`.
export { instanceLadder } from "./instance-ladder.js";
export type { InstanceLadderOptions } from "./instance-ladder.js";

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
} from "./gap-fill.js";
export type { AbstainedLeaf, GapFillOptions, GapFillTarget } from "./gap-fill.js";

// The gap-fill follow-up phase itself — the second phase of the
// `gapFillExtractor` preset, exported so a host can assemble and extend the
// phase list by hand (design `phased-extraction-design.md` §4.7).
export { gapFillPhase } from "./gap-fill-phase.js";
export type { GapFillPhaseOptions } from "./gap-fill-phase.js";

// The scoped-instance inventory phase — the first phase of the
// `scopedInstanceExtractor` port, exported (with the note key its roster
// crosses the phase boundary under) so a host can assemble and extend the
// phase list by hand.
export { inventoryPhase, rosterNoteKey } from "./inventory-phase.js";
export type { InventoryPhaseOptions } from "./inventory-phase.js";

// The schema-retry combinator: wraps a base extractor with a bounded
// self-correction loop that feeds a `SchemaParseError` back to the model as
// conversation turns — the failed output as an assistant turn, the validation
// error as a user turn — never by touching the transcript.
export { schemaRetryExtractor } from "./schema-retry.js";
export type { SchemaRetryOptions } from "./schema-retry.js";

// Per-group prompt assembly: `buildGroupMessages` builds per-group chat messages
// (instructions + projected examples + transcript), and `projectExample` narrows
// a few-shot example to a single group's key. Exported for testing (R3 Task 4).
export {
  assertStopFinishReason,
  buildGroupMessages,
  buildMessages,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
  projectExample,
} from "./extraction-common.js";

// The Task 9 inventory-pass extraction phase: one house-wide call that returns a
// roster of candidate instances per collection group, parsed through a supplied
// roster schema.
export { extractInventory } from "./inventory.js";
export type { InventoryOptions } from "./inventory.js";

// Task 10 — scoped per-instance fills and assembly: one inventory call followed by
// one fill call per current instance, with a scope block that names siblings and
// excluded candidates. Exports the extractor, prompt assembly helpers, and the
// generic roster/fill-scope types that the adapter's `buildFillInstructions` consumes.
export { buildFillMessages, projectFillExample, scopedInstanceExtractor } from "./instance-fill.js";
export type { FillScope, Roster, RosterCandidate, ScopedFillOptions } from "./instance-fill.js";

// The OpenAI-compatible chat transport and its options.
export { openAiChat } from "./openai-chat.js";
export type { OpenAiChatOptions } from "./openai-chat.js";

// The Helix platform LLM route transport and its options — a second
// `ChatClient` beside `openAiChat`, for the provider-neutral `/_api/llm/chat`
// route (not OpenAI-compatible).
export { helixChat } from "./helix-chat.js";
export type { HelixChatOptions } from "./helix-chat.js";

// The chat transport seam: the interface an extractor calls, its request/response
// types, its call options, and the typed error its implementations throw.
// `ChatError` is a VALUE export (a class); the rest are types.
export { ChatError } from "./chat-client.js";
export type {
  ChatCallOptions,
  ChatCapability,
  ChatClient,
  CapableChatClient,
  ChatCompletion,
  ChatErrorKind,
  ChatFinishReason,
  ChatUnavailableReason,
  ChatMessage,
  ChatRequest,
  ChatResponseFormat,
  ChatRole,
  ChatUsage,
} from "./chat-client.js";
