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
 *   2. **Trust boundary.** Parse the response with `target.extractionSchema`, then
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
  normalize = (fields) => fields,
}: SingleShotOptions<V>): Extractor<Enveloped<V>> {
  const jsonSchema = z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" }) as Record<
    string,
    unknown
  >;

  return {
    async extract(transcript: string): Promise<ExtractionResult<Enveloped<V>>> {
      const { content } = await chat.complete({
        model,
        messages: buildMessages(target, transcript),
        response_format: {
          type: "json_schema",
          json_schema: { name: target.name, schema: jsonSchema, strict: true },
        },
      });

      let raw: unknown;
      try {
        raw = JSON.parse(content);
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
