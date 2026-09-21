/**
 * @file The managed-completion call-and-parse chain: send the request, classify the
 * transport's terminal failures, reject a truncated completion, parse the JSON body —
 * with the terminal/transient classification the managed extractors established.
 *
 * These moved here from `@azx/ribo-extractor-openai`'s `extraction-common` (which
 * re-exports them, so its surface and internal imports are unchanged): they are
 * transport-agnostic semantics over the chat seam (ADR 0010), and `askPhase` composes the
 * same chain its managed cousins do. One copy of the semantics, beside the seam — the
 * same reason `parseWithSchema` itself moved.
 *
 * What this deliberately does not do: the zod parse. `parseWithSchema` (the trust
 * boundary) stays its own module and is not re-exported here, because a caller composes
 * it directly; and prompt assembly belongs to the phase or extractor that owns the ask.
 */

import { ChatError } from "./chat-client.js";
import type { ChatCallOptions, ChatClient, ChatCompletion, ChatRequest } from "./chat-client.js";
import { TerminalError } from "../storage/backoff.js";

/**
 * Send the request, translating the transport's terminal failures into terminal QUEUE
 * failures.
 *
 * `isTransientFailure` reads any error without a numeric `status` as retryable, so a
 * bare {@link ChatError} of these kinds would be re-sent until the item reached `dead`
 * — defeating the exact reasoning that makes a non-`"stop"` finish reason terminal in
 * {@link assertStopFinishReason}.
 *
 *   - `refusal` — the model declined THIS input. Re-sending it produces the same refusal.
 *   - `unsupported` — this client cannot honour something the request asked for (a CLI
 *     transport given `maxTokens`, say). A configuration error, fixed by changing the
 *     configuration, never by trying again.
 *
 * `aborted` is deliberately left retryable, which is where this departs from a review
 * that grouped all three: an abort is caller-initiated, and a host that cancels on a
 * deadline may well succeed on a later attempt with a fresh one. `transport`,
 * `malformed-response` and a 5xx/408/429 `http` stay retryable for the same reason they
 * always were — they describe a blip, not a verdict.
 *
 * @param context - the caller's identity for error messages (e.g. `"singleShotExtractor"`)
 */
export async function completeOrClassify(
  chat: ChatClient,
  request: ChatRequest,
  context: string,
  options?: ChatCallOptions,
): Promise<ChatCompletion> {
  try {
    return await chat.complete(request, options);
  } catch (cause) {
    if (cause instanceof ChatError && (cause.kind === "refusal" || cause.kind === "unsupported")) {
      throw new TerminalError(
        `${context}: the transport failed terminally (${cause.kind}): ${cause.message}`,
        { cause },
      );
    }
    throw cause;
  }
}

/**
 * Reject a completion whose `finishReason` is not `"stop"` — BEFORE the zod parse.
 *
 * A truncated (`"length"`) or content-filtered (`"content_filter"`) response is not a
 * complete result, and letting it reach the zod parse would misreport it as "invalid
 * JSON" rather than the real cause. The `"length"` message names `maxTokens`, the knob
 * that fixes it.
 *
 * Throws `TerminalError`, NOT a plain `Error`: `isTransientFailure` treats any
 * error without a numeric `status` as retryable, and both of these are deterministic.
 * Re-sending an identical request with an identical `maxTokens` truncates at the identical
 * point, and a content filter fires again on the same content — so a plain `Error` would
 * burn every attempt and land the item in `dead`, hiding a configuration problem behind a
 * retry storm. The fix is to change `maxTokens` or the input, never to try again.
 *
 * @param context - a descriptive prefix for the error (e.g.
 *   `singleShotExtractor: model response for "demo-fields"`)
 */
export function assertStopFinishReason(completion: ChatCompletion, context: string): void {
  if (completion.finishReason && completion.finishReason !== "stop") {
    const hint =
      completion.finishReason === "length"
        ? " — the response was truncated; increase maxTokens and re-run"
        : " — the response was content-filtered; the model declined to complete it";
    throw new TerminalError(
      `${context} ended with finishReason "${completion.finishReason}"${hint}.`,
    );
  }
}

/**
 * Parse a completion's content as JSON, throwing a plain `Error` (transient by default)
 * on failure.
 *
 * A truncated/garbled body is worth a retry, and a plain `Error` (no HTTP status) is
 * exactly what `isTransientFailure` retries.
 *
 * @param context - a descriptive prefix for the error
 */
export function parseJsonContent(content: string, context: string): unknown {
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new Error(`${context} was not valid JSON`, { cause });
  }
}
