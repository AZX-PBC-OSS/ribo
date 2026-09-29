/**
 * The single-shot managed-LLM extractor — the built default (plan §Decided). One
 * structured-output chat call turns a transcript into enveloped fields: assemble
 * the prompt from the {@link ExtractionTarget}, pin the output to the target's
 * `extractionSchema` with `strict: true`, then cross the trust boundary — parse
 * the response with that same schema and run the deterministic normalization pass
 * — before it becomes field data.
 *
 * **Everything here speaks `Enveloped<V, P>`, not `V`.** The type parameter is `V`,
 * the adapter's plain-values type, because that is what names a target; but the
 * four things this file does with fields — constrain the model, parse the
 * response, imitate the example assistant turns, and normalize — are all the
 * provenance-enveloped shape the model actually emits. The plain values only
 * exist after a human review, which is a later step and a different contract.
 * Saying `Extractor<V>` here would be a signature that claims something untrue
 * (design `r1.5-field-shape-contracts-design.md` §1.1).
 *
 * It is generic over `V` and depends only on the injected {@link ChatClient} and
 * the target's field knowledge, so `ribo-core` never imports a provider SDK. The
 * two alternative strategies (plan-then-execute, a managed endpoint) share this
 * same {@link Extractor} seam; see Task 5.
 *
 * The prompt assembly, the pre-parse `finishReason` check, the terminal-transport
 * classification, and the two parse helpers live in `extraction-common.ts`
 * — shared with the per-group extractor (R3 Task 2) so the hard-won reasoning
 * behind each is not copied.
 */

import type { AnnotatedTranscript } from "../capture/annotated-transcript.js";
import type { ChatClient } from "../phases/chat-client.js";
import type { Enveloped, NoProvenance } from "../provenance/enveloped.js";
import { nextUnitId } from "./extraction-observer.js";
import type { ExtractionObserver, WholeUnit } from "./extraction-observer.js";
import type { ExtractionResult, ExtractionTarget, Extractor, ExtractOptions } from "./extractor.js";

import type { UsageTotals } from "./extraction-common.js";
import {
  addUsage,
  assertStopFinishReason,
  assertWireSafeSchemaName,
  buildMessages,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
} from "./extraction-common.js";
import type { FieldGuidanceOptions } from "./field-guidance.js";
import { fieldDescriptionsMode } from "./field-guidance.js";
import { toJsonSchemaForWire } from "./schema/wire-schema.js";

/**
 * Options for {@link singleShotExtractor}.
 *
 * Inherits `onUnit` from {@link ExtractionObserver}, narrowed to {@link WholeUnit}:
 * one `extract()` emits exactly one unit — `start`, then `done` or `error`. There
 * is no retry loop here, so `attempt` is always 1, and that is the honest report,
 * not a placeholder.
 */
export interface SingleShotOptions<
  V extends Record<string, unknown>,
  P = NoProvenance,
> extends ExtractionObserver<WholeUnit> {
  /** The field knowledge: `name`, `extractionSchema`, `instructions`, and few-shot `examples`. */
  readonly target: ExtractionTarget<V, P>;
  /** The injected chat transport. A fake in tests; `openAiChat` in production. */
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
   * half of the trust boundary. It consumes and returns `Enveloped<V, P>` because it
   * runs on the model's output, before review: for the Snugg Pro adapter this is
   * `normalizeFields`, and what it does — clamp every envelope's `confidence` to
   * 0..1 — is only expressible on the enveloped shape. Defaults to identity so the
   * extractor stays generic; the Snugg wiring MUST pass `normalizeFields`.
   */
  readonly normalize?: (fields: Enveloped<V, P>) => Enveloped<V, P>;
  /**
   * Where the schema's field descriptions travel. Defaults to `"schema"`:
   * they ride `response_format`. `"prompt"` renders the wire schema without
   * them and carries the same text in the system message, for a route whose
   * cap is on the schema rather than the messages. See `field-guidance.ts`.
   */
  readonly fieldDescriptions?: FieldGuidanceOptions["fieldDescriptions"];
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
 *      throws a `SchemaParseError`. Both are classified as transient by
 *      `ribo-core`'s `isTransientFailure`, so the queue retries rather than losing a
 *      recording someone drove to a house to make. The schema failure is also
 *      recognisable, so a strategy ladder can fall through to a different shape. The
 *      terminal cases (truncation, content filtering) are caught earlier by
 *      `assertStopFinishReason`.
 *
 * Steps 2 and 3 use the shared helpers in `extraction-common.ts`,
 * where the full reasoning behind each is documented.
 */
export function singleShotExtractor<V extends Record<string, unknown>, P = NoProvenance>({
  target,
  chat,
  model,
  maxTokens,
  normalize = (fields) => fields,
  fieldDescriptions,
  onUnit,
}: SingleShotOptions<V, P>): Extractor<Enveloped<V, P>> {
  // The target's name IS this request's `json_schema.name` — guard it at
  // construction, where the schema author is present, rather than at the route
  // as a 400 that reads identically to an over-cap schema.
  assertWireSafeSchemaName(target.name, "singleShotExtractor");
  const keepDescriptions = fieldDescriptionsMode({ fieldDescriptions }) === "schema";
  const jsonSchema = toJsonSchemaForWire(target.extractionSchema, { keepDescriptions });
  const context = `singleShotExtractor: model response for "${target.name}"`;

  return {
    async extract(
      transcript: AnnotatedTranscript,
      options?: ExtractOptions,
    ): Promise<ExtractionResult<Enveloped<V, P>>> {
      const id = nextUnitId();
      onUnit?.({ id, unit: "whole", phase: "start", attempt: 1 });
      try {
        const completion = await completeOrClassify(
          chat,
          {
            model,
            messages: buildMessages(target, transcript.text, { fieldDescriptions }),
            response_format: {
              type: "json_schema",
              json_schema: { name: target.name, schema: jsonSchema, strict: true },
            },
            maxTokens,
          },
          "singleShotExtractor",
          options,
        );

        assertStopFinishReason(completion, context);

        const raw = parseJsonContent(completion.content, context);
        const parsed = parseWithSchema(target.extractionSchema, raw, context);

        const totals: UsageTotals = {};
        addUsage(totals, completion.usage);
        const result: ExtractionResult<Enveloped<V, P>> = {
          fields: normalize(parsed),
          raw,
          usage: { calls: 1, ...totals },
        };
        // `done` fires only once the whole path has succeeded, so the unit settles
        // exactly once: `done` if and only if extract() resolves, `error` if and
        // only if it rejects — never both, never neither.
        onUnit?.({
          id,
          unit: "whole",
          phase: "done",
          attempt: 1,
          // Omit rather than invent: absent usage means "not reported", never zero.
          ...(completion.usage !== undefined
            ? {
                usage: {
                  inputTokens: completion.usage.promptTokens,
                  outputTokens: completion.usage.completionTokens,
                },
              }
            : {}),
        });
        return result;
      } catch (error) {
        onUnit?.({ id, unit: "whole", phase: "error", attempt: 1, error });
        throw error;
      }
    },
  };
}
