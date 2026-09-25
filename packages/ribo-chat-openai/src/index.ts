/**
 * @file The public surface of `@azx/ribo-chat-openai`.
 *
 * The OpenAI-compatible chat transport: one `openAiChat` factory over an
 * injected `fetch`, implementing `@azx/ribo-core`'s `ChatClient` seam. It is a
 * dialect package — everything above the transport (the strategies, presets,
 * schema split, phases) lives in core and speaks the seam, so this package
 * exists to name the dialect and nothing else (ADR 0020, ADR 0029).
 *
 * Everything is injected — the key, the base URL, and (for tests) the `fetch`
 * implementation. No secret is hardcoded, and the package has no capacity to
 * authenticate on a consumer's behalf.
 */
export { openAiChat } from "./openai-chat.js";
export type { OpenAiChatOptions } from "./openai-chat.js";
