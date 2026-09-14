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
 * **Same seam.** `extract(annotatedTranscript) → ExtractionResult<F>` is
 * unchanged in shape. The relay, the outbox and `ribo-core` are not touched.
 *
 * **Everything here speaks `Enveloped<V, P>`, not `V`** — for the same reason as
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
 * **Backoff between retries.** A transient failure is not re-sent immediately:
 * the loop backs off using {@link fullJitterDelay} — the same exponential
 * full-jitter function the relay uses to schedule its own retries — so a reader
 * meets one backoff policy in this codebase, not two. The delay is injectable
 * (`delay` option) so tests do not sleep; the default is a real `setTimeout`.
 *
 * **429s are treated alike.** A `429 rate_limited` whose body says "retry
 * shortly" (too many requests this second) and one whose body says "burst spend
 * budget exhausted" (spend limit hit) are both retried with backoff. We cannot
 * reliably tell them apart from the status alone, and parsing the body for a
 * distinguishing signal is vendor-specific and fragile — a wording change breaks
 * the heuristic. Treating them alike is defensible: a burst-spend 429 simply
 * keeps failing through the per-group retry budget and then throws to the relay,
 * whose own backoff and `dead` handling take over. The backoff prevents a retry
 * storm, and the asymmetry that makes `isTransientFailure` default to retryable
 * applies here too — wrongly retrying a terminal 429 costs a few delayed
 * requests, while wrongly declaring a transient 429 terminal silently loses a
 * recording someone drove to a house to make.
 *
 * **The non-grouped fallback.** A target whose schema is not an object of groups
 * gets one entry covering the whole schema from `splitExtractionSchema`, so this
 * extractor makes one call — exactly as today. The second trust-boundary parse
 * is a no-op in that case (the group schema IS the full schema), but harmless.
 */

import { z } from "zod";

import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  deriveRetryBudget,
  fullJitterDelay,
  mapWithPool,
  mergeGroupPieces,
  nextUnitId,
  PER_CALL_CEILING_MS,
  TerminalQueueError,
} from "@azx/ribo-core";
import type {
  AnnotatedTranscript,
  BackoffOptions,
  Enveloped,
  ExtractionObserver,
  ExtractionResult,
  ExtractionTarget,
  Extractor,
  GroupUnit,
  NoProvenance,
  RetryBudgetObserver,
} from "@azx/ribo-core";

import type { ChatClient } from "./chat-client.js";
import type { UsageTotals } from "./extraction-common.js";
import {
  addUsage,
  assertStopFinishReason,
  buildGroupMessages,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
} from "./extraction-common.js";
import type { ExtractOptions } from "@azx/ribo-core";
import { MAX_NULLABLE_UNIONS_PER_CALL, splitExtractionSchema } from "./split-schema.js";
import type { ExtractionGroup } from "./split-schema.js";

/** Options for {@link perGroupExtractor}. */
export interface PerGroupOptions<V extends Record<string, unknown>, P = NoProvenance>
  extends BackoffOptions, ExtractionObserver<GroupUnit>, RetryBudgetObserver {
  /** The field knowledge: `name`, `extractionSchema`, `instructions`, and few-shot `examples`. */
  readonly target: ExtractionTarget<V, P>;
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
  readonly normalize?: (fields: Enveloped<V, P>) => Enveloped<V, P>;
  /**
   * Max concurrent group calls. The calls run concurrently with a bounded pool so
   * the worst case (all groups plus their inner retries plus their backoff
   * delays) fits inside the relay's `stepTimeoutMs` — seven sequential calls
   * would not. Defaults to 4.
   */
  readonly concurrency?: number;
  /**
   * Max retries per group after a transient failure (so the total attempts per
   * group is `maxRetries + 1`). Terminal failures ({@link TerminalQueueError} —
   * truncation, content filtering, refusal, unsupported) are never retried and
   * never delay. Defaults to 2. The default is derived from the step-timeout
   * relationship — see {@link perGroupExtractor} and the comment where it caps
   * the retry budget.
   */
  readonly maxRetries?: number;
  /**
   * The relay's step timeout — the wall-clock ceiling inside which all group
   * calls plus their retries plus their backoff delays must complete. The relay
   * wraps `extract()` in `withTimeout(stepTimeoutMs)`; a timeout here presents as
   * a failed extraction with no indication that some groups succeeded. Defaults
   * to `900_000` (15 minutes), matching the relay's `DEFAULT_STEP_TIMEOUT_MS`.
   * The retry budget is capped so the worst case fits inside this — see the
   * comment in {@link perGroupExtractor}.
   */
  readonly stepTimeoutMs?: number;
  /**
   * Conservative upper bound on one chat call's wall-clock duration, used to
   * derive the retry budget from the step-timeout relationship. Defaults to
   * {@link PER_CALL_CEILING_MS} (120,000 ms), the measured ceiling for the
   * managed transport. A faster transport (e.g., on-device) should lower this so
   * the retry budget is sized honestly.
   */
  readonly perCallCeilingMs?: number;
  /**
   * Injectable sleep used between retry attempts, so tests do not wait real
   * seconds. Defaults to `setTimeout`. The value passed is the
   * {@link fullJitterDelay} result in milliseconds.
   */
  readonly delay?: (ms: number) => Promise<void>;
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
  /**
   * If true, collection groups are constrained to a **single element** per group
   * call. The response is parsed as a singleton object and then wrapped back into a
   * one-element array before the full-schema parse, so the final result still
   * matches the original extraction schema. This is the Tier 3 degraded strategy:
   * it cannot represent a second instance per group. Defaults to `false` (array
   * responses, Tier 2).
   */
  readonly singleton?: boolean;
  /**
   * Max nullable unions per call before a group is partitioned across multiple
   * calls sharing its key ({@link splitExtractionSchema}'s
   * `maxNullableUnionsPerGroup`). Defaults to
   * {@link MAX_NULLABLE_UNIONS_PER_CALL}, the cap measured against Anthropic-family
   * models on the managed route — not an established vendor limit (see
   * `split-schema.ts`'s file header). A caller whose route is bound by a
   * different limit — the pinned OpenAI-compatible route's constraint is a byte
   * cap, not a union count — supplies its own number rather than inheriting one
   * sized for another provider.
   *
   * Counted in unions rather than enveloped leaves so the number means the same
   * thing whatever provenance granularity a group declared: an enveloped leaf
   * costs two, a plain `"row"`/`"none"` leaf costs one, and a row's `sourceSpan`
   * costs one. A leaf count would split a 15-leaf row group for no gain.
   */
  readonly maxNullableUnionsPerGroup?: number;
}

/**
 * The default {@link PerGroupOptions.delay} — a real `setTimeout` sleep. Tests
 * inject a fake that records the value and resolves immediately.
 */
const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The leaf keys one partitioned piece of a group asks the model for — read back
 * out of `group.schema` rather than threaded through as separate state, so this
 * can never drift from the schema the call is actually pinned to.
 *
 * `group.schema` is `z.strictObject({ [group.key]: value })`, where `value` is
 * either the piece's narrowed group object (a singleton group, e.g. `health`) or
 * a `ZodArray` of it (a collection group, e.g. `hvac`) — {@link partitionGroup}'s
 * output shape. This unwraps the same way `splitExtractionSchema`'s own
 * `groupCandidate` does, to reach the object whose keys are this piece's leaves.
 */
export function partitionedLeafKeys(group: ExtractionGroup): readonly string[] {
  const shape = (group.schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodType>;
  const value = shape[group.key]!;
  const candidate = value instanceof z.ZodArray ? (value.element as z.ZodType) : value;
  return Object.keys((candidate as z.ZodObject<z.ZodRawShape>).shape);
}

/** A group with its JSON Schema and error-context pre-computed at construction time. */
interface PreparedGroup {
  /**
   * The original group entry from {@link splitExtractionSchema}, including
   * `part`/`parts` when the group's leaves were partitioned across multiple
   * calls (see the file header's "Leaf-count partitioning" in `split-schema.ts`).
   */
  readonly group: ExtractionGroup;
  /**
   * The schema this call is parsed against. Under singleton mode this may be a
   * narrowed single-element schema; otherwise it is the same as `group.schema`.
   */
  readonly schema: z.ZodType;
  /** The JSON Schema sent to the model in `response_format`. */
  readonly jsonSchema: Record<string, unknown>;
  /** The `response_format.json_schema.name` — identifies the group in the request. */
  readonly name: string;
  /** The descriptive prefix for error messages from this group's call. */
  readonly context: string;
  /**
   * True when the original group is a collection but singleton mode narrowed the
   * request to one element; the parsed response must be wrapped back into a
   * one-element array before the full schema sees it.
   */
  readonly wrapToArray: boolean;
  /**
   * The leaf keys THIS piece asks the model for, present only when `group.part`
   * is defined (the group was partitioned). Passed to {@link buildGroupMessages}
   * so a few-shot example narrows to the same subset the `response_format`
   * constrains this call to, rather than showing the model an example carrying
   * fields this call cannot produce.
   */
  readonly leafKeys?: readonly string[];
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
 *        `maxRetries` times while successful groups are held, with
 *        {@link fullJitterDelay} backoff between attempts. Terminal failures
 *        ({@link TerminalQueueError}) are never retried and never delay. If a
 *        group still fails, `extract()` throws and the relay's existing
 *        machinery takes over unchanged.
 *      - **Pre-parse check** ({@link assertStopFinishReason}): reject a
 *        non-`"stop"` completion before parsing, so truncation is not
 *        misreported as invalid JSON. Terminal, not retried.
 *      - **First trust-boundary parse** ({@link parseWithSchema}): parse the
 *        response against its own group schema.
 *   4. Merge the parsed responses by top-level key: ordinarily each response has
 *      exactly one key so assignment produces the whole, but a group carrying more
 *      nullable unions than {@link MAX_NULLABLE_UNIONS_PER_CALL} was partitioned by
 *      {@link splitExtractionSchema} into multiple entries sharing one key
 *      (`ExtractionGroup.part`/`parts`) — those pieces' responses are recombined
 *      (see {@link mergeGroupPieces}) rather than one overwriting the other.
 *   5. **Second trust-boundary parse**: parse the merged whole against the full
 *      `extractionSchema`. Catches a merge that produced a shape no single call
 *      would have.
 *   6. **Normalize once** on the merged result.
 *
 * `usage.calls` reports the real number of calls made, including retries.
 */
export function perGroupExtractor<V extends Record<string, unknown>, P = NoProvenance>({
  target,
  chat,
  model,
  maxTokens,
  normalize = (fields) => fields,
  concurrency = 4,
  maxRetries = 2,
  stepTimeoutMs = 900_000,
  perCallCeilingMs = PER_CALL_CEILING_MS,
  delay = defaultDelay,
  baseMs,
  capMs,
  random,
  groupInstructions,
  singleton = false,
  maxNullableUnionsPerGroup,
  onUnit,
  onRetryBudget,
  requireRetryBudget = false,
}: PerGroupOptions<V, P>): Extractor<Enveloped<V, P>> {
  // Split at construction time — the group list is a pure function of the schema
  // and does not depend on the transcript. A non-grouped schema yields one entry
  // covering the whole schema (key: ""), which makes one call — today's behaviour.
  //
  // The cap is always supplied (defaulting to MAX_NULLABLE_UNIONS_PER_CALL) so a
  // group that would overflow one call's response schema is partitioned here
  // rather than rejected provider-side — see split-schema.ts's file header for the
  // limit the default is derived from. A caller whose route is bound by a
  // different limit opts into its own number via `maxNullableUnionsPerGroup`.
  //
  // It is counted in NULLABLE UNIONS rather than leaves, which is what lets a group
  // that declared `"row"` or `"none"` provenance fit in one call instead of being
  // split for nothing. The two units coincide exactly while every leaf is enveloped
  // (two unions each), so this changed no existing partition boundary.
  const groups = splitExtractionSchema(
    target.extractionSchema,
    maxNullableUnionsPerGroup ?? MAX_NULLABLE_UNIONS_PER_CALL,
  );

  // Pre-compute each group's JSON Schema and error-context at construction time.
  // The JSON Schema generation (`z.toJSONSchema`) is not cheap, and the schema
  // does not change between calls.
  const prepared: readonly PreparedGroup[] = groups.map((group) => {
    let schema: z.ZodType = group.schema;
    let wrapToArray = false;

    // Singleton mode: a collection group is narrowed to one element per call. The
    // model emits a single object and the response is wrapped back into an array
    // before the full schema sees it — so the result still validates against the
    // original collection schema while being unable to represent a second instance.
    // This operates on `group.schema` regardless of whether it is a whole group or
    // one partitioned piece — a piece's schema has the identical
    // `{ [key]: ZodArray | ZodObject }` shape, just over fewer leaves, so this
    // narrowing needs no change to see a piece.
    if (singleton && group.key !== "" && group.schema instanceof z.ZodObject) {
      const shape = (group.schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodType>;
      const value = shape[group.key];
      if (value instanceof z.ZodArray) {
        schema = z.strictObject({ [group.key]: value.element });
        wrapToArray = true;
      }
    }

    const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<
      string,
      unknown
    >;
    // `-`, not `:` — a structured-output schema name is constrained to
    // [A-Za-z0-9_-] by at least one platform route (Helix rejects a colon with a
    // generic `400 validation_failed`, which reads identically to an over-cap
    // schema and costs an afternoon to tell apart). Keep the separator inside the
    // charset every route accepts. A partitioned piece appends `-<part>` so two
    // calls sharing a group key (e.g. `hvac`) still get distinct names.
    const partSuffix = group.part !== undefined ? `-${group.part}` : "";
    const name = group.key ? `${target.name}-${group.key}${partSuffix}` : target.name;
    const context = group.key
      ? group.part !== undefined
        ? `perGroupExtractor: model response for "${target.name}" group "${group.key}" (part ${group.part + 1}/${group.parts})`
        : `perGroupExtractor: model response for "${target.name}" group "${group.key}"`
      : `perGroupExtractor: model response for "${target.name}"`;
    // Only a partitioned piece needs its few-shot example narrowed — an
    // unpartitioned group's example already carries exactly its leaves.
    const leafKeys = group.part !== undefined ? partitionedLeafKeys(group) : undefined;
    return { group, schema, jsonSchema, name, context, wrapToArray, leafKeys };
  });

  // The relay wraps extract() in withTimeout(stepTimeoutMs). All group calls
  // plus their retries plus their backoff delays must fit inside it. The worst
  // case — every group exhausting its full retry budget — runs this many
  // sequential chat calls:
  //
  //   ceil(G / concurrency) * (effectiveMaxRetries + 1)
  //
  // where G = prepared.length, each call taking up to `perCallCeilingMs`, and
  // between calls a backoff delay of up to min(cap, base * 2^attempts). We
  // derive effectiveMaxRetries so the worst case — call time PLUS accumulated
  // backoff — fits within stepTimeoutMs. A caller who lowers stepTimeoutMs or
  // perCallCeilingMs gets a proportionally lower retry budget rather than a step
  // timeout that presents as a bare extraction failure with no indication that
  // some groups succeeded.
  //
  // The revised relationship is:
  //
  //   ceil(G / concurrency) * ((maxRetries + 1) * perCallCeilingMs
  //                             + maxAccumulatedBackoff(maxRetries)) <= stepTimeoutMs
  //
  // With the defaults (stepTimeoutMs = 900_000, concurrency = 4,
  // maxRetries = 2, perCallCeilingMs = 120_000, base = 1_000, cap = 300_000)
  // and the Snugg target's 7 groups: maxAccumulatedBackoff(2) = 1_000 + 2_000 =
  // 3_000; per-group budget = 3 * 120_000 + 3_000 = 363_000; worst case =
  // ceil(7/4) * 363_000 = 726_000 — inside the 15-minute step timeout.
  const backoffBaseMs = baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const backoffCapMs = capMs ?? DEFAULT_BACKOFF_CAP_MS;
  const batches = Math.ceil(prepared.length / concurrency);
  const budget = deriveRetryBudget({
    requested: maxRetries,
    batches,
    stepTimeoutMs,
    perCallCeilingMs,
    baseMs: backoffBaseMs,
    capMs: backoffCapMs,
  });
  const effectiveMaxRetries = budget.derived;
  // Fire onRetryBudget only when the budget was reduced — a consumer that asked
  // for 5 and got 5 has nothing to act on. The default must stay non-throwing:
  // the current production wiring derives to zero, so throwing by default would
  // break the live path in the same change that makes it visible (§0.5).
  if (budget.derived < budget.requested) {
    onRetryBudget?.(budget);
  }
  if (requireRetryBudget && budget.derived === 0 && budget.requested > 0) {
    throw new Error(
      `perGroupExtractor: retry budget derived to 0 (requested ${budget.requested}) — ` +
        `increase stepTimeoutMs (${stepTimeoutMs}), lower perCallCeilingMs (${perCallCeilingMs}), ` +
        `or lower concurrency (${concurrency}) to fit at least one retry`,
    );
  }
  // Pre-compute the backoff options object once — passed to fullJitterDelay on
  // every retry. The random function defaults to Math.random inside
  // fullJitterDelay when not supplied here.
  const backoffOpts: BackoffOptions = { baseMs: backoffBaseMs, capMs: backoffCapMs, random };

  return {
    async extract(
      transcript: AnnotatedTranscript,
      options?: ExtractOptions,
    ): Promise<ExtractionResult<Enveloped<V, P>>> {
      // One AbortController for the whole extraction. When any group fails
      // (terminally or past its retry budget), abort is called: in-flight calls
      // in other workers reject with ChatError.aborted, and workers stop
      // pulling new work (mapWithPool checks the signal). This prevents the
      // calls-outlive-extract() waste that retries would multiply.
      const abort = new AbortController();
      let totalCalls = 0;

      const totals: UsageTotals = {};
      const responses = await mapWithPool(
        prepared,
        concurrency,
        async (entry) => {
          // Message assembly runs once per entry — OUTSIDE the retry loop.
          // The retry wraps only the chat call, not the prompt construction.
          const messages = buildGroupMessages(
            target,
            entry.group.key,
            transcript.text,
            groupInstructions,
            singleton,
            entry.leafKeys,
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

          // Mint one id per prepared entry before the loop — stable across every
          // attempt of this entry, so a consumer correlates start/done/error
          // without bookkeeping. attempt is what distinguishes retries.
          const id = nextUnitId();
          const key = entry.group.key;
          // Internal representation is 0-based and optional; the event is 1-based
          // and always present, with an unpartitioned group reporting part: 1,
          // parts: 1 — a consumer must not need two code paths for "one" and "several".
          const part = (entry.group.part ?? 0) + 1;
          const parts = entry.group.parts ?? 1;

          let lastError: unknown;
          for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
            // If a sibling group's failure has aborted the extraction, don't
            // start a new call — propagate so this worker stops. mapWithPool
            // checks the signal before pulling new work; this check catches
            // the case where the abort fires between retry attempts.
            // `any`, not `??`: the caller's signal and this run's sibling-failure abort are
            // two independent reasons to stop, and `??` discarded the second whenever a caller
            // supplied the first.
            const effectiveSignal = options?.signal
              ? AbortSignal.any([options.signal, abort.signal])
              : abort.signal;
            if (effectiveSignal.aborted) {
              const aborted =
                lastError ?? new Error("perGroupExtractor: aborted by a sibling failure");
              // NO event here, deliberately, and for two independent reasons.
              //
              // This check runs at the TOP of the loop, before this iteration's
              // `start`, so attempt `attempt + 1` never began — announcing it
              // would invent a retry that did not happen, and `attempt` is the
              // only way a retry is observable at all. Re-reporting `attempt`
              // is no better: when it is > 0 that attempt already settled with
              // its own `error` in the catch below, and when it is 0 nothing
              // started at all.
              //
              // And the timing is worse than the numbering. `mapWithPool` uses
              // `Promise.all`, so `extract()` rejects the instant a sibling
              // fails — while this worker may still be asleep in its backoff.
              // Anything emitted here therefore arrives AFTER the extraction
              // has settled, telling a progress panel that a finished run is
              // still going. The unit's last live attempt is already reported;
              // that no further attempt follows is said by the absence of a
              // next `start`.
              throw aborted;
            }

            onUnit?.({ id, unit: "group", phase: "start", attempt: attempt + 1, key, part, parts });

            totalCalls++;
            try {
              const completion = await completeOrClassify(chat, request, entry.context, {
                signal: effectiveSignal,
              });

              // Before the finish-reason and schema gates, so a truncated or
              // rejected response still counts the tokens it burned. Retries
              // accumulate too — `usage.calls` already counts them, and a token
              // total that silently excluded them would disagree with it.
              addUsage(totals, completion.usage);

              assertStopFinishReason(completion, entry.context);

              const raw = parseJsonContent(completion.content, entry.context);

              // First trust-boundary parse: validate against this group's own
              // schema. A response carrying another group's key is rejected
              // here — the split narrows rather than merely relabels. Under
              // singleton mode this is the narrowed single-element schema, so a
              // multi-instance response is rejected before it can be wrapped.
              const parsed = parseWithSchema(entry.schema, raw, entry.context);
              onUnit?.({
                id,
                unit: "group",
                phase: "done",
                attempt: attempt + 1,
                key,
                part,
                parts,
                // Omitted rather than set to `undefined` when the transport
                // reports nothing: absent means "not reported", and this repo
                // already keeps that distinction load-bearing for
                // `ExtractionUsage.cachedPromptTokens`. `usage: undefined` would
                // still answer `"usage" in event` with true.
                ...(completion.usage !== undefined
                  ? {
                      usage: {
                        inputTokens: completion.usage.promptTokens,
                        outputTokens: completion.usage.completionTokens,
                      },
                    }
                  : {}),
              });
              return parsed;
            } catch (cause) {
              lastError = cause;
              onUnit?.({
                id,
                unit: "group",
                phase: "error",
                attempt: attempt + 1,
                key,
                part,
                parts,
                error: cause,
              });
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
              // Transient failure — back off before the next attempt if budget
              // remains. fullJitterDelay takes the failure count before this
              // failure (matching the relay's convention), so the first retry
              // draws from [0, base]. The delay is injected so tests do not
              // sleep; the default is a real setTimeout. After the delay, the
              // loop's top-of-iteration abort check catches a sibling failure
              // that fired while we were sleeping.
              if (attempt < effectiveMaxRetries) {
                await delay(fullJitterDelay(attempt, backoffOpts));
              }
            }
          }
          // Budget exhausted — rethrow the last transient error. The error
          // event for the final attempt was already fired in the catch above;
          // this throw propagates to the relay's existing backoff, attempt
          // count and dead handling unchanged.
          throw lastError;
        },
        abort,
      );

      // Merge by shallow assignment — each grouped response has exactly one
      // top-level key, so assigning in sequence produces the whole without
      // re-keying. In singleton mode, collection-group responses are wrapped back
      // into a one-element array so the merged shape still validates against the
      // original extraction schema. `responses` is index-aligned with `prepared`
      // (mapWithPool preserves order), so pairing them by index — rather than
      // reading each response's own keys — is what lets two entries share the
      // same `group.key` (a partitioned group's pieces) without one clobbering
      // the other.
      const merged: Record<string, unknown> = {};
      for (let i = 0; i < prepared.length; i++) {
        const entry = prepared[i]!;
        // Each response parsed against a strict object schema is a record with
        // string keys. The cast is safe because the first trust-boundary parse
        // already validated the shape.
        const response = responses[i] as Record<string, unknown>;

        if (entry.group.key === "") {
          // The non-grouped fallback: the response IS the whole merged object
          // already (its schema is the full extraction schema, not a one-key
          // slice) — assign its keys directly rather than nesting under "".
          Object.assign(merged, response);
          continue;
        }

        const key = entry.group.key;
        const raw = response[key];
        const value = entry.wrapToArray ? [raw] : raw;
        // A key already present in `merged` means an earlier piece of the SAME
        // partitioned group already contributed its slice — recombine rather
        // than overwrite. See `mergeGroupPieces`.
        merged[key] = key in merged ? mergeGroupPieces(merged[key], value) : value;
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
        usage: { calls: totalCalls, ...totals },
      };
    },
  };
}

/**
 * Tier 2 of the instance-modeling ladder: per-group calls where the model emits
 * the full array for each collection group. This is the default {@link perGroupExtractor}
 * behaviour, exposed as a named strategy so the ladder and the tests can refer
 * to it unambiguously.
 */
export function perGroupArrayExtractor<V extends Record<string, unknown>, P = NoProvenance>(
  options: PerGroupOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  return perGroupExtractor({ ...options, singleton: false });
}

/**
 * Tier 3 of the instance-modeling ladder: a degraded per-group strategy where
 * each collection group is constrained to a single element per call. The parsed
 * singleton is wrapped back into a one-element array so the result still matches
 * the original extraction schema, but the model cannot represent a second
 * instance per group.
 */
export function perGroupSingletonExtractor<V extends Record<string, unknown>, P = NoProvenance>(
  options: PerGroupOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  return perGroupExtractor({ ...options, singleton: true });
}
