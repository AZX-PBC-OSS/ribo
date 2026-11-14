/**
 * @file The runner's chat wrapper: the injected transport, made capable.
 *
 * Core's presence phase asks for a `CapableChatClient` — one that names its
 * engine and can report whether it can serve a call — while a transport may
 * be a plain `ChatClient`. The runner builds the capability itself: a stable
 * engine id, and a capability that reports ready.
 *
 * The wrapper is where the engine id lands, so `usage.engine` says which
 * transport produced a case's fields. The id is a parameter rather than a
 * constant because the command can run against three transports: the
 * openai-compatible endpoint and the two CLI backends, whose engine ids are
 * the flag's own values. A client that is ALREADY capable is passed through
 * unchanged — it carries its own engine id, and re-wrapping it would replace
 * the id the caller chose with the default.
 */
import type { CapableChatClient, ChatClient } from "@azx/ribo-core";

/** The engine id an openai-compatible run's usage carries. */
export const EVAL_ENGINE_ID = "openai-compatible";

/** Is this client already capable — does it carry its own engine id? */
const isCapable = (chat: ChatClient | CapableChatClient): chat is CapableChatClient =>
  typeof (chat as CapableChatClient).capability === "function";

/**
 * Wrap a chat client in the capability core's presence phase requires.
 *
 * The wrapper adds the engine id and the capability; the call itself is
 * forwarded whole, so the caller's cancellation still reaches the transport.
 * An already-capable client is returned unchanged.
 * @param chat - The injected transport.
 * @param engineId - The engine id the run's usage carries. Defaults to the openai-compatible one.
 * @returns The capable client the strategies run against.
 * @category Eval
 */
export function asCapableChat(
  chat: ChatClient | CapableChatClient,
  engineId: string = EVAL_ENGINE_ID,
): CapableChatClient {
  if (isCapable(chat)) return chat;
  return {
    engine: engineId,
    capability: () => Promise.resolve({ status: "ready" }),
    complete: (request, options) => chat.complete(request, options),
  };
}
