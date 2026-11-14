/**
 * @file The runner's chat wrapper: the injected transport, made capable.
 *
 * Core's presence phase asks for a `CapableChatClient` — one that names its
 * engine and can report whether it can serve a call — while the openai-
 * compatible transport is a plain `ChatClient`. The runner builds the
 * capability itself: a stable engine id, and a capability that reports ready.
 *
 * The wrapper is where the engine id lands, so `usage.engine` says which
 * transport produced a case's fields.
 */
import type { CapableChatClient, ChatClient } from "@azx/ribo-core";

/** The engine id every run's usage carries — the openai-compatible transport. */
export const EVAL_ENGINE_ID = "openai-compatible";

/**
 * Wrap a chat client in the capability core's presence phase requires.
 *
 * The wrapper adds the engine id and the capability; the call itself is
 * forwarded whole, so the caller's cancellation still reaches the transport.
 * @param chat - The injected transport.
 * @returns The capable client the strategies run against.
 * @category Eval
 */
export function asCapableChat(chat: ChatClient): CapableChatClient {
  return {
    engine: EVAL_ENGINE_ID,
    capability: () => Promise.resolve({ status: "ready" }),
    complete: (request, options) => chat.complete(request, options),
  };
}
