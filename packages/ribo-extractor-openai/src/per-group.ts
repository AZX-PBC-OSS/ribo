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
 * **Bounded per-group retry (Task 3).** A group that fails transiently is
 * retried a bounded number of times while successful groups are held, so one
 * blip does not discard six good calls. **Terminal failures are never
 * retried** — {@link assertStopFinishReason} already classifies truncation
 * (`finishReason: "length"`) and content filtering as
 * {@link TerminalQueueError} precisely because re-sending an identical request
 * truncates at the identical point; retrying those would burn the budget for
 * nothing and hide a configuration problem behind a retry storm. If a group
 * still fails after its retries, `extract()` throws and the relay's existing
 * backoff, attempt count and `dead` handling take over unchanged.
 *
 * **The non-grouped fallback.** A target whose schema is not an object of groups
 * gets one entry covering the whole schema from `splitExtractionSchema`, so this
 * extractor makes one call — exactly as today. The second trust-boundary parse
 * is a no-op in that case (the group schema IS the full schema), but harmless.
 */

import { z } from "zod";

import { TerminalQueueError } from "@azx/ribo-core";
import type { Enveloped, Extractor, ExtractionResult, ExtractionTarget } from "@azx/ribo-core";

import type { ChatClient } from "./chat-client.js";
import {
  assertStopFinishReason,
  buildGroupMessages,
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
   * the worst case (all groups plus their inner retries) fits inside the relay's
   * `stepTimeoutMs` — seven sequential calls would not. Defaults to 4.
   */
  readonly concurrency?: number;
  /**
   * Max retries per group after a transient failure (so the total attempts per
   * group is `maxRetries + 1`). Terminal failures ({@link TerminalQueueError} —
   * truncation, content filtering, refusal, unsupported) are never retried.
   * Defaults to 2. The default is derived from the step-timeout relationship —
   * see {@link PER_CALL_CEILING_MS} and the comment where
   * {@link perGroupExtractor} caps it.
   */
  readonly maxRetries?: number;
  /**
   * The relay's step timeout — the wall-clock ceiling inside which all group
   * calls plus their retries must complete. The relay wraps `extract()` in
   * `withTimeout(stepTimeoutMs)`; a timeout here presents as a failed
   * extraction with no indication that some groups succeeded. Defaults to
   * `900_000` (15 minutes), matching the relay's `DEFAULT_STEP_TIMEOUT_MS`.
   * The retry budget is capped so the worst case fits inside this — see the
   * comment in {@link perGroupExtractor}.
   */
  readonly stepTimeoutMs?: number;
  /**
   * Per-group instructions assembly. When provided, each grouped call gets the
   * instructions returned by `groupInstructions(key)` instead of the target's full
   * `instructions`, and each few-shot example is projected to the group's single
   * key — the assistant turn carries only that group's fields. When omitted (or
   * for the non-grouped fallback), every call uses `target.instructions` and the
   * unprojected examples unchanged — today's behaviour.
   *
   * The caller supplies an adapter-specific function (e.g. `snuggGroupInstructions`
   * from `@azx/ribo-adapter-snuggpro`); the extractor stays tool-agnostic and
   * calls it mechanically.
   */
  readonly groupInstructions?: (groupKey: string) => string;
}

/**
 * Conservative upper bound on one chat call's wall-clock duration, used to
 * derive the retry budget from the step-timeout relationship. A
 * structured-output call typically takes 10–30 s; 120 s leaves headroom for a
 * slow endpoint without the retry budget being so tight it cannot absorb a
 * real blip. This is a physical assumption about call latency, not an
 * arbitrary retry count — the retry budget is derived from it and
 * {@link PerGroupOptions.stepTimeoutMs}.
 */
const PER_CALL_CEILING_MS = 120_000;

/**
 * Run `fn` over `items` with at most `limit` calls in flight at once, preserving
 * order. Rejects on the first failure (via `Promise.all`): any group failing
 * fails the extraction, so the first rejection is the extraction's rejection.
 *
 * **Stops pulling new work after a failure.** When any worker's `fn` rejects,
 * the `failed` flag is set and `abort.abort()` is called. Other workers check
 * the flag (or the aborted signal) before pulling the next item and return
 * immediately — so a failing extraction does not start every remaining group's
 * call. Without this, workers kept pulling from the queue after a sibling
 * rejected, and those calls outlived the rejected `extract()`. That was a
 * minor waste before retries and a real problem once retries multiplied the
 * call count.
 *
 * **Aborts in-flight calls.** The `AbortController` is shared with `fn` via
 * the closure in `perGroupExtractor`, which passes `abort.signal` to every
 * `chat.complete` call. When a worker fails and calls `abort.abort()`,
 * in-flight calls in other workers reject with `ChatError.aborted`, and the
 * retry loop does not retry an aborted call. This prevents calls from
 * outliving the rejected `extract()` — both new work (stopped by the flag)
 * and in-flight work (cancelled by the signal).
 */
async function mapWithPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  abort: AbortController,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      // Stop pulling new work after any worker has failed. The abort signal
      // cancels in-flight calls in other workers; this check stops workers
      // that are between calls from starting new ones.
      if (failed || abort.signal.aborted) return;
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (cause) {
        if (!failed) {
          failed = true;
          abort.abort();
        }
        throw cause;
      }
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
 *   2. Build per-group messages: when `groupInstructions` is provided, each
 *      grouped call gets its own instructions (universal + group-specific rules)
 *      and a projected example (one top-level key in the assistant turn);
 *      otherwise every call gets the full prompt — today's behaviour. The
 *      transcript stays last. Each call's `response_format` is pinned to that
 *      group's schema. Message assembly runs **once per entry**, outside the
 *      retry loop.
 *   3. Run the calls concurrently with a bounded pool. For each response:
 *      - **Bounded retry** (Task 3): a transient failure is retried up to
 *        `maxRetries` times while successful groups are held. Terminal failures
 *        ({@link TerminalQueueError}) are never retried. If a group still
 *        fails, `extract()` throws and the relay's existing machinery takes
 *        over unchanged.
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
 * `usage.calls` reports the real number of calls made, including retries.
 */
export function perGroupExtractor<V extends Record<string, unknown>>({
  target,
  chat,
  model,
  maxTokens,
  normalize = (fields) => fields,
  concurrency = 4,
  maxRetries = 2,
  stepTimeoutMs = 900_000,
  groupInstructions,
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

  // The relay wraps extract() in withTimeout(stepTimeoutMs). All group calls
  // plus their retries must fit inside it. The worst case — every group
  // exhausting its full retry budget — runs this many sequential chat calls:
  //
  //   ceil(G / concurrency) * (effectiveMaxRetries + 1)
  //
  // where G = prepared.length. We derive effectiveMaxRetries by capping
  // maxRetries so the worst case fits within stepTimeoutMs at the conservative
  // per-call ceiling — a caller who lowers stepTimeoutMs gets a proportionally
  // lower retry budget rather than a step timeout that presents as a bare
  // extraction failure with no indication that some groups succeeded.
  //
  // With the defaults (stepTimeoutMs = 900_000, concurrency = 4,
  // maxRetries = 2, PER_CALL_CEILING_MS = 120_000) and the Snugg target's 7
  // groups: maxSafeRetries = floor(900_000 / (ceil(7/4) * 120_000)) - 1 = 2,
  // so effectiveMaxRetries = min(2, 2) = 2. The worst case is
  // ceil(7/4) * 3 = 6 sequential calls, 6 * 120 s = 12 minutes — inside the
  // 15-minute step timeout.
  const batches = Math.ceil(prepared.length / concurrency);
  const maxSafeRetries = Math.max(
    0,
    Math.floor(stepTimeoutMs / (batches * PER_CALL_CEILING_MS)) - 1,
  );
  const effectiveMaxRetries = Math.max(0, Math.min(maxRetries, maxSafeRetries));

  return {
    async extract(transcript: string): Promise<ExtractionResult<Enveloped<V>>> {
      // One AbortController for the whole extraction. When any group fails
      // (terminally or past its retry budget), abort is called: in-flight calls
      // in other workers reject with ChatError.aborted, and workers stop
      // pulling new work (mapWithPool checks the signal). This prevents the
      // calls-outlive-extract() waste that retries would multiply.
      const abort = new AbortController();
      let totalCalls = 0;

      const responses = await mapWithPool(
        prepared,
        concurrency,
        async (entry) => {
          // Message assembly runs once per entry — OUTSIDE the retry loop.
          // The retry wraps only the chat call, not the prompt construction.
          const messages = buildGroupMessages(
            target,
            entry.group.key,
            transcript,
            groupInstructions,
          );
          const request = {
            model,
            messages,
            response_format: {
              type: "json_schema" as const,
              json_schema: { name: entry.name, schema: entry.jsonSchema, strict: true as const },
            },
            maxTokens,
          };

          let lastError: unknown;
          for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
            // If a sibling group's failure has aborted the extraction, don't
            // start a new call — propagate so this worker stops. mapWithPool
            // checks the signal before pulling new work; this check catches
            // the case where the abort fires between retry attempts.
            if (abort.signal.aborted) {
              throw lastError ?? new Error("perGroupExtractor: aborted by a sibling failure");
            }

            totalCalls++;
            try {
              const completion = await completeOrClassify(chat, request, entry.context, {
                signal: abort.signal,
              });

              assertStopFinishReason(completion, entry.context);

              const raw = parseJsonContent(completion.content, entry.context);

              // First trust-boundary parse: validate against this group's own
              // schema. A response carrying another group's key is rejected
              // here — the split narrows rather than merely relabels.
              return parseWithSchema(entry.group.schema, raw, entry.context);
            } catch (cause) {
              lastError = cause;
              // Terminal failures are never retried —
              // assertStopFinishReason throws TerminalQueueError for
              // truncation and content filtering precisely because re-sending
              // an identical request reproduces the same result.
              // completeOrClassify similarly classifies refusal/unsupported as
              // TerminalQueueError. Retrying those would burn the budget for
              // nothing and hide a configuration problem behind a retry storm.
              if (cause instanceof TerminalQueueError) throw cause;
              // If aborted by a sibling failure, don't retry — propagate.
              if (abort.signal.aborted) throw cause;
              // Transient failure — retry if budget remains (loop continues).
            }
          }
          // Budget exhausted — rethrow the last transient error. This throws
          // and the relay's existing backoff, attempt count and dead handling
          // take over unchanged.
          throw lastError;
        },
        abort,
      );

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
        usage: { calls: totalCalls },
      };
    },
  };
}
