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
 *
 * The prompt assembly, the pre-parse `finishReason` check, the terminal-transport
 * classification, and the two parse helpers live in {@link file://./extraction-common.ts}
 * — shared with the per-group extractor (R3 Task 2) so the hard-won reasoning
 * behind each is not copied.
 */

import { z } from "zod";

import type { Enveloped, Extractor, ExtractionResult, ExtractionTarget } from "@azx/ribo-core";

import type { ChatClient } from "./chat-client.js";
import {
  assertStopFinishReason,
  buildMessages,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
} from "./extraction-common.js";

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
 *      run `normalize`. A response that is not JSON throws a plain `Error` (still
 *      transient/retryable); a response that parses as JSON but violates the schema
 *      throws a {@link SchemaParseError}. Both are classified as transient by
 *      `ribo-core`'s `isTransientFailure`, so the queue retries rather than losing a
 *      recording someone drove to a house to make. The schema failure is also
 *      recognisable, so a strategy ladder can fall through to a different shape. The
 *      terminal cases (truncation, content filtering) are caught earlier by
 *      `assertStopFinishReason`.
 *
 * Steps 2 and 3 use the shared helpers in {@link file://./extraction-common.ts},
 * where the full reasoning behind each is documented.
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
  const context = `singleShotExtractor: model response for "${target.name}"`;

  return {
    async extract(transcript: string): Promise<ExtractionResult<Enveloped<V>>> {
      const completion = await completeOrClassify(
        chat,
        {
          model,
          messages: buildMessages(target, transcript),
          response_format: {
            type: "json_schema",
            json_schema: { name: target.name, schema: jsonSchema, strict: true },
          },
          maxTokens,
        },
        "singleShotExtractor",
      );

      assertStopFinishReason(completion, context);

      const raw = parseJsonContent(completion.content, context);
      const parsed = parseWithSchema(target.extractionSchema, raw, context);

      return { fields: normalize(parsed), raw, usage: { calls: 1 } };
    },
  };
}
