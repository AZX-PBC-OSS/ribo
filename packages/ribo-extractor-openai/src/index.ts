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

// The chat transport seam: the interface an extractor calls, and its request/response types.
export type {
  ChatClient,
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  ChatResponseFormat,
  ChatRole,
} from "./chat-client.js";
