/**
 * The chat transport seam — a THIN, provider-agnostic interface an extractor
 * calls to reach a chat-completions model. It lives in the adapter, NOT in
 * `ribo-core`: core stays LLM-free (a managed-endpoint extractor would not use a
 * `ChatClient` at all), and the transport is injected exactly as the transcriber
 * and connectivity probe are.
 *
 * The shape mirrors the OpenAI-compatible `/chat/completions` contract the Helix
 * proxy exposes (A2): a `model`, an ordered list of role-tagged `messages`, and a
 * `response_format` pinning structured JSON output to a JSON Schema. It is
 * deliberately the smallest slice that supports single-shot structured extraction
 * — no streaming, no tools, no temperature knobs — so a test can implement it with
 * a fake and neither the adapter nor `ribo-core` depends on a provider SDK.
 */

/** Chat roles used by single-shot extraction: the system prompt, few-shot turns, the transcript. */
export type ChatRole = "system" | "user" | "assistant";

/** One role-tagged message in a chat-completions request. */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/**
 * Structured-output directive: constrain the model to emit JSON conforming to
 * `json_schema.schema`. `strict: true` is the whole point — it is what makes the
 * endpoint reject a response that omits a key or adds one, which is why the schema
 * must carry no keywords strict mode forbids (`minimum`/`maximum`; see
 * `schema.ts`'s note on `confidence`).
 */
export interface ChatResponseFormat {
  readonly type: "json_schema";
  readonly json_schema: {
    readonly name: string;
    /** A JSON Schema object, e.g. the output of `z.toJSONSchema(schema)`. */
    readonly schema: Record<string, unknown>;
    readonly strict: true;
  };
}

/** A single chat-completions request: the model, the conversation, the output contract. */
export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly response_format: ChatResponseFormat;
  /**
   * Cap on generated tokens. **camelCase, deliberately**, even though
   * `response_format` beside it is snake_case: the wire field name depends on the
   * model (OpenAI's chat surface has moved to `max_completion_tokens`, and
   * `max_tokens` is the legacy spelling the current default still accepts). A seam
   * field that pinned one wire spelling would need widening again the first time a
   * model wants the other — so the seam carries the *intent* and the implementation
   * owns the wire spelling. `response_format` keeps its name: it is existing public
   * API and renaming it would be a breaking change for no gain.
   *
   * Validate at the point of use: a positive integer. `number` otherwise admits
   * `NaN`, `Infinity`, `0`, negatives and fractions, each of which becomes either a
   * silently-dropped field or an opaque HTTP 400 instead of a clear configuration
   * error.
   */
  readonly maxTokens?: number;
}

/** Why the model stopped generating. The three outcomes a truncation detector needs. */
export type ChatFinishReason = "stop" | "length" | "content_filter";

/** Token counts for a single completion, normalised out of the wire body. */
export interface ChatUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * What `complete` returns: the assistant message content (the JSON string), plus
 * the finish reason and token usage when the transport reports them.
 *
 * `finishReason` is **optional on the type** because making it required would break
 * every existing `ChatClient` implementation and turn a minor bump into a breaking
 * one. That means the type alone cannot promise truncation is always detected. The
 * promise is made by the implementations instead: {@link file://./openai-chat.ts}
 * must never return a completion with an absent `finishReason` — a response whose
 * `choices[0].finish_reason` is missing, non-string, or not one of the three known
 * members is a {@link ChatError} of kind `malformed-response`, not a completion with
 * the field left off. {@link file://../../ribo-adapter-snuggpro/acceptance/cli-chat.ts}
 * cannot truncate, so its inability to report a finish reason is sound. An optional
 * field that implementations are required to populate is a contract a reader cannot
 * infer from the type.
 */
export interface ChatCompletion {
  readonly content: string;
  readonly finishReason?: ChatFinishReason;
  readonly usage?: ChatUsage;
}

/** Per-call options — *how* this call is made, not *what* is being asked. */
export interface ChatCallOptions {
  /** Abort the call; implementations must stop work and reject with `ChatError.aborted`. */
  readonly signal?: AbortSignal;
}

/**
 * A chat-completions transport. One method: send a request, get the assistant's
 * message content back. Implementations own the wire concern (auth, base URL,
 * error status) — see {@link file://./openai-chat.ts}. Extractors own prompt
 * assembly and the trust boundary and never touch the network directly.
 */
export interface ChatClient {
  complete(request: ChatRequest, options?: ChatCallOptions): Promise<ChatCompletion>;
}

/**
 * Why a {@link ChatClient.complete} call failed. A single discriminant (`kind`)
 * rather than six subclasses: it supports exhaustive switching, does not multiply
 * types, and does not force `instanceof` chains.
 */
export type ChatErrorKind =
  | "transport" // fetch/spawn rejected — no response at all
  | "http" // a response arrived with a non-2xx status
  | "aborted" // the caller's signal fired
  | "malformed-response" // a response arrived but is not a usable completion
  | "refusal" // the model declined; a valid response, not a broken one
  | "unsupported"; // this client cannot honour something the request asked for

/**
 * The typed error every {@link ChatClient} implementation throws. Construct
 * through the static factories, not `new` — they are what make `status` present
 * exactly when `kind === "http"` and absent otherwise, so the invalid states
 * (`http` without a status, a status on `aborted`) are unconstructible at the call
 * site. `cause` is preserved (`Error`'s standard `cause`) — precisely what
 * flattening to a message string discards.
 */
export class ChatError extends Error {
  override readonly name = "ChatError";
  readonly kind: ChatErrorKind;
  /** Present exactly when `kind === "http"` — the factories enforce this. */
  declare readonly status?: number;

  private constructor(kind: ChatErrorKind, message: string, cause?: unknown, status?: number) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }

  /** fetch/spawn rejected — no response arrived at all. */
  static transport(message: string, cause?: unknown): ChatError {
    return new ChatError("transport", message, cause);
  }

  /** A response arrived with a non-2xx `status`. */
  static http(status: number, message: string, cause?: unknown): ChatError {
    return new ChatError("http", message, cause, status);
  }

  /** The caller's `AbortSignal` fired. */
  static aborted(message: string, cause?: unknown): ChatError {
    return new ChatError("aborted", message, cause);
  }

  /** A response arrived but is not a usable completion (unparseable body, no choice, …). */
  static malformed(message: string, cause?: unknown): ChatError {
    return new ChatError("malformed-response", message, cause);
  }

  /** The model declined; a well-formed response in which the model refused to answer. */
  static refusal(message: string): ChatError {
    return new ChatError("refusal", message);
  }

  /** This client cannot honour something the request asked for. */
  static unsupported(message: string): ChatError {
    return new ChatError("unsupported", message);
  }
}
