/**
 * @file Task 10 — scoped per-instance fills and assembly.
 *
 * One house-wide inventory pass decides how many recordable instances exist in each
 * collection group. Then each `current` candidate gets one fill call against the
 * same flat group schema the per-group extractor already uses: the response is a
 * single object, never an array, so segmentation is decided once. The prompt adds a
 * scope block between the rules and the transcript that names the positive record,
 * the negative siblings whose facts belong elsewhere, and any excluded candidates.
 *
 * The assembly is generic: the caller supplies an `inventory` function and a
 * `buildFillInstructions` callback that renders the scope block in the host tool's
 * natural language. For Snugg Pro that callback lives in the adapter's
 * `instructions.ts`.
 */

import { z } from "zod";

import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  deriveRetryBudget,
  fullJitterDelay,
  nextUnitId,
  PER_CALL_CEILING_MS,
  TerminalQueueError,
} from "@azx/ribo-core";
import type {
  AnnotatedTranscript,
  BackoffOptions,
  Enveloped,
  ExtractionObserver,
  Extractor,
  ExtractionResult,
  ExtractionTarget,
  FillScope,
  InventoryUnit,
  InstanceUnit,
  NoProvenance,
  RetryBudgetObserver,
  Roster,
  RosterCandidate,
} from "@azx/ribo-core";

import type { ChatClient, ChatMessage, ChatRequest } from "./chat-client.js";
import type { UsageTotals } from "./extraction-common.js";
import {
  addUsage,
  assertStopFinishReason,
  buildMessages,
  completeOrClassify,
  narrowToLeaves,
  parseJsonContent,
  parseWithSchema,
} from "./extraction-common.js";
import type { ExtractOptions } from "@azx/ribo-core";
import { mergeGroupPieces, partitionedLeafKeys } from "./per-group.js";
import { MAX_NULLABLE_UNIONS_PER_CALL, splitExtractionSchema } from "./split-schema.js";

// Re-export the generic inventory/fill vocabulary from core, where both the
// adapter and the extractor strategy can reach it without a package cycle.
export type { FillScope, Roster, RosterCandidate } from "@azx/ribo-core";

/**
 * Options for {@link scopedInstanceExtractor}.
 *
 * The retry budget is derived per `extract()` call, after the roster is back,
 * because the job count is not known until then. This is a real difference from
 * {@link perGroupExtractor}, which derives at construction and throws there:
 * a zero-derived budget with `requireRetryBudget` throws a
 * {@link TerminalQueueError} from `extract()`, not at construction — no retry
 * fixes a configuration error, and the queue should reach `dead` rather than
 * burn its attempt budget rediscovering that.
 */
export interface ScopedFillOptions<V extends Record<string, unknown>, P = NoProvenance>
  extends BackoffOptions, ExtractionObserver<InventoryUnit | InstanceUnit>, RetryBudgetObserver {
  /** The field knowledge: name, extraction schema, instructions, and examples. */
  readonly target: ExtractionTarget<V, P>;
  /** The injected chat transport. A fake in tests; a real client in production. */
  readonly chat: ChatClient;
  /** The model id passed through to the endpoint. */
  readonly model: string;
  /** Cap on generated tokens, passed through to each chat request. */
  readonly maxTokens?: number;
  /**
   * The deterministic, model-free pass run AFTER the second trust-boundary parse.
   * Defaults to identity.
   */
  readonly normalize?: (fields: Enveloped<V, P>) => Enveloped<V, P>;
  /**
   * Max concurrent fill calls. Defaults to 4. The inventory call is always serial
   * before any fill can fan out.
   */
  readonly concurrency?: number;
  /** Max retries per fill call after a transient failure. Defaults to 2. */
  readonly maxRetries?: number;
  /** Wall-clock ceiling for the whole extraction. Defaults to 15 minutes. */
  readonly stepTimeoutMs?: number;
  /** Conservative upper bound on one chat call's duration. Defaults to 2 minutes. */
  readonly perCallCeilingMs?: number;
  /** Injectable sleep between retries. Defaults to `setTimeout`. */
  readonly delay?: (ms: number) => Promise<void>;
  /** The house-wide inventory pass. Must return a {@link Roster}. */
  readonly inventory: (transcript: string) => Promise<Roster>;
  /**
   * Build the scoped per-instance fill instructions for a group. The adapter owns
   * the natural-language rendering; the extractor owns the calling pattern.
   */
  readonly buildFillInstructions: (groupKey: string, scope: FillScope) => string;
  /**
   * Hard ceiling on `current` instances per group. Exceeding it throws rather than
   * truncating, because a truncated collection silently drops a real system.
   * Defaults to 10.
   */
  readonly instanceCap?: number;
  /**
   * Max nullable unions per fill call before a group is partitioned across
   * multiple calls sharing its key, one per piece per instance
   * ({@link splitExtractionSchema}'s `maxNullableUnionsPerGroup`). Defaults to
   * {@link MAX_NULLABLE_UNIONS_PER_CALL}, the cap measured against Anthropic-family
   * models on the managed route — not an established vendor limit; a caller
   * whose route is bound by a different limit (the pinned OpenAI-compatible
   * route's is a byte cap) supplies its own number. Partitioning multiplies fill
   * calls per instance, never the instance count — the roster and `instanceCap`
   * are unaffected.
   *
   * Counted in unions rather than enveloped leaves, so the number means the same
   * thing whatever provenance granularity a group declared — see
   * {@link PerGroupOptions.maxNullableUnionsPerGroup}.
   */
  readonly maxNullableUnionsPerGroup?: number;
}

/**
 * Default hard ceiling on current instances per group. The cap exists to fail loudly
 * rather than silently truncate a collection.
 */
const DEFAULT_INSTANCE_CAP = 10;

/**
 * The default {@link ScopedFillOptions.delay} — a real `setTimeout` sleep. Tests
 * inject a fake that records the value and resolves immediately.
 */
const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` over `items` with at most `limit` calls in flight at once, preserving
 * order. Rejects on the first failure and aborts in-flight work. Same logic as
 * {@link perGroupExtractor}.
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

/** A prepared group, with its per-instance fill schema and error context. */
interface PreparedGroup {
  /** The top-level group key. Empty for the non-grouped fallback. */
  readonly key: string;
  /**
   * Whether the group is a collection of instances. Collection groups are
   * `z.array(ElementSchema)`; singleton groups are a single element schema.
   */
  readonly isCollection: boolean;
  /**
   * The schema the fill response is parsed against — one object with one
   * top-level key. For a partitioned piece this carries only that piece's leaf
   * subset, because `splitExtractionSchema` hands back each piece as its own
   * entry and the array-vs-singleton narrowing is blind to partitioning.
   */
  readonly schema: z.ZodType;
  /** The JSON Schema sent to the model in `response_format`. */
  readonly jsonSchema: Record<string, unknown>;
  /** The base for `response_format.json_schema.name`. */
  readonly name: string;
  /** The descriptive prefix for error messages from this group's calls. */
  readonly context: string;
  /**
   * This entry's 0-based position among the pieces sharing `key`, present only
   * when the group's leaves were partitioned across multiple calls. Pieces of
   * one key are filled independently and recombined per instance at assembly —
   * see the merge step in {@link scopedInstanceExtractor}.
   */
  readonly part?: number;
  /** The total number of pieces sharing `key`, present exactly when `part` is. */
  readonly parts?: number;
  /**
   * The leaf keys THIS piece asks the model for, present only when `part` is
   * defined. Passed to {@link buildFillMessages} so a partitioned piece's
   * few-shot example is narrowed to the same subset its `response_format`
   * accepts, rather than showing an assistant turn wider than the call allows.
   */
  readonly leafKeys?: readonly string[];
}

/**
 * One per-instance fill call: messages, schema, and naming.
 *
 * For singleton groups the job still has one instance, but the scope is a
 * placeholder because there is exactly one record to fill.
 */
interface FillJob {
  readonly group: PreparedGroup;
  readonly instanceIndex: number;
  /** The number of current candidates in this job's group — 1 for singletons. */
  readonly instances: number;
  readonly messages: ChatMessage[];
  readonly requestName: string;
  readonly context: string;
}

/**
 * Project a few-shot example to the single-instance shape a fill call imitates.
 *
 * If the group is a collection, the example's value is an array; the projected
 * assistant turn carries only the element at `instanceIndex`, falling back to the
 * first element if the example has fewer instances. If the example is not an array,
 * the value is used unchanged. Returns `null` when the group key is absent or the
 * array is empty.
 *
 * When `leafKeys` is supplied (a partitioned piece), the projected instance is
 * further narrowed to exactly those leaves — the same narrowing
 * {@link buildGroupMessages} applies for the per-group extractor, so the
 * example's assistant turn never carries fields the piece's `response_format`
 * rejects.
 */
export function projectFillExample<F extends Record<string, unknown>>(
  example: { readonly transcript: string; readonly fields: F },
  groupKey: string,
  instanceIndex: number,
  leafKeys?: readonly string[],
): { readonly transcript: string; readonly fields: Record<string, unknown> } | null {
  const fields = example.fields as Record<string, unknown>;
  if (!(groupKey in fields)) return null;
  const groupValue = fields[groupKey];
  const narrow = (element: unknown): unknown =>
    leafKeys ? narrowToLeaves(element, leafKeys) : element;
  if (Array.isArray(groupValue)) {
    const element = groupValue[instanceIndex] ?? groupValue[0];
    if (element === undefined) return null;
    return { transcript: example.transcript, fields: { [groupKey]: narrow(element) } };
  }
  return { transcript: example.transcript, fields: { [groupKey]: narrow(groupValue) } };
}

/**
 * Assemble the chat messages for a scoped per-instance fill call.
 *
 * The system message is the scoped per-group instructions from
 * `buildFillInstructions`. Each few-shot example is projected to a single-instance
 * assistant turn so the model does not imitate the array shape of a multi-instance
 * example. The transcript is the final user message — the injection boundary is
 * preserved.
 *
 * `leafKeys` is supplied for a partitioned piece (`ExtractionGroup.part`) so the
 * example's assistant turn is narrowed to the same leaf subset the piece's
 * `response_format` accepts — mirroring {@link buildGroupMessages}' `leafKeys`.
 */
export function buildFillMessages<V extends Record<string, unknown>, P = NoProvenance>(
  target: ExtractionTarget<V, P>,
  groupKey: string,
  instanceIndex: number,
  scope: FillScope,
  transcript: string,
  buildFillInstructions: (groupKey: string, scope: FillScope) => string,
  leafKeys?: readonly string[],
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: buildFillInstructions(groupKey, scope) },
  ];
  for (const example of target.examples ?? []) {
    const projected = projectFillExample(example, groupKey, instanceIndex, leafKeys);
    if (projected === null) continue;
    messages.push({ role: "user", content: projected.transcript });
    messages.push({ role: "assistant", content: JSON.stringify(projected.fields) });
  }
  messages.push({ role: "user", content: transcript });
  return messages;
}

/** Build the {@link FillScope} for a collection group's current candidate. */
function buildFillScope(
  groupKey: string,
  rosterGroup: readonly RosterCandidate[],
  candidate: RosterCandidate,
  candidateIndex: number,
): FillScope {
  const current = rosterGroup.filter((c) => c.eligibility === "current");
  return {
    groupKey,
    positive: candidate,
    positiveIndex: candidateIndex,
    siblings: current.filter((_, index) => index !== candidateIndex),
    excluded: rosterGroup.filter((c) => c.eligibility !== "current"),
  };
}

/** A placeholder scope for singleton groups that have no roster candidates. */
function singletonFillScope(groupKey: string): FillScope {
  return {
    groupKey,
    positive: {
      mentionSpan: "",
      discriminator: `the ${groupKey} record`,
      distinguishedBy: null,
      eligibility: "current",
      eligibilitySpan: null,
    },
    positiveIndex: 0,
    siblings: [],
    excluded: [],
  };
}

/**
 * Build a scoped per-instance {@link Extractor} for a target.
 *
 * On each `extract`:
 *   1. Run `inventory(transcript)` to get a roster of candidates per group.
 *      One call, regardless of how any group's leaves are partitioned below.
 *   2. For each top-level group from {@link splitExtractionSchema} — called
 *      with the leaf cap, so a group whose per-instance leaf count exceeds it
 *      arrives as one entry per piece, each carrying only its piece's leaves:
 *      - Collection groups (`z.array(...)`): one fill call per `current`
 *        candidate PER PIECE. A group with no `current` candidates yields an
 *        empty array and makes no calls. The instance cap is enforced before
 *        any call is made — partitioning changes leaf count per call, never
 *        instance count.
 *      - Singleton groups: one fill call per piece, otherwise unchanged.
 *   3. Run fill calls concurrently with a bounded pool. For each response:
 *      - Pre-parse `finishReason` check.
 *      - Parse against the single-instance wrapper schema for that group piece.
 *   4. Merge per-instance responses into their group's array in roster order.
 *      Pieces sharing one `(group, instance)` slot are recombined with
 *      {@link mergeGroupPieces} — the same recombination the per-group
 *      extractor applies at group level — rather than the last piece
 *      overwriting the others' leaves.
 *   5. Second trust-boundary parse against the full `extractionSchema`, then normalize.
 */
export function scopedInstanceExtractor<V extends Record<string, unknown>, P = NoProvenance>(
  options: ScopedFillOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  const {
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
    inventory,
    buildFillInstructions,
    instanceCap = DEFAULT_INSTANCE_CAP,
    maxNullableUnionsPerGroup,
    onUnit,
    onRetryBudget,
    requireRetryBudget,
  } = options;

  const backoffOpts: BackoffOptions = {
    baseMs: baseMs ?? DEFAULT_BACKOFF_BASE_MS,
    capMs: capMs ?? DEFAULT_BACKOFF_CAP_MS,
    random,
  };

  // The union cap defaults to the same ceiling the per-group extractor applies,
  // for the same reason: an over-cap per-instance schema is rejected
  // provider-side, and tier 1 was the one strategy still sending every group
  // whole. `maxNullableUnionsPerGroup` lets a caller tune it to its route's real limit.
  const groups = splitExtractionSchema(
    target.extractionSchema,
    maxNullableUnionsPerGroup ?? MAX_NULLABLE_UNIONS_PER_CALL,
  );
  const prepared: readonly PreparedGroup[] = groups.map((group) => {
    let schema: z.ZodType;
    let isCollection = false;

    if (group.key !== "" && group.schema instanceof z.ZodObject) {
      const shape = (group.schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodType>;
      const value = shape[group.key];
      if (value instanceof z.ZodArray) {
        isCollection = true;
        schema = z.strictObject({ [group.key]: value.element });
      } else {
        schema = group.schema;
      }
    } else {
      schema = group.schema;
    }

    const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<
      string,
      unknown
    >;
    // A partitioned piece appends `-<part>` so fill calls sharing a group key
    // still get distinct schema names — the same charset-safe suffixing
    // perGroupExtractor uses, and for the same reason.
    const partSuffix = group.part !== undefined ? `-${group.part}` : "";
    const name = group.key
      ? `${target.name}-${group.key}-fill${partSuffix}`
      : `${target.name}-fill`;
    const context = group.key
      ? group.part !== undefined
        ? `scopedInstanceExtractor: fill for "${target.name}" group "${group.key}" (part ${group.part + 1}/${group.parts})`
        : `scopedInstanceExtractor: fill for "${target.name}" group "${group.key}"`
      : `scopedInstanceExtractor: fill for "${target.name}"`;
    // Only a partitioned piece needs its few-shot example narrowed — an
    // unpartitioned group's example already carries exactly its leaves.
    const leafKeys = group.part !== undefined ? partitionedLeafKeys(group) : undefined;
    return {
      key: group.key,
      isCollection,
      schema,
      jsonSchema,
      name,
      context,
      part: group.part,
      parts: group.parts,
      leafKeys,
    };
  });

  return {
    async extract(
      transcript: AnnotatedTranscript,
      options?: ExtractOptions,
    ): Promise<ExtractionResult<Enveloped<V, P>>> {
      const inventoryId = nextUnitId();
      onUnit?.({ id: inventoryId, unit: "inventory", phase: "start", attempt: 1 });
      let roster: Roster;
      try {
        roster = await inventory(transcript.text);
      } catch (cause) {
        onUnit?.({ id: inventoryId, unit: "inventory", phase: "error", attempt: 1, error: cause });
        throw cause;
      }
      // No usage on the inventory done event: `inventory` is a caller-supplied
      // function returning a Roster, not a completion, so its cost never reaches
      // this extractor. That is the same gap already documented where the
      // inventory call is counted in `usage.calls` but not in the token totals.
      onUnit?.({ id: inventoryId, unit: "inventory", phase: "done", attempt: 1 });
      let totalCalls = 1; // the inventory call

      const abort = new AbortController();
      const jobs: FillJob[] = [];
      const collectionArrays: Record<string, unknown[]> = {};
      const groupResult: Record<string, unknown> = {};
      const statedEmptyGroups: Record<string, string> = {};

      for (const group of prepared) {
        const rosterGroup = roster[group.key] ?? [];

        if (!group.isCollection || group.key === "") {
          // Singleton or non-grouped fallback: one fill call per piece, no
          // scope semantics.
          const scope = singletonFillScope(group.key || "fields");
          const messages =
            group.key === ""
              ? buildMessages(target, transcript.text)
              : buildFillMessages(
                  target,
                  group.key,
                  0,
                  scope,
                  transcript.text,
                  buildFillInstructions,
                  group.leafKeys,
                );
          jobs.push({
            group,
            instanceIndex: 0,
            instances: 1,
            messages,
            requestName: group.name,
            context: group.context,
          });
          continue;
        }

        if (!Array.isArray(rosterGroup)) {
          const statedNone = rosterGroup as { stated: "none"; span: string };
          statedEmptyGroups[group.key] = statedNone.span;
          groupResult[group.key] = [];
          continue;
        }

        const current = rosterGroup.filter((c) => c.eligibility === "current");

        if (current.length === 0) {
          groupResult[group.key] = [];
          continue;
        }

        if (current.length > instanceCap) {
          throw new Error(
            `scopedInstanceExtractor: group "${group.key}" has ${current.length} current instances, exceeding the cap of ${instanceCap}`,
          );
        }

        // `??=`, not `=`: a partitioned group visits this loop once per piece,
        // and re-allocating would wipe the slots an earlier piece's jobs fill.
        collectionArrays[group.key] ??= new Array(current.length);

        for (let i = 0; i < current.length; i++) {
          const candidate = current[i]!;
          const scope = buildFillScope(group.key, rosterGroup, candidate, i);
          const messages = buildFillMessages(
            target,
            group.key,
            i,
            scope,
            transcript.text,
            buildFillInstructions,
            group.leafKeys,
          );
          jobs.push({
            group,
            instanceIndex: i,
            instances: current.length,
            messages,
            requestName: `${group.name}-${i}`,
            context: `${group.context} instance ${i}`,
          });
        }
      }

      // The inventory call plus all fill calls must fit in the step timeout. The
      // inventory is not part of the pool, but treating it as one call in the batch
      // calculation is a conservative overestimate and safe.
      const totalCallsEstimate = 1 + jobs.length;
      const batches = Math.ceil(totalCallsEstimate / concurrency);
      const budget = deriveRetryBudget({
        requested: maxRetries,
        batches,
        stepTimeoutMs,
        perCallCeilingMs,
        baseMs: backoffOpts.baseMs ?? DEFAULT_BACKOFF_BASE_MS,
        capMs: backoffOpts.capMs ?? DEFAULT_BACKOFF_CAP_MS,
      });
      const effectiveMaxRetries = budget.derived;

      if (budget.derived < budget.requested) {
        onRetryBudget?.(budget);
      }
      // No retry fixes a configuration error: when the caller required a budget
      // and none fits the step timeout, throw terminal so the queue reaches
      // `dead` rather than burning its attempt budget rediscovering that.
      if (requireRetryBudget && budget.derived === 0 && budget.requested > 0) {
        throw new TerminalQueueError(
          `scopedInstanceExtractor: retry budget derived to zero (requested ${budget.requested}, stepTimeoutMs ${stepTimeoutMs}, perCallCeilingMs ${perCallCeilingMs}, concurrency ${concurrency}) — no retry fits the step timeout`,
        );
      }

      const totals: UsageTotals = {};
      const fillResponses = await mapWithPool(
        jobs,
        concurrency,
        async (job) => {
          const id = nextUnitId();
          const part = (job.group.part ?? 0) + 1;
          const parts = job.group.parts ?? 1;
          let lastError: unknown;
          for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
            if (abort.signal.aborted) {
              throw lastError ?? new Error("scopedInstanceExtractor: aborted by a sibling failure");
            }

            onUnit?.({
              id,
              unit: "instance",
              phase: "start",
              attempt: attempt + 1,
              key: job.group.key,
              instance: job.instanceIndex + 1,
              instances: job.instances,
              part,
              parts,
            });

            totalCalls++;
            const request: ChatRequest = {
              model,
              messages: job.messages,
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: job.requestName,
                  schema: job.group.jsonSchema,
                  strict: true,
                },
              },
              maxTokens,
            };

            try {
              const completion = await completeOrClassify(chat, request, job.context, {
                signal: options?.signal ?? abort.signal,
              });
              // Counted before the gates below, so a truncated response still
              // reports what it cost. NOTE the inventory call's tokens are NOT
              // here: `inventory` is a caller-supplied function returning a
              // Roster, not a completion, so its usage never reaches this
              // extractor. `usage.calls` counts it; the token totals understate
              // by one call until that seam carries usage too.
              addUsage(totals, completion.usage);
              assertStopFinishReason(completion, job.context);
              const raw = parseJsonContent(completion.content, job.context);
              const parsed = parseWithSchema(job.group.schema, raw, job.context);

              onUnit?.({
                id,
                unit: "instance",
                phase: "done",
                attempt: attempt + 1,
                key: job.group.key,
                instance: job.instanceIndex + 1,
                instances: job.instances,
                part,
                parts,
                ...(completion.usage
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
                unit: "instance",
                phase: "error",
                attempt: attempt + 1,
                key: job.group.key,
                instance: job.instanceIndex + 1,
                instances: job.instances,
                part,
                parts,
                error: cause,
              });

              if (cause instanceof TerminalQueueError) throw cause;
              if (abort.signal.aborted) throw cause;
              if (attempt < effectiveMaxRetries) {
                await delay(fullJitterDelay(attempt, backoffOpts));
              }
            }
          }
          throw lastError;
        },
        abort,
      );

      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]!;
        const response = fillResponses[i]!;
        const value = (response as Record<string, unknown>)[job.group.key];
        if (job.group.isCollection) {
          // A slot already holding a value means an earlier piece of the SAME
          // partitioned group already contributed its leaf subset for this
          // instance — recombine via mergeGroupPieces (the per-group extractor's
          // own recombination) rather than letting the last piece overwrite the
          // rest. Jobs for one key are issued in piece order and `mapWithPool`
          // preserves it, so the merge sees the pieces in the order issued.
          const arr = collectionArrays[job.group.key]!;
          const existing = arr[job.instanceIndex];
          arr[job.instanceIndex] =
            existing === undefined ? value : mergeGroupPieces(existing, value);
        } else {
          const key = job.group.key;
          groupResult[key] = key in groupResult ? mergeGroupPieces(groupResult[key], value) : value;
        }
      }
      for (const [key, arr] of Object.entries(collectionArrays)) {
        groupResult[key] = arr;
      }

      const mergeContext = `scopedInstanceExtractor: merged response for "${target.name}"`;
      const parsed = parseWithSchema(target.extractionSchema, groupResult, mergeContext);

      return {
        fields: normalize(parsed),
        raw: groupResult,
        usage: { calls: totalCalls, ...totals },
        ...(Object.keys(statedEmptyGroups).length > 0 ? { statedEmptyGroups } : {}),
      };
    },
  };
}
