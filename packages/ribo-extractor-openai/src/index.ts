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

// The OpenAI-compatible chat transport and its options.
export { openAiChat } from "./openai-chat.js";
export type { OpenAiChatOptions } from "./openai-chat.js";

// The chat transport seam: the interface an extractor calls, its request/response
// types, its call options, and the typed error its implementations throw.
// `ChatError` is a VALUE export (a class); the rest are types.
export { ChatError } from "./chat-client.js";
export type {
  ChatCallOptions,
  ChatClient,
  ChatCompletion,
  ChatErrorKind,
  ChatFinishReason,
  ChatMessage,
  ChatRequest,
  ChatResponseFormat,
  ChatRole,
  ChatUsage,
} from "./chat-client.js";
