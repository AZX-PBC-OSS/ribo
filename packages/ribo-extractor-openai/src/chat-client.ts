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
}

/** What `complete` returns: just the assistant message content (the JSON string). */
export interface ChatCompletion {
  readonly content: string;
}

/**
 * A chat-completions transport. One method: send a request, get the assistant's
 * message content back. Implementations own the wire concern (auth, base URL,
 * error status) — see {@link file://./openai-chat.ts}. Extractors own prompt
 * assembly and the trust boundary and never touch the network directly.
 */
export interface ChatClient {
  complete(request: ChatRequest): Promise<ChatCompletion>;
}
