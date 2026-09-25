/**
 * @file The public surface of `@azx/ribo-chat-helix`.
 *
 * The Helix platform LLM route transport: one `helixChat` factory over the
 * provider-neutral `/_api/llm/chat` route (which is **not** OpenAI-compatible),
 * implementing `@azx/ribo-core`'s `CapableChatClient` seam. It is a dialect
 * package — everything above the transport (the strategies, presets, schema
 * split, phases) lives in core and speaks the seam, so this package exists to
 * name the dialect and nothing else (ADR 0020, ADR 0029).
 *
 * Everything is injected — the token, the base URL, the registered `Origin`,
 * and (for tests) the `fetch` implementation. No secret is hardcoded, and the
 * package has no capacity to authenticate on a consumer's behalf.
 */
export { helixChat } from "./helix-chat.js";
export type { HelixChatOptions } from "./helix-chat.js";
