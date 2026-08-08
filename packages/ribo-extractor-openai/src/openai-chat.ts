/**
 * A concrete {@link ChatClient} over an OpenAI-compatible `/chat/completions`
 * endpoint. This is what the playground uses when a key is configured and what
 * production points at the Helix proxy (which holds the real credential and keeps
 * `response_format` + the allowlist — A2).
 *
 * Everything is injected — the key, the base URL, and (for tests) the `fetch`
 * implementation. No secret is hardcoded. `fetch` is expressly allowed in this
 * headless adapter (AGENTS §4); it is used as the bare global, never
 * `window.fetch`.
 */

import {
  ChatError,
  type ChatCallOptions,
  type ChatClient,
  type ChatCompletion,
  type ChatFinishReason,
  type ChatRequest,
  type ChatUsage,
} from "./chat-client.js";

/** Config for {@link openAiChat}. */
export interface OpenAiChatOptions {
  /** Bearer token. Injected by the host — never read from a bundled constant. */
  readonly apiKey: string;
  /**
   * Base URL of the OpenAI-compatible API, WITHOUT the trailing `/chat/completions`
   * (e.g. `https://api.openai.com/v1`, or the Helix proxy base). A trailing slash
   * is tolerated.
   */
  readonly baseUrl: string;
  /** Override `fetch` (tests). Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/** The subset of the chat-completions response body this client reads. */
interface ChatCompletionBody {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: unknown; readonly refusal?: unknown };
    readonly finish_reason?: unknown;
  }>;
  readonly usage?: { readonly prompt_tokens?: unknown; readonly completion_tokens?: unknown };
}

/** The wire spelling for the token cap on the current default model. */
const MAX_TOKENS_WIRE_FIELD = "max_tokens";

/**
 * Build a {@link ChatClient} that POSTs to `${baseUrl}/chat/completions` with
 * bearer auth and returns `choices[0].message.content`.
 *
 * Error mapping: a `fetch` rejection is `transport`, an `AbortError` is `aborted`,
 * a non-2xx is `http` with the real status, and an unparseable body or a missing
 * choice/content is `malformed-response` — all as {@link ChatError} so the caller
 * switches on `kind` instead of reconstructing intent from prose. A Structured
 * Outputs refusal (`choices[0].message.refusal`) is `refusal`, not `malformed`:
 * the model produced a well-formed response in which it declined to answer.
 *
 * `finishReason` is always populated: a body whose `choices[0].finish_reason` is
 * missing, non-string, or not one of the three known members is a
 * `malformed-response`, never a completion with the field omitted — see the
 * guarantee on {@link ChatCompletion}.
 */
export function openAiChat({ apiKey, baseUrl, fetchImpl }: OpenAiChatOptions): ChatClient {
  const doFetch = fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    async complete(request: ChatRequest, options?: ChatCallOptions): Promise<ChatCompletion> {
      if (request.maxTokens !== undefined) {
        if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) {
          throw new Error(
            `openAiChat: maxTokens must be a positive integer (got ${String(request.maxTokens)})`,
          );
        }
      }

      // The seam carries intent (camelCase `maxTokens`); the wire spelling lives
      // here. Building the body explicitly, rather than spreading the request,
      // keeps the camelCase field off the wire.
      const wireBody: Record<string, unknown> = {
        model: request.model,
        messages: request.messages,
        response_format: request.response_format,
      };
      if (request.maxTokens !== undefined) {
        wireBody[MAX_TOKENS_WIRE_FIELD] = request.maxTokens;
      }

      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(wireBody),
          signal: options?.signal,
        });
      } catch (cause) {
        throw chatErrorFromFetch(cause, url);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw ChatError.http(
          response.status,
          `openAiChat: ${response.status} ${response.statusText} from ${url}` +
            (detail ? `: ${detail.slice(0, 500)}` : ""),
        );
      }

      let body: ChatCompletionBody;
      try {
        body = (await response.json()) as ChatCompletionBody;
      } catch (cause) {
        throw chatErrorFromFetch(cause, url, true);
      }

      const choice = body.choices?.[0];

      const refusal = choice?.message?.refusal;
      if (typeof refusal === "string" && refusal.length > 0) {
        throw ChatError.refusal(`openAiChat: model refused: ${refusal.slice(0, 200)}`);
      }

      const content = choice?.message?.content;
      if (typeof content !== "string") {
        throw ChatError.malformed(
          `openAiChat: response from ${url} had no choices[0].message.content string`,
        );
      }

      const finishReason = parseFinishReason(choice?.finish_reason);
      if (finishReason === undefined) {
        throw ChatError.malformed(
          `openAiChat: response from ${url} had an unrecognised or absent finish_reason: ` +
            JSON.stringify(choice?.finish_reason),
        );
      }

      const usage = parseUsage(body.usage);

      return { content, finishReason, usage };
    },
  };
}

/**
 * Map a `fetch`/`response.json()` rejection to a {@link ChatError}: an
 * `AbortError` (browser `DOMException` or Node's equivalent, both named
 * `"AbortError"`) is `aborted`; anything else is `transport` (for a fetch
 * rejection) or `malformed-response` (for an unparseable body). The `parse` flag
 * selects which, since the same catch site serves both.
 */
function chatErrorFromFetch(cause: unknown, url: string, parse = false): ChatError {
  if (cause instanceof Error && cause.name === "AbortError") {
    return ChatError.aborted(`openAiChat: request to ${url} was aborted`, cause);
  }
  return parse
    ? ChatError.malformed(`openAiChat: response from ${url} was not valid JSON`, cause)
    : ChatError.transport(`openAiChat: request to ${url} failed`, cause);
}

/** Recognise the three known finish reasons; anything else is `undefined` (→ malformed). */
function parseFinishReason(raw: unknown): ChatFinishReason | undefined {
  if (raw === "stop") return "stop";
  if (raw === "length") return "length";
  if (raw === "content_filter") return "content_filter";
  return undefined;
}

/** Normalise the wire `usage` object into {@link ChatUsage}; `undefined` if absent or malformed. */
function parseUsage(raw: ChatCompletionBody["usage"]): ChatUsage | undefined {
  if (raw && typeof raw.prompt_tokens === "number" && typeof raw.completion_tokens === "number") {
    return { promptTokens: raw.prompt_tokens, completionTokens: raw.completion_tokens };
  }
  return undefined;
}
