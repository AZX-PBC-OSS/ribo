/**
 * @file The backends the eval runner can run against: the openai-compatible
 * endpoint and the two CLI backends.
 *
 * The openai-compatible factory builds the client over
 * `@azx/ribo-chat-openai`'s `openAiChat` — an OpenAI-compatible
 * `/chat/completions` dialect — with the base URL, the API key and the
 * `fetch` all injected. Nothing here authenticates: the credential lives in
 * the host's transport, and this package has no capacity to hold one.
 *
 * The CLI backends are the other two: they spawn the operator's own installed
 * `claude`/`codex` binary, under the operator's own login, with no credential
 * at all. The mapping from the flag's value to the transport's backend name
 * lives here, in ONE place, so the preflight and the chat construction can
 * never disagree about which binary a flag names.
 */
import { openAiChat } from "@azx/ribo-chat-openai";
import type { ChatClient } from "@azx/ribo-core";

import { cliChat } from "../cli-chat.js";
import type { CliBackendName } from "../cli-chat.js";

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

/**
 * The CLI backends the eval command accepts, spelled the way the `--backend`
 * flag spells them.
 *
 * The transport's own backend names are shorter (`"claude"`, `"codex"`); the
 * flag's values carry the `-cli` suffix so they cannot be confused with a
 * model id. The mapping between the two lives in {@link cliBackendNameFor}.
 */
export type EvalCliBackend = "claude-cli" | "codex-cli";

/** The flag's value → the transport's backend name → the binary it spawns. */
const CLI_BACKEND_NAMES: Record<EvalCliBackend, CliBackendName> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
};

/**
 * The transport's backend name for a CLI backend flag value.
 *
 * One mapping, used by both the preflight and the chat construction: the
 * binary a flag names is never decided twice.
 * @param backend - The flag's value.
 * @returns The transport's backend name — which is also the binary's name.
 */
export function cliBackendNameFor(backend: EvalCliBackend): CliBackendName {
  return CLI_BACKEND_NAMES[backend];
}

/**
 * Build the CLI backend's client.
 *
 * The client spawns the operator's installed binary; there is no credential to
 * inject and no endpoint to point at.
 * @param backend - The flag's value.
 * @returns The transport client.
 */
export function createCliBackendChat(backend: EvalCliBackend): ChatClient {
  return cliChat({ backend: cliBackendNameFor(backend) });
}
