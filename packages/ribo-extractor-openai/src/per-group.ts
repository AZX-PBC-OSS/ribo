/**
 * The per-group managed-LLM extractor — R3 Task 2. The sibling of
 * {@link singleShotExtractor}: instead of one chat call carrying the whole
 * `extractionSchema`, it splits the schema into top-level groups
 * ({@link splitExtractionSchema}), runs one call per group concurrently with a
 * bounded pool, and assembles one result.
 *
 * **Why split.** With the vendor field descriptions the whole schema is 39,741
 * bytes against a hard 32,768 cap, so today we strip them — losing the vendor's
 * authoritative text for 51 fields. Each group is a fraction of the whole
 * (largest is `health` at 13,273) and fits with its descriptions. That is the
 * point of the exercise; restoring them is Task 5.
 *
 * **Same seam.** `extract(transcript) → ExtractionResult<F>` is unchanged. The
 * relay, the outbox and `ribo-core` are not touched.
 *
 * **Everything here speaks `Enveloped<V>`, not `V`** — for the same reason as
 * {@link singleShotExtractor}: the four things this file does with fields
 * (constrain the model, parse each response, imitate the example assistant turns,
 * and normalize) are all the provenance-enveloped shape the model emits.
 *
 * **The trust boundary runs twice.** Each response is parsed against its own
 * group schema at the point of receipt; the merged whole is then parsed against
 * the full `extractionSchema` before returning. The second parse catches a merge
 * that produced a shape no single call would have — it is not redundant.
 *
 * **Normalization runs once**, on the merged result: `normalizeFields` clamps
 * confidence across the whole enveloped shape, and running it per group would
 * run it seven times on seven partial shapes for no benefit.
 *
 * **No per-group retry in this task** (Task 3 adds it). Any group failing fails
 * the extraction, which is today's all-or-nothing behaviour — the relay's
 * existing backoff, attempt count and `dead` handling take over unchanged.
 *
 * **The non-grouped fallback.** A target whose schema is not an object of groups
 * gets one entry covering the whole schema from `splitExtractionSchema`, so this
 * extractor makes one call — exactly as today. The second trust-boundary parse
 * is a no-op in that case (the group schema IS the full schema), but harmless.
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
import { splitExtractionSchema } from "./split-schema.js";

/** Options for {@link perGroupExtractor}. */
export interface PerGroupOptions<V extends Record<string, unknown>> {
  /** The field knowledge: `name`, `extractionSchema`, `instructions`, and few-shot `examples`. */
  readonly target: ExtractionTarget<V>;
  /** The injected chat transport. A fake in tests; {@link openAiChat} in production. */
  readonly chat: ChatClient;
  /** The model id passed through to the endpoint (e.g. the Helix-routed model). */
  readonly model: string;
  /**
   * Cap on generated tokens, passed through to `ChatRequest.maxTokens` and
   * validated there. See {@link SingleShotOptions.maxTokens} for the full
   * rationale — the same reasoning applies per-group.
   */
  readonly maxTokens?: number;
  /**
   * The deterministic, model-free pass run AFTER the second trust-boundary parse
   * — on the MERGED result, not per group. See {@link SingleShotOptions.normalize}
   * for the full rationale; the difference here is that it runs once across the
   * whole enveloped shape rather than once per partial shape.
   */
  readonly normalize?: (fields: Enveloped<V>) => Enveloped<V>;
  /**
   * Max concurrent group calls. The calls run concurrently with a bounded pool so
   * the worst case (all groups plus their inner retries, once Task 3 lands) fits
   * inside the relay's `stepTimeoutMs` — seven sequential calls would not.
   * Defaults to 4.
   */
  readonly concurrency?: number;
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight at once, preserving
 * order. Rejects on the first failure (via `Promise.all`): in Task 2 any group
 * failing fails the extraction, so the first rejection is the extraction's
 * rejection. Workers that are still in-flight when a sibling rejects continue to
 * completion — their results are discarded, which is the cost of not
 * persisting partial state (design §5).
 */
async function mapWithPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  const size = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: size }, () => worker()));
  return results;
}

/** A group with its JSON Schema and error-context pre-computed at construction time. */
interface PreparedGroup {
  /** The original group — its zod schema is used for the first trust-boundary parse. */
  readonly group: { readonly key: string; readonly schema: z.ZodType };
  /** The JSON Schema sent to the model in `response_format`. */
  readonly jsonSchema: Record<string, unknown>;
  /** The `response_format.json_schema.name` — identifies the group in the request. */
  readonly name: string;
  /** The descriptive prefix for error messages from this group's call. */
  readonly context: string;
}

/**
 * Build a per-group {@link Extractor} for a target.
 *
 * On each `extract`:
 *   1. Split the target's `extractionSchema` into per-group schemas
 *      ({@link splitExtractionSchema}). A non-grouped schema yields one entry
 *      covering the whole schema — one call, today's behaviour.
 *   2. Build the same messages for every group (the target's instructions and
 *      examples unchanged, transcript last) and pin each call's
 *      `response_format` to that group's schema.
 *   3. Run the calls concurrently with a bounded pool. For each response:
 *      - **Pre-parse check** ({@link assertStopFinishReason}): reject a
 *        non-`"stop"` completion before parsing, so truncation is not
 *        misreported as invalid JSON. Terminal, not retried.
 *      - **First trust-boundary parse** ({@link parseWithSchema}): parse the
 *        response against its own group schema.
 *   4. Merge the parsed responses by shallow assignment — each has exactly one
 *      top-level key, so the union is the whole.
 *   5. **Second trust-boundary parse**: parse the merged whole against the full
 *      `extractionSchema`. Catches a merge that produced a shape no single call
 *      would have.
 *   6. **Normalize once** on the merged result.
 *
 * `usage.calls` reports the number of calls made — one per group.
 */
export function perGroupExtractor<V extends Record<string, unknown>>({
  target,
  chat,
  model,
  maxTokens,
  normalize = (fields) => fields,
  concurrency = 4,
}: PerGroupOptions<V>): Extractor<Enveloped<V>> {
  // Split at construction time — the group list is a pure function of the schema
  // and does not depend on the transcript. A non-grouped schema yields one entry
  // covering the whole schema (key: ""), which makes one call — today's behaviour.
  const groups = splitExtractionSchema(target.extractionSchema);

  // Pre-compute each group's JSON Schema and error-context at construction time.
  // The JSON Schema generation (`z.toJSONSchema`) is not cheap, and the schema
  // does not change between calls.
  const prepared: readonly PreparedGroup[] = groups.map((group) => {
    const jsonSchema = z.toJSONSchema(group.schema, { target: "draft-2020-12" }) as Record<
      string,
      unknown
    >;
    const name = group.key ? `${target.name}:${group.key}` : target.name;
    const context = group.key
      ? `perGroupExtractor: model response for "${target.name}" group "${group.key}"`
      : `perGroupExtractor: model response for "${target.name}"`;
    return { group, jsonSchema, name, context };
  });

  return {
    async extract(transcript: string): Promise<ExtractionResult<Enveloped<V>>> {
      // The same messages for every group: the target's instructions and examples
      // unchanged, with the transcript last. Task 4 makes the prompts per-group;
      // this task sends the full prompt and pins only the response schema.
      const messages = buildMessages(target, transcript);

      const responses = await mapWithPool(prepared, concurrency, async (entry) => {
        const completion = await completeOrClassify(
          chat,
          {
            model,
            messages,
            response_format: {
              type: "json_schema",
              json_schema: { name: entry.name, schema: entry.jsonSchema, strict: true },
            },
            maxTokens,
          },
          "perGroupExtractor",
        );

        assertStopFinishReason(completion, entry.context);

        const raw = parseJsonContent(completion.content, entry.context);

        // First trust-boundary parse: validate against this group's own schema.
        // A response carrying another group's key is rejected here — the split
        // narrows rather than merely relabels (split-schema.ts).
        return parseWithSchema(entry.group.schema, raw, entry.context);
      });

      // Merge by shallow assignment — each response has exactly one top-level
      // key, so assigning in sequence produces the whole without re-keying.
      const merged: Record<string, unknown> = {};
      for (const response of responses) {
        Object.assign(merged, response);
      }

      // Second trust-boundary parse: validate the merged whole against the full
      // extraction schema. This is not redundant — it catches a merge that
      // produced a shape no single call would have.
      const mergeContext = `perGroupExtractor: merged response for "${target.name}"`;
      const parsed = parseWithSchema(target.extractionSchema, merged, mergeContext);

      // Normalization runs once on the merged result — normalizeFields clamps
      // confidence across the whole enveloped shape; running it per group would
      // run it seven times on seven partial shapes for no benefit.
      return {
        fields: normalize(parsed),
        raw: merged,
        usage: { calls: prepared.length },
      };
    },
  };
}
