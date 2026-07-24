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

import type { ChatClient, ChatCompletion, ChatRequest } from "./chat-client.js";

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
  readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: unknown } }>;
}

/**
 * An HTTP error carrying the response `status`, so `ribo-core`'s
 * `isTransientFailure` can classify it: 5xx/429/408 retry, other 4xx are terminal.
 */
class OpenAiHttpError extends Error {
  override readonly name = "OpenAiHttpError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Build a {@link ChatClient} that POSTs to `${baseUrl}/chat/completions` with
 * bearer auth and returns `choices[0].message.content`.
 *
 * A non-2xx response throws an {@link OpenAiHttpError} with its status attached
 * (transient/terminal is then the queue's call). A 2xx body missing the message
 * content throws a plain `Error` — transient by default, since a well-formed retry
 * may succeed.
 */
export function openAiChat({ apiKey, baseUrl, fetchImpl }: OpenAiChatOptions): ChatClient {
  const doFetch = fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    async complete(request: ChatRequest): Promise<ChatCompletion> {
      const response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new OpenAiHttpError(
          response.status,
          `openAiChat: ${response.status} ${response.statusText} from ${url}` +
            (detail ? `: ${detail.slice(0, 500)}` : ""),
        );
      }

      const body = (await response.json()) as ChatCompletionBody;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error(
          `openAiChat: response from ${url} had no choices[0].message.content string`,
        );
      }
      return { content };
    },
  };
}
