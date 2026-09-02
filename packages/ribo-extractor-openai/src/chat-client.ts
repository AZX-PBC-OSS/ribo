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
  /**
   * Prompt tokens served from the provider's prefix cache, when it reports them.
   *
   * Optional because most transports do not report it: a fake in a test, an
   * on-device engine with no cache, and any endpoint whose response omits the
   * field. Absent means "not reported", never "zero" — a cache miss reports `0`,
   * and telling those apart is the whole point of carrying it.
   *
   * Load-bearing for a real question: extraction sends the same instructions and
   * few-shot example on every group call, so whether the prefix is being cached
   * decides what that example actually costs in production. Without this the
   * answer is unobservable from the field — `helixChat` used to parse the route's
   * `cacheReadInputTokens` and throw it away for want of somewhere to put it.
   */
  readonly cachedPromptTokens?: number;
  /**
   * Prompt tokens written INTO the prefix cache by this call, when reported.
   *
   * Distinct from {@link cachedPromptTokens} because the two are priced
   * differently and mean opposite things: a cache write is the cost of the first
   * call with a given prefix, a cache read is the saving on every one after it.
   * Collapsing them would make a warm run indistinguishable from a cold one.
   */
  readonly cacheCreationPromptTokens?: number;
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
 * Why a chat engine cannot run.
 *
 * A closed set on purpose: a UI has to branch on this, and free-text reasons make that
 * impossible. The human-readable part lives in `detail`, which is required precisely so a reason
 * code never has to carry nuance it cannot express.
 *
 * **A plain union, not the `as const` array + `(typeof X)[number]` shape** that
 * `TranscriberUnavailableReason` uses in `ribo-core`. That shape exists to produce a *runtime*
 * array, and it earns that there: `PERMANENT_TRANSCRIBER_UNAVAILABLE_REASONS` is a subset the
 * code iterates with `.includes()` to decide whether a verdict is permanent. Nothing here needs
 * the list at runtime, so the array would be an unused constant on a published package's API
 * surface and the indirection would buy nothing.
 *
 * If a permanence predicate ever arrives — a composite caching an `unavailable` forever rather
 * than on the capability TTL, which is exactly what `firstCapable` does — reintroduce the array
 * then, when it has a caller.
 */
export type ChatUnavailableReason =
  /** The device or browser cannot run this engine at all — e.g. no Prompt API. */
  | "unsupported-platform"
  /** It needs the network and there is none. The managed path's normal failure. */
  | "offline"
  /** Missing endpoint, key or user consent. Nothing is wrong with the device. */
  | "not-configured"
  /** Weights or runtime binaries are not on the device and could not be fetched. */
  | "model-unavailable"
  /** The probe itself failed in a way this vocabulary does not describe. */
  | "unknown";

/**
 * What a chat engine can do **right now**.
 *
 * Three states rather than a boolean, because `needs-download` and `unavailable`
 * produce completely different screens: "capable, but a download has to finish
 * first" against "this cannot run here, and here is why". Collapsing them into
 * `available: false` is what makes a download UI impossible to write.
 *
 * Availability is dynamic in **both** directions: on-device becomes `ready` after a
 * download finishes, and the managed path becomes `unavailable` the moment the
 * uplink drops. Nothing may treat this as a value read once at init.
 *
 * Mirrors {@link TranscriberCapability} in `ribo-core/src/transcriber.ts` with one
 * intentional difference: `needs-download` carries **no byte count**. The Prompt
 * API reports progress as a 0..1 fraction and `total` is always 1, so no real size
 * is available; inventing a number would make the consent screen dishonest. Use
 * `detail` for human-readable context instead.
 */
export type ChatCapability =
  | {
      /** Can serve a call now, with no further fetching and no further consent. */
      readonly status: "ready";
    }
  | {
      /**
       * Capable of running here, but weights must be fetched first.
       *
       * A selection combinator must **never** pick this on its own: the fetch needs
       * a user gesture and a human's agreement, and a queue drain is not the place
       * either can be obtained.
       *
       * No `downloadBytes` field is present here. The underlying API reports progress
       * as a 0..1 fraction with `total` always 1, so no byte count exists; adding one
       * would be fabricated. The UI should show a bare percentage and explain that
       * the size is unknown and the wait is minutes.
       */
      readonly status: "needs-download";
      /** What is being downloaded, e.g. `"Chrome-managed language model"`. */
      readonly detail?: string;
    }
  | {
      /** Cannot run. */
      readonly status: "unavailable";
      readonly reason: ChatUnavailableReason;
      /** Human-readable specifics. Required — a reason code with no detail is unactionable. */
      readonly detail: string;
    };

/**
 * A {@link ChatClient} that can also report whether it can run right now.
 *
 * Both the managed and on-device transports implement this: the managed path may
 * become unavailable when the uplink drops, and the on-device path may need a
 * download or may be unsupported. Keeping the contract here, at the transport seam,
 * avoids a dependency cycle: the on-device package depends on this package, so it
 * cannot export a type that `helixChat` and the composite extractor (both here)
 * need to consume.
 */
export interface CapableChatClient extends ChatClient {
  /**
   * Stable, opaque id for this engine. Goes into extraction provenance so it ends
   * up persisted in the outbox — keep it short and stable across versions.
   */
  readonly engine: string;

  /**
   * What this engine can do right now.
   *
   * **Expected to be called often and expected to be cheap.** Implementations that
   * probe something expensive (a model availability check, a network reachability
   * test) should memoize internally; a selection combinator additionally caches the
   * answer so a queue drain of many extractions does not re-probe many times. Both
   * layers are deliberate — an implementation used bare still needs to be cheap.
   *
   * Rejecting is allowed and is treated as `unavailable` with reason `"unknown"`;
   * a probe is not permitted to take the caller down.
   */
  capability(): Promise<ChatCapability>;
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
