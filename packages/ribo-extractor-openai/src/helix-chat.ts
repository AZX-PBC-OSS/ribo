/**
 * A concrete {@link ChatClient} over the Helix platform LLM route
 * (`POST <base>/_api/llm/chat`). The route is provider-neutral and **not**
 * OpenAI-compatible — a system message becomes a top-level `system` field, the
 * response is a flat `{ model, content, stopReason, usage }`, and the route
 * defaults to SSE so we force `stream: false` for one JSON body.
 *
 * Everything is injected — the token, the base URL, the registered `Origin`,
 * and (for tests) the `fetch` implementation. No secret is hardcoded. `fetch`
 * is expressly allowed in this headless adapter (AGENTS §4); it is used as the
 * bare global, never `window.fetch`.
 */

import type { ConnectivitySource, ConnectivityStatus } from "@azx/ribo-core";
import {
  ChatError,
  type CapableChatClient,
  type ChatCallOptions,
  type ChatCapability,
  type ChatCompletion,
  type ChatFinishReason,
  type ChatRequest,
  type ChatUsage,
} from "./chat-client.js";

/** Config for {@link helixChat}. */
export interface HelixChatOptions {
  /** Bearer token. Injected by the host — never read from a bundled constant. */
  readonly token: string;
  /**
   * Base URL of the Helix gateway, WITHOUT the trailing `/_api/llm/chat`
   * (e.g. `https://dev-api.azx.helix.azxlabs.io/<slug>`, or `""` for same-origin
   * in a deployed app where the edge serves `/_api/*` on the app's own origin).
   * A trailing slash is tolerated.
   */
  readonly baseUrl: string;
  /**
   * The `Origin` header value. The route checks this against the origins
   * registered for the dev token and returns `403 forbidden` /
   * `origin is not registered for this dev token` when it does not match.
   * Pass `undefined` in a deployed app where the edge derives the origin from
   * the session and the header is not needed.
   */
  readonly origin?: string;
  /** Override `fetch` (tests). Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Live connectivity model. When absent, the managed path is assumed ready,
   * preserving today's unconditional behaviour. When present, capability is
   * derived from its subscription — not a snapshot at construction — so a dead
   * uplink is recognised as soon as the model does.
   */
  readonly connectivity?: ConnectivitySource;
}

/** The subset of the Helix non-streaming response body this client reads. */
interface HelixChatResponseBody {
  readonly content?: unknown;
  readonly stopReason?: unknown;
  readonly usage?: {
    readonly inputTokens?: unknown;
    readonly outputTokens?: unknown;
    // The route caches the prompt prefix. These now reach `ChatUsage` as
    // `cachedPromptTokens` / `cacheCreationPromptTokens` — they used to be
    // parsed and discarded, which made "is the cache working" unanswerable from
    // the field. Note the prefix is per-GROUP (the system message is built by
    // `groupInstructions(key)`), so the seven calls of one extraction do not
    // share a prefix; the sharing is across sessions, for the same group.
    readonly cacheReadInputTokens?: unknown;
    readonly cacheCreationInputTokens?: unknown;
  };
}

/** The subset of a Helix error body this client reads for actionable messages. */
interface HelixErrorBody {
  readonly code?: unknown;
  readonly message?: unknown;
}

/**
 * Build a {@link ChatClient} that POSTs to `${baseUrl}/_api/llm/chat` with
 * bearer auth and an `Origin` header, and returns `content` from the
 * non-streaming JSON body.
 *
 * Request mapping: a `role: "system"` message becomes the top-level `system`
 * field (NOT a message); all other messages go into `messages` with roles
 * `user`/`assistant` only. `response_format` is flattened to `responseFormat`
 * (`{ type, name, schema }` — `strict` is dropped: the platform always enforces
 * the schema). `stream: false` is always sent because the route defaults to SSE.
 *
 * Error mapping: a `fetch` rejection is `transport`, an `AbortError` is
 * `aborted`, a non-2xx is `http` with the real status, and an unparseable body
 * or a missing `content` is `malformed-response` — all as {@link ChatError} so
 * the caller switches on `kind`. A `403 model_not_allowed` and a `400
 * validation_failed` on `responseFormat.schema` are named in the message: the
 * platform rejects schemas outside its strict subset, and a caller needs to
 * know it is the schema, not the request. A `403 forbidden` names origin
 * registration — the diagnostic a developer hits first when wiring the dev
 * gateway.
 *
 * `finishReason` is always populated: a body whose `stopReason` is missing,
 * non-string, or not one of the known members is a `malformed-response`, never
 * a completion with the field omitted — see the guarantee on
 * {@link ChatCompletion}. `"max_tokens"` maps to `"length"` so the existing
 * truncation guard keeps working (`assertStopFinishReason` treats `"length"` as
 * a `TerminalQueueError`); `"end_turn"` maps to `"stop"`.
 */
export function helixChat({
  token,
  baseUrl,
  origin,
  fetchImpl,
  connectivity,
}: HelixChatOptions): CapableChatClient {
  const doFetch = fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/+$/, "")}/_api/llm/chat`;

  // Track the latest connectivity status through a live subscription. A
  // construction-time snapshot would go stale the moment the uplink dropped,
  // causing the selector to keep choosing a dead managed path.
  let connectivityStatus: ConnectivityStatus = "offline";
  if (connectivity) {
    connectivity.subscribe((state) => {
      connectivityStatus = state.status;
    });
  }

  return {
    engine: "helix",
    async capability(): Promise<ChatCapability> {
      if (!connectivity || connectivityStatus === "online") {
        return { status: "ready" };
      }
      if (connectivityStatus === "offline") {
        return {
          status: "unavailable",
          reason: "offline",
          detail: "The uplink is offline; Helix extraction cannot reach the managed model.",
        };
      }
      return {
        status: "unavailable",
        reason: "offline",
        detail: "The uplink is still being checked; Helix extraction is not ready.",
      };
    },
    async complete(request: ChatRequest, options?: ChatCallOptions): Promise<ChatCompletion> {
      if (request.maxTokens !== undefined) {
        if (!Number.isInteger(request.maxTokens) || request.maxTokens <= 0) {
          throw new Error(
            `helixChat: maxTokens must be a positive integer (got ${String(request.maxTokens)})`,
          );
        }
      }

      // System messages become the top-level `system` field; all others go
      // into `messages` with roles `user`/`assistant` only. The seam allows
      // multiple system messages; concatenate them — the route has one field.
      let system: string | undefined;
      const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
      for (const msg of request.messages) {
        if (msg.role === "system") {
          system = system === undefined ? msg.content : `${system}\n${msg.content}`;
        } else {
          messages.push({ role: msg.role, content: msg.content });
        }
      }

      // The seam carries `response_format: { type, json_schema: { name, schema,
      // strict } }`. The Helix wire flattens this to `responseFormat:
      // { type, name, schema }` — `strict` is implied (the platform always
      // enforces; there is no best-effort mode), so it is dropped.
      const wireBody: Record<string, unknown> = {
        model: request.model,
        messages,
        stream: false,
        responseFormat: {
          type: request.response_format.type,
          name: request.response_format.json_schema.name,
          schema: request.response_format.json_schema.schema,
        },
      };
      if (system !== undefined) {
        wireBody.system = system;
      }
      if (request.maxTokens !== undefined) {
        wireBody.maxTokens = request.maxTokens;
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      };
      if (origin !== undefined) {
        headers.origin = origin;
      }

      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(wireBody),
          signal: options?.signal,
        });
      } catch (cause) {
        throw chatErrorFromFetch(cause, url);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw httpError(response.status, response.statusText, url, detail, origin);
      }

      let body: HelixChatResponseBody;
      try {
        body = (await response.json()) as HelixChatResponseBody;
      } catch (cause) {
        throw chatErrorFromFetch(cause, url, true);
      }

      const content = body.content;
      if (typeof content !== "string") {
        throw ChatError.malformed(`helixChat: response from ${url} had no content string`);
      }

      const finishReason = parseStopReason(body.stopReason);
      if (finishReason === undefined) {
        throw ChatError.malformed(
          `helixChat: response from ${url} had an unrecognised or absent stopReason: ` +
            JSON.stringify(body.stopReason),
        );
      }

      const usage = parseUsage(body.usage);

      return { content, finishReason, usage };
    },
  };
}

/**
 * Build an `http` {@link ChatError} with an actionable message. The route
 * returns `{ code, message }` for known failures; naming the code helps a
 * caller see that a `403 model_not_allowed` is a missing model grant, not a
 * transport fault, and that a `400 validation_failed` is the schema, not the
 * request. A `403` also names origin registration — the diagnostic a
 * developer hits first when wiring the dev gateway.
 */
function httpError(
  status: number,
  statusText: string,
  url: string,
  detail: string,
  origin?: string,
): ChatError {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const parsed = JSON.parse(detail) as HelixErrorBody;
    if (typeof parsed.code === "string") code = parsed.code;
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // not JSON — keep the raw body as the detail
  }

  const label = code ? ` [${code}]` : "";
  const body = message ?? detail;
  let hint = "";
  if (code === "model_not_allowed") {
    hint = " — the model is not in capabilities.llm.models";
  } else if (code === "validation_failed") {
    hint = " — the platform rejected responseFormat.schema (strict subset only)";
  } else if (status === 403) {
    hint = origin
      ? ` — check that Origin ${origin} is registered for this dev token`
      : " — check that the origin is registered for this dev token";
  }

  return ChatError.http(
    status,
    `helixChat: ${status} ${statusText}${label} from ${url}` +
      (body ? `: ${body.slice(0, 500)}` : "") +
      hint,
  );
}

/**
 * Map a `fetch`/`response.json()` rejection to a {@link ChatError}: an
 * `AbortError` (browser `DOMException` or Node's equivalent, both named
 * `"AbortError"`) is `aborted`; anything else is `transport` (for a fetch
 * rejection) or `malformed-response` (for an unparseable body). The `parse`
 * flag selects which, since the same catch site serves both.
 */
function chatErrorFromFetch(cause: unknown, url: string, parse = false): ChatError {
  if (cause instanceof Error && cause.name === "AbortError") {
    return ChatError.aborted(`helixChat: request to ${url} was aborted`, cause);
  }
  return parse
    ? ChatError.malformed(`helixChat: response from ${url} was not valid JSON`, cause)
    : ChatError.transport(`helixChat: request to ${url} failed`, cause);
}

/**
 * Recognise the known stop reasons; anything else is `undefined` (→ malformed).
 * `"max_tokens"` maps to `"length"` so the truncation guard keeps working;
 * `"end_turn"` maps to `"stop"`.
 */
function parseStopReason(raw: unknown): ChatFinishReason | undefined {
  if (raw === "end_turn") return "stop";
  if (raw === "max_tokens") return "length";
  if (raw === "content_filter") return "content_filter";
  return undefined;
}

/**
 * Normalise the wire `usage` object into {@link ChatUsage}; `undefined` if
 * absent or malformed. `inputTokens`/`outputTokens` map to
 * `promptTokens`/`completionTokens`. The route also carries cache token counts
 * (see {@link HelixChatResponseBody}); the seam has nowhere for those, so they
 * are dropped here.
 */
function parseUsage(raw: HelixChatResponseBody["usage"]): ChatUsage | undefined {
  if (raw && typeof raw.inputTokens === "number" && typeof raw.outputTokens === "number") {
    const read = raw.cacheReadInputTokens;
    const created = raw.cacheCreationInputTokens;
    return {
      promptTokens: raw.inputTokens,
      completionTokens: raw.outputTokens,
      ...(typeof read === "number" ? { cachedPromptTokens: read } : {}),
      ...(typeof created === "number" ? { cacheCreationPromptTokens: created } : {}),
    };
  }
  return undefined;
}
