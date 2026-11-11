/**
 * The scripted chat client — the `ChatClient` counterpart to `FakeExtractor` and
 * `FakeTranscriber`. Until this module there was no shipped way to drive ribo's chat-based
 * extractors (`singleShotExtractor`, `perGroupExtractor`, the phased strategies, …) without a
 * real model: every test and docs example hand-built an ad-hoc `ChatClient` object. This is the
 * shipped, documented double — not test scaffolding — so examples and consumer tests can drive
 * chat-based extraction deterministically and assert on exactly what was sent.
 *
 * There is deliberately **no rule list and no matching DSL**: `respond` is either one fixed
 * reply for every call or a plain callback, and matching on schema name, call number or message
 * content is the caller's own code inside that callback. Anything a matcher could express, the
 * callback expresses with less API to learn.
 *
 * Failure modelling follows the transport's own vocabulary: to fail a call, throw — a thrown
 * {@link ChatError} reaches arbitration (`fallbackExtractor`, `terminalFallsThrough`, retry
 * logic) unchanged, exactly as a real transport's would, and any other thrown value propagates
 * unwrapped too. Abort behaviour is the standard one: `ChatError.aborted`, carrying the
 * `CANCELLATION` brand (`cancellation.ts`), rejected before the callback runs for an
 * already-aborted signal and promptly mid-delay for one that fires later.
 *
 * Capability is runtime-controllable but **poll-based**, matching `CapableChatClient`'s own
 * contract: `setCapability()` changes what subsequent `capability()` calls return, and nothing
 * else is notified — the contract defines no subscription mechanism. `complete` deliberately
 * does not consult the capability: a probe that answered optimistically while calls fail is a
 * real-world case this double exists to model (the `FakeTranscriber` idiom).
 */

import { ChatError } from "./chat-client.js";
import type {
  CapableChatClient,
  ChatCapability,
  ChatCompletion,
  ChatFinishReason,
  ChatRequest,
  ChatUsage,
} from "./chat-client.js";

/**
 * What one call replies with.
 *
 * A plain string is shorthand for `{ content: string }`. Non-string `content` — an object or
 * array — is serialised with `JSON.stringify`, so a scripted reply can be written as the
 * literal structured value the model was supposedly constrained to emit rather than as a
 * hand-stringified JSON string.
 */
export type ScriptedChatReply =
  | string
  | {
      /** The assistant message content: a string as-is, or an object/array serialised with `JSON.stringify`. */
      content: string | object;
      /** Why the model stopped. Defaults to `"stop"` — a truncation test names `"length"` explicitly. */
      finishReason?: ChatFinishReason;
      /** Token counts echoed onto the completion, for tests that assert usage accounting. */
      usage?: ChatUsage;
      /**
       * Milliseconds to wait before resolving — a latency simulation. Aborting the call's
       * signal during the wait rejects promptly with `ChatError.aborted`, not at delay end.
       * Zero, negative, `NaN` and infinite values mean no delay.
       */
      delay?: number;
    };

/** The second argument to a callback responder: where this call sits and how it is cancelled. */
export interface ScriptedChatContext {
  /**
   * The zero-based number of this call, assigned at record time — the same position this
   * request occupies in `calls`. `reset()` restarts the numbering at zero so the two stay
   * positionally aligned across a reset.
   */
  readonly call: number;
  /** The signal this call was passed in `ChatCallOptions`, or `undefined` when none was. */
  readonly signal: AbortSignal | undefined;
}

/**
 * The `respond` argument: one fixed reply used for every call, or a per-call callback.
 *
 * The callback receives the request as sent and a {@link ScriptedChatContext}, and may return
 * or promise a {@link ScriptedChatReply}. To fail the call it throws — a thrown `ChatError`
 * passes through unchanged, so arbitration sees exactly what a real transport would throw.
 */
export type ScriptedChatResponder =
  | ScriptedChatReply
  | ((
      request: ChatRequest,
      context: ScriptedChatContext,
    ) => ScriptedChatReply | Promise<ScriptedChatReply>);

/** Options for {@link scriptedChat}. All optional. */
export interface ScriptedChatOptions {
  /**
   * The engine id this client reports. Defaults to `"scripted"`. Override it when the double
   * stands in for a real engine and the id ends up in extraction provenance — the same reason
   * `FakeTranscriber` takes an `engine`.
   */
  engine?: string;
  /** The capability `capability()` reports until `setCapability` changes it. Defaults to `{ status: "ready" }`. */
  capability?: ChatCapability;
}

/**
 * A {@link CapableChatClient} whose replies are scripted, with the inspection surface a test or
 * example needs: every request recorded, the capability mutable at runtime, and a reset back to
 * the constructed state.
 */
export interface ScriptedChatClient extends CapableChatClient {
  /**
   * Every request as sent, in call order — including calls whose callback threw and calls
   * rejected by an already-aborted signal. Recording happens before the reply is produced, so
   * a failed call is still inspected. `reset()` clears it.
   */
  readonly calls: readonly ChatRequest[];

  /**
   * Change what `capability()` reports, from now on. Chainable, the `FakeTranscriber` idiom.
   * Poll-based by the contract's own shape: subsequent `capability()` calls observe the new
   * value; there is no subscription to notify.
   */
  setCapability: (capability: ChatCapability) => ScriptedChatClient;

  /**
   * Clear `calls`, restore the capability the client was constructed with, and restart the
   * callback's call numbering at zero — so `calls` and the `context.call` argument stay
   * positionally aligned across a reset.
   */
  reset: () => void;
}

/**
 * Build a {@link CapableChatClient} that replies from a script — the chat-transport
 * counterpart to `FakeExtractor` and `FakeTranscriber`.
 *
 * Pass a fixed reply for a client that answers the same thing every call, or a callback for
 * per-call behaviour: dispatching on `request.responseFormat.json_schema.name` (the extraction
 * target's name), asserting on what the extractor sent, failing the Nth call, simulating
 * latency with `delay`. Every request is recorded on `calls`, in order, before the reply is
 * produced — failed and aborted calls included.
 *
 * @example Drive singleShotExtractor end to end with no model, then assert on what was sent
 *
 * ```ts
 * import { scriptedChat, singleShotExtractor } from "@azx/ribo-core";
 *
 * const chat = scriptedChat((request) => {
 *   if (request.responseFormat.json_schema.name !== "contact") {
 *     throw new Error(`unexpected schema: ${request.responseFormat.json_schema.name}`);
 *   }
 *   return { content: { contact: { value: "Acme", confidence: 0.9, sourceSpan: "Acme" } } };
 * });
 * const extractor = singleShotExtractor({ target, chat, model: "fake" });
 * // …extract(), then assert on chat.calls[0].messages
 * ```
 */
export function scriptedChat(
  respond: ScriptedChatResponder,
  options: ScriptedChatOptions = {},
): ScriptedChatClient {
  const initialCapability = options.capability ?? { status: "ready" };
  const calls: ChatRequest[] = [];
  let capability = initialCapability;

  const client: ScriptedChatClient = {
    engine: options.engine ?? "scripted",

    get calls(): readonly ChatRequest[] {
      return calls;
    },

    capability: () => Promise.resolve(capability),

    setCapability(next): ScriptedChatClient {
      capability = next;
      return client;
    },

    reset(): void {
      calls.length = 0;
      capability = initialCapability;
    },

    async complete(request, callOptions): Promise<ChatCompletion> {
      // Record first: a failed or aborted call is still a call a test needs to see. The
      // number is `calls.length` at this moment, which keeps `context.call` and the
      // position in `calls` aligned even for concurrent calls.
      const call = calls.length;
      calls.push(request);
      const signal = callOptions?.signal;

      if (signal?.aborted) {
        throw ChatError.aborted("scriptedChat: the call's signal was already aborted");
      }

      const reply =
        typeof respond === "function" ? await respond(request, { call, signal }) : respond;

      // An abort landing while the callback was in flight rejects rather than resolves —
      // what a real transport does when its fetch is aborted mid-response.
      if (signal?.aborted) {
        throw ChatError.aborted("scriptedChat: the call's signal aborted during the reply");
      }

      const completion = toCompletion(reply);
      await delayFor(reply, signal);
      return completion;
    },
  };

  return client;
}

/** Normalise a {@link ScriptedChatReply} onto the {@link ChatCompletion} the call resolves with. */
function toCompletion(reply: ScriptedChatReply): ChatCompletion {
  if (typeof reply === "string") {
    return { content: reply, finishReason: "stop" };
  }
  // Serialisation happens here, not earlier, so a circular structure rejects the call as a
  // plain serialisation error — unwrapped, like any other throw from responder code.
  const content = typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content);
  const completion: ChatCompletion = {
    content,
    finishReason: reply.finishReason ?? "stop",
    // Omit rather than invent: absent usage means "not reported", never zero.
    ...(reply.usage !== undefined ? { usage: reply.usage } : {}),
  };
  return completion;
}

/**
 * Wait out a reply's `delay`, listening to the call's signal so an abort rejects promptly
 * rather than at delay end. Degenerate values (zero, negative, `NaN`, infinite) mean no delay —
 * this is a test double, and a bogus latency should be ignored, not validated against.
 */
function delayFor(reply: ScriptedChatReply, signal: AbortSignal | undefined): Promise<void> {
  const ms = typeof reply === "string" ? undefined : reply.delay;
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(
      ChatError.aborted("scriptedChat: the call's signal aborted during the reply's delay"),
    );
  }
  if (signal === undefined) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(settle, ms);
    function onAbort(): void {
      cleanup();
      reject(ChatError.aborted("scriptedChat: the call's signal aborted during the reply's delay"));
    }
    function settle(): void {
      cleanup();
      resolve();
    }
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
