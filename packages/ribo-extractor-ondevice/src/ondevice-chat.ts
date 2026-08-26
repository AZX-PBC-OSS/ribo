import {
  ChatError,
  type CapableChatClient,
  type ChatCallOptions,
  type ChatCapability,
  type ChatCompletion,
  type ChatMessage,
  type ChatRequest,
} from "@azx/ribo-extractor-openai";

import type {
  LanguageModel,
  LanguageModelPrompt,
  LanguageModelSession,
  PrimeProgressListener,
} from "./capability.js";
import { primeLanguageModel, probeLanguageModel } from "./capability.js";
import { isLoopingOutput } from "./loop-detector.js";
import { SessionHolder } from "./session.js";

/**
 * Stable engine id for on-device extraction through Chrome's Prompt API.
 *
 * Mirrors {@link ONDEVICE_WHISPER_ENGINE}: short, opaque, and stamped into
 * provenance so the outbox can distinguish a managed from an on-device run.
 */
export const ONDEVICE_CHAT_ENGINE = "ondevice-chat";

/** How long one `complete()` call may stream before the client aborts it itself. */
export const DEFAULT_DEVICE_PROMPT_DEADLINE_MS = 15_000;

export interface OnDeviceChatOptions {
  /** The Chrome Prompt API `LanguageModel` object, usually `globalThis.ai.languageModel`. */
  readonly languageModel: LanguageModel;
  /**
   * Hard deadline for a single `complete()` call, independent of the caller's
   * signal and of the whitespace loop detector. The detector catches the common
   * degeneration quickly; the deadline bounds every other degenerate path.
   */
  readonly deadlineMs?: number;
}

/**
 * A {@link CapableChatClient} backed by Chrome's on-device Prompt API.
 *
 * Translates OpenAI-shaped {@link ChatRequest}s into Prompt API sessions:
 * system prompts and few-shot turns become `initialPrompts`, the transcript is
 * the only thing passed to `promptStreaming`, and the JSON Schema is the
 * `responseConstraint`. Streams internally so it can kill Nano's trailing-
 * whitespace loop early and enforces its own per-call deadline.
 */
export class OnDeviceChat implements CapableChatClient {
  readonly engine = ONDEVICE_CHAT_ENGINE;

  readonly #languageModel: LanguageModel;
  readonly #deadlineMs: number;

  constructor(options: OnDeviceChatOptions) {
    this.#languageModel = options.languageModel;
    this.#deadlineMs = options.deadlineMs ?? DEFAULT_DEVICE_PROMPT_DEADLINE_MS;
  }

  async capability(): Promise<ChatCapability> {
    return probeLanguageModel(this.#languageModel);
  }

  prime(onProgress?: PrimeProgressListener): Promise<ChatCapability> {
    return primeLanguageModel(this.#languageModel, onProgress);
  }

  async complete(request: ChatRequest, options?: ChatCallOptions): Promise<ChatCompletion> {
    if (options?.signal?.aborted) {
      throw ChatError.aborted(
        "OnDeviceChat: call was aborted before streaming began",
        options.signal.reason,
      );
    }

    const { initialPrompts, input } = splitMessages(request.messages);
    const responseConstraint = request.response_format.json_schema.schema;

    const holder = new SessionHolder({
      languageModel: this.#languageModel,
      initialPrompts,
    });

    try {
      return await holder.run((session) =>
        this.#runPrompt(session, input, responseConstraint, options),
      );
    } catch (error) {
      if (isNotAllowedError(error)) {
        throw ChatError.unsupported(
          "OnDeviceChat: create() requires a user gesture when the model is not downloaded",
        );
      }
      throw error;
    }
  }

  async #runPrompt(
    session: LanguageModelSession,
    input: string,
    responseConstraint: Record<string, unknown>,
    options?: ChatCallOptions,
  ): Promise<ChatCompletion> {
    const promptOptions = {
      responseConstraint,
      omitResponseConstraintInput: true as const,
    };

    const promptTokens = await session.measureContextUsage(input, promptOptions);
    if (promptTokens > session.contextWindow) {
      throw ChatError.unsupported(
        `OnDeviceChat: prepared input does not fit in the model's context window ` +
          `(${promptTokens} > ${session.contextWindow} tokens)`,
      );
    }

    const abort = new AbortController();
    let loopKilled = false;
    let deadlineHit = false;
    let promptError: unknown;

    const timeoutId = setTimeout(() => {
      deadlineHit = true;
      abort.abort("deadline");
    }, this.#deadlineMs);

    const onExternalAbort = (): void => {
      abort.abort(options?.signal?.reason);
    };

    options?.signal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      let content = "";
      for await (const chunk of session.promptStreaming(input, {
        ...promptOptions,
        signal: abort.signal,
      })) {
        content += chunk;
        if (isLoopingOutput(content)) {
          loopKilled = true;
          abort.abort("loop");
          // Keep consuming so the generator sees the abort and is cancelled,
          // not merely dropped by `break`.
        }
      }

      if (abort.signal.aborted) {
        promptError = new DOMException("The operation was aborted", "AbortError");
      } else {
        return { content, finishReason: "stop" };
      }
    } catch (error) {
      promptError = error;
    } finally {
      clearTimeout(timeoutId);
      options?.signal?.removeEventListener("abort", onExternalAbort);
    }

    throw classifyPromptError(promptError, options?.signal, loopKilled, deadlineHit);
  }
}

function splitMessages(messages: readonly ChatMessage[]): {
  initialPrompts: LanguageModelPrompt[];
  input: string;
} {
  if (messages.length === 0) {
    throw ChatError.unsupported("OnDeviceChat requires at least one message");
  }

  const last = messages[messages.length - 1]!;
  return {
    initialPrompts: messages.slice(0, -1).map((message) => ({
      role: message.role,
      content: message.content,
    })),
    input: last.content,
  };
}

function classifyPromptError(
  error: unknown,
  externalSignal: AbortSignal | undefined,
  loopKilled: boolean,
  deadlineHit: boolean,
): ChatError {
  // The caller's own abort is the authoritative signal — it must win over any
  // internal classification.
  if (externalSignal?.aborted) {
    return ChatError.aborted(
      "OnDeviceChat: the call was aborted by the caller",
      externalSignal.reason,
    );
  }

  if (isQuotaExceededError(error)) {
    // Output truncation on-device is the model falling into a degenerate loop,
    // not a genuine "the answer did not fit" condition. Retry converges, so this
    // MUST NOT be `refusal` or `unsupported` — those are the only terminal
    // ChatError kinds in `completeOrClassify` and would disable the mitigation.
    return ChatError.transport(
      "OnDeviceChat: the response exceeded the model's output limits and was truncated",
      error,
    );
  }

  if (loopKilled) {
    return ChatError.transport(
      "OnDeviceChat: the model output degenerated into a trailing whitespace loop",
      error,
    );
  }

  if (deadlineHit) {
    return ChatError.transport("OnDeviceChat: the prompt exceeded the hard deadline", error);
  }

  if (isNotSupportedError(error)) {
    return ChatError.unsupported(
      "OnDeviceChat: the response schema uses a feature this model does not support",
    );
  }

  if (error instanceof SyntaxError) {
    return ChatError.malformed(
      "OnDeviceChat: the model could not satisfy the response constraint",
      error,
    );
  }

  if (isNetworkError(error)) {
    return ChatError.transport("OnDeviceChat: the model fetch failed", error);
  }

  if (isAbortError(error)) {
    return ChatError.aborted("OnDeviceChat: the prompt was aborted", error);
  }

  return ChatError.transport("OnDeviceChat: prompt streaming failed", error);
}

function isAbortError(error: unknown): error is DOMException {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  );
}

function isQuotaExceededError(error: unknown): error is DOMException {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "QuotaExceededError"
  );
}

function isNotSupportedError(error: unknown): error is DOMException {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NotSupportedError"
  );
}

function isNetworkError(error: unknown): error is DOMException {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NetworkError"
  );
}

function isNotAllowedError(error: unknown): error is DOMException {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "NotAllowedError"
  );
}
