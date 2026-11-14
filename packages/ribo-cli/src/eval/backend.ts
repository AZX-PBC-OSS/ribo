/**
 * @file The openai-compatible backend: the runner's transport factory.
 *
 * The factory builds the client over `@azx/ribo-chat-openai`'s
 * `openAiChat` — an OpenAI-compatible `/chat/completions` dialect — with the
 * base URL, the API key and the `fetch` all injected. Nothing here
 * authenticates: the credential lives in the host's transport, and this
 * package has no capacity to hold one.
 */
import { openAiChat } from "@azx/ribo-chat-openai";
import type { ChatClient } from "@azx/ribo-core";

/**
 * The openai-compatible backend's configuration.
 *
 * Every part of it is injected: the endpoint, the credential and the
 * `fetch` (a test's own stub, never the network).
 * @category Eval
 */
export interface OpenAiCompatibleChatOptions {
  /** The endpoint's base URL, without the trailing `/chat/completions`. */
  readonly baseUrl: string;
  /** The bearer token. The host's credential, never one of this package's. */
  readonly apiKey: string;
  /** The `fetch` to use. Defaults to the global one. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build the openai-compatible backend client.
 *
 * The returned client is core's `ChatClient` seam — the runner wraps it in the
 * capability core's presence phase asks for.
 * @param options - The endpoint, the credential and the optional `fetch`.
 * @returns The transport client.
 * @category Eval
 */
export function createOpenAiCompatibleChat(options: OpenAiCompatibleChatOptions): ChatClient {
  return openAiChat({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}
