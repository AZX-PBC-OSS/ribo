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
export { splitExtractionSchema } from "./split-schema.js";
export type { ExtractionGroup } from "./split-schema.js";

// The per-group managed-LLM extractor (R3 Task 2) — one chat call per top-level
// group, concurrently with a bounded pool, assembled into one result. The
// sibling of `singleShotExtractor`; same `Extractor` seam.
export { perGroupExtractor } from "./per-group.js";
export type { PerGroupOptions } from "./per-group.js";

// Per-group prompt assembly: `buildGroupMessages` builds per-group chat messages
// (instructions + projected examples + transcript), and `projectExample` narrows
// a few-shot example to a single group's key. Exported for testing (R3 Task 4).
export { buildGroupMessages, projectExample } from "./extraction-common.js";

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
export { ChatError, CHAT_UNAVAILABLE_REASONS } from "./chat-client.js";
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
