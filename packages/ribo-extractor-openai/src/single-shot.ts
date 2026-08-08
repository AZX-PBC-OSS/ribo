/**
 * The single-shot managed-LLM extractor — the built default (plan §Decided). One
 * structured-output chat call turns a transcript into enveloped fields: assemble
 * the prompt from the {@link ExtractionTarget}, pin the output to the target's
 * `extractionSchema` with `strict: true`, then cross the trust boundary — parse
 * the response with that same schema and run the deterministic normalization pass
 * — before it becomes field data.
 *
 * **Everything here speaks `Enveloped<V>`, not `V`.** The type parameter is `V`,
 * the adapter's plain-values type, because that is what names a target; but the
 * four things this file does with fields — constrain the model, parse the
 * response, imitate the example assistant turns, and normalize — are all the
 * provenance-enveloped shape the model actually emits. The plain values only
 * exist after a human review, which is a later step and a different contract.
 * Saying `Extractor<V>` here would be a signature that claims something untrue
 * (design `r1.5-field-shape-contracts-design.md` §1.1).
 *
 * It is generic over `V` and depends only on the injected {@link ChatClient} and
 * the target's field knowledge, so `ribo-core` and this adapter never import a
 * provider SDK. The two alternative strategies (plan-then-execute, a managed
 * endpoint) share this same {@link Extractor} seam; see Task 5.
 */

import { z } from "zod";

import type { Enveloped, Extractor, ExtractionResult, ExtractionTarget } from "@azx/ribo-core";

import type { ChatClient, ChatMessage } from "./chat-client.js";

/** Options for {@link singleShotExtractor}. */
export interface SingleShotOptions<V extends Record<string, unknown>> {
  /** The field knowledge: `name`, `extractionSchema`, `instructions`, and few-shot `examples`. */
  readonly target: ExtractionTarget<V>;
  /** The injected chat transport. A fake in tests; {@link openAiChat} in production. */
  readonly chat: ChatClient;
  /** The model id passed through to the endpoint (e.g. the Helix-routed model). */
  readonly model: string;
  /**
   * Cap on generated tokens, passed through to `ChatRequest.maxTokens` and
   * validated there. Sits next to `model`, the existing precedent for transport
   * configuration living on the extractor — NOT on the adapter, which is field
   * knowledge. A token budget is inference configuration owned by whoever runs
   * the model; putting it on the adapter would force a second host with different
   * limits to fork the adapter to change a number.
   */
  readonly maxTokens?: number;
  /**
   * The deterministic, model-free pass run AFTER the schema parse — the second
   * half of the trust boundary. It consumes and returns `Enveloped<V>` because it
   * runs on the model's output, before review: for the Snugg Pro adapter this is
   * `normalizeFields`, and what it does — clamp every envelope's `confidence` to
   * 0..1 — is only expressible on the enveloped shape. Defaults to identity so the
   * extractor stays generic; the Snugg wiring MUST pass `normalizeFields`.
   */
  readonly normalize?: (fields: Enveloped<V>) => Enveloped<V>;
}

/**
 * Assemble the chat messages: the instructions as the system prompt, each few-shot
 * example as a user (transcript) / assistant (JSON fields) turn, then the live
 * transcript as the final user message.
 */
function buildMessages<V extends Record<string, unknown>>(
  target: ExtractionTarget<V>,
  transcript: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: target.instructions }];
  for (const example of target.examples ?? []) {
    messages.push({ role: "user", content: example.transcript });
    messages.push({ role: "assistant", content: JSON.stringify(example.fields) });
  }
  messages.push({ role: "user", content: transcript });
  return messages;
}

/**
 * Build a single-shot {@link Extractor} for a target.
 *
 * On each `extract`:
 *   1. Convert the target's `extractionSchema` to a strict JSON Schema
 *      (`z.toJSONSchema`, draft-2020-12) and send one chat call with
 *      `response_format: json_schema`.
 *   2. **Pre-parse check.** If the completion carries a `finishReason` that is not
 *      `"stop"`, reject immediately — a truncated (`"length"`) or content-filtered
 *      (`"content_filter"`) response is not a complete result, and letting it
 *      reach the zod parse would misreport it as "invalid JSON" rather than the
 *      real cause. The `"length"` message names `maxTokens`, the knob that fixes it.
 *   3. **Trust boundary.** Parse the response with `target.extractionSchema`, then
 *      run `normalize`. A response that is not JSON, or does not satisfy the
 *      schema, throws a plain `Error` — which `ribo-core`'s `isTransientFailure`
 *      classifies as **transient/retryable** (its default for an unrecognised
 *      error), so the queue retries rather than losing a recording someone drove
 *      to a house to make. Nothing here is thrown as a `TerminalQueueError`: a bad
 *      response is more likely a truncation or a blip than a permanent condition.
 */
export function singleShotExtractor<V extends Record<string, unknown>>({
  target,
  chat,
  model,
  maxTokens,
  normalize = (fields) => fields,
}: SingleShotOptions<V>): Extractor<Enveloped<V>> {
  const jsonSchema = z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;

  return {
    async extract(transcript: string): Promise<ExtractionResult<Enveloped<V>>> {
      const completion = await chat.complete({
        model,
        messages: buildMessages(target, transcript),
        response_format: {
          type: "json_schema",
          json_schema: { name: target.name, schema: jsonSchema, strict: true },
        },
        maxTokens,
      });

      // The other half of the token cap: a non-"stop" finish reason means the
      // model's output is not a complete result. Reject BEFORE the zod parse, so
      // a truncated or filtered response is not misreported as "invalid JSON" —
      // the diagnostic failure this cap exists to prevent. "length" names
      // maxTokens (the knob that fixes it); "content_filter" names the cause.
      if (completion.finishReason && completion.finishReason !== "stop") {
        const hint =
          completion.finishReason === "length"
            ? " — the response was truncated; increase maxTokens and retry"
            : " — the response was content-filtered; the model declined to complete it";
        throw new Error(
          `singleShotExtractor: model response for "${target.name}" ended with finishReason "${completion.finishReason}"${hint}.`,
        );
      }

      let raw: unknown;
      try {
        raw = JSON.parse(completion.content);
      } catch (cause) {
        // Transient by default: a truncated/garbled body is worth a retry, and a
        // plain Error (no HTTP status) is exactly what isTransientFailure retries.
        throw new Error(
          `singleShotExtractor: model response for "${target.name}" was not valid JSON`,
          { cause },
        );
      }

      const parsed = target.extractionSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `singleShotExtractor: model response for "${target.name}" did not match the schema: ` +
            parsed.error.message,
          { cause: parsed.error },
        );
      }

      return { fields: normalize(parsed.data), raw, usage: { calls: 1 } };
    },
  };
}
