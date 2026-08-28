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
  fullJitterDelay,
  TerminalQueueError,
} from "@azx/ribo-core";
import type {
  BackoffOptions,
  Enveloped,
  Extractor,
  ExtractionResult,
  ExtractionTarget,
} from "@azx/ribo-core";

import type { ChatClient, ChatMessage, ChatRequest } from "./chat-client.js";
import {
  assertStopFinishReason,
  buildMessages,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
} from "./extraction-common.js";
import { splitExtractionSchema } from "./split-schema.js";

/** One candidate returned by the inventory pass. */
export interface RosterCandidate {
  readonly mentionSpan: string;
  readonly discriminator: string;
  readonly distinguishedBy: string | null;
  readonly eligibility: string;
  readonly eligibilitySpan: string | null;
}

/** The house-wide inventory roster: one ordered list per collection group. */
export interface Roster {
  readonly [groupKey: string]: readonly RosterCandidate[];
}

/** The scope block passed to `buildFillInstructions` for each per-instance fill. */
export interface FillScope {
  /** The group being filled, e.g. `"hvac"`. */
  readonly groupKey: string;
  /** The candidate this fill call is for. */
  readonly positive: RosterCandidate;
  /** The position of {@link positive} within the roster's current candidates. */
  readonly positiveIndex: number;
  /** The other `current` candidates in the same group, declared out of scope. */
  readonly siblings: readonly RosterCandidate[];
  /** Candidates in the same group whose eligibility is not `current`, to be recorded nowhere. */
  readonly excluded: readonly RosterCandidate[];
}

/** Options for {@link scopedInstanceExtractor}. */
export interface ScopedFillOptions<V extends Record<string, unknown>> extends BackoffOptions {
  /** The field knowledge: name, extraction schema, instructions, and examples. */
  readonly target: ExtractionTarget<V>;
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
  readonly normalize?: (fields: Enveloped<V>) => Enveloped<V>;
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
}

/**
 * Default conservative upper bound on one chat call's wall-clock duration. Used to
 * derive the retry budget from the step-timeout relationship.
 */
const PER_CALL_CEILING_MS = 120_000;

/**
 * Default hard ceiling on current instances per group. The cap exists to fail loudly
 * rather than silently truncate a collection.
 */
const DEFAULT_INSTANCE_CAP = 10;

/**
 * Worst-case accumulated backoff for one call exhausting `retries` retries — the
 * sum of {@link fullJitterDelay} results when `random()` returns 1 every time. Same
 * formula as {@link perGroupExtractor}.
 */
function maxAccumulatedBackoff(retries: number, baseMs: number, capMs: number): number {
  let total = 0;
  for (let i = 0; i < retries; i++) {
    total += Math.min(capMs, baseMs * 2 ** Math.min(i, 32));
  }
  return total;
}

/**
 * Derive the effective max retries so the worst-case total time fits inside
 * `stepTimeoutMs`. The total calls and concurrency are known at extraction time,
 * once the roster has been received, so this is evaluated per `extract()` rather
 * than at construction.
 */
function deriveMaxRetries(
  requested: number,
  batches: number,
  stepTimeoutMs: number,
  perCallCeilingMs: number,
  baseMs: number,
  capMs: number,
): number {
  for (let r = Math.max(0, requested); r >= 0; r--) {
    const perCall = (r + 1) * perCallCeilingMs + maxAccumulatedBackoff(r, baseMs, capMs);
    if (batches * perCall <= stepTimeoutMs) return r;
  }
  return 0;
}

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
  /** The schema the fill response is parsed against — one object with one top-level key. */
  readonly schema: z.ZodType;
  /** The JSON Schema sent to the model in `response_format`. */
  readonly jsonSchema: Record<string, unknown>;
  /** The base for `response_format.json_schema.name`. */
  readonly name: string;
  /** The descriptive prefix for error messages from this group's calls. */
  readonly context: string;
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
 */
export function projectFillExample<F extends Record<string, unknown>>(
  example: { readonly transcript: string; readonly fields: F },
  groupKey: string,
  instanceIndex: number,
): { readonly transcript: string; readonly fields: Record<string, unknown> } | null {
  const fields = example.fields as Record<string, unknown>;
  if (!(groupKey in fields)) return null;
  const groupValue = fields[groupKey];
  if (Array.isArray(groupValue)) {
    const element = groupValue[instanceIndex] ?? groupValue[0];
    if (element === undefined) return null;
    return { transcript: example.transcript, fields: { [groupKey]: element } };
  }
  return { transcript: example.transcript, fields: { [groupKey]: groupValue } };
}

/**
 * Assemble the chat messages for a scoped per-instance fill call.
 *
 * The system message is the scoped per-group instructions from
 * `buildFillInstructions`. Each few-shot example is projected to a single-instance
 * assistant turn so the model does not imitate the array shape of a multi-instance
 * example. The transcript is the final user message — the injection boundary is
 * preserved.
 */
export function buildFillMessages<V extends Record<string, unknown>>(
  target: ExtractionTarget<V>,
  groupKey: string,
  instanceIndex: number,
  scope: FillScope,
  transcript: string,
  buildFillInstructions: (groupKey: string, scope: FillScope) => string,
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: buildFillInstructions(groupKey, scope) },
  ];
  for (const example of target.examples ?? []) {
    const projected = projectFillExample(example, groupKey, instanceIndex);
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
 *   2. For each top-level group from {@link splitExtractionSchema}:
 *      - Collection groups (`z.array(...)`): one fill call per `current` candidate.
 *        A group with no `current` candidates yields an empty array and makes no
 *        calls. The instance cap is enforced before any call is made.
 *      - Singleton groups: one fill call, unchanged.
 *   3. Run fill calls concurrently with a bounded pool. For each response:
 *      - Pre-parse `finishReason` check.
 *      - Parse against the single-instance wrapper schema for that group.
 *   4. Merge per-instance responses into their group's array in roster order.
 *   5. Second trust-boundary parse against the full `extractionSchema`, then normalize.
 */
export function scopedInstanceExtractor<V extends Record<string, unknown>>(
  options: ScopedFillOptions<V>,
): Extractor<Enveloped<V>> {
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
  } = options;

  const backoffOpts: BackoffOptions = {
    baseMs: baseMs ?? DEFAULT_BACKOFF_BASE_MS,
    capMs: capMs ?? DEFAULT_BACKOFF_CAP_MS,
    random,
  };

  const groups = splitExtractionSchema(target.extractionSchema);
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
    const name = group.key ? `${target.name}-${group.key}-fill` : `${target.name}-fill`;
    const context = group.key
      ? `scopedInstanceExtractor: fill for "${target.name}" group "${group.key}"`
      : `scopedInstanceExtractor: fill for "${target.name}"`;
    return { key: group.key, isCollection, schema, jsonSchema, name, context };
  });

  return {
    async extract(transcript: string): Promise<ExtractionResult<Enveloped<V>>> {
      const roster = await inventory(transcript);
      let totalCalls = 1; // the inventory call

      const abort = new AbortController();
      const jobs: FillJob[] = [];
      const collectionArrays: Record<string, unknown[]> = {};
      const groupResult: Record<string, unknown> = {};

      for (const group of prepared) {
        const rosterGroup = roster[group.key] ?? [];

        if (!group.isCollection || group.key === "") {
          // Singleton or non-grouped fallback: one fill call, no scope semantics.
          const scope = singletonFillScope(group.key || "fields");
          const messages =
            group.key === ""
              ? buildMessages(target, transcript)
              : buildFillMessages(target, group.key, 0, scope, transcript, buildFillInstructions);
          jobs.push({
            group,
            instanceIndex: 0,
            messages,
            requestName: group.name,
            context: group.context,
          });
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

        collectionArrays[group.key] = new Array(current.length);

        for (let i = 0; i < current.length; i++) {
          const candidate = current[i]!;
          const scope = buildFillScope(group.key, rosterGroup, candidate, i);
          const messages = buildFillMessages(
            target,
            group.key,
            i,
            scope,
            transcript,
            buildFillInstructions,
          );
          jobs.push({
            group,
            instanceIndex: i,
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
      const effectiveMaxRetries = deriveMaxRetries(
        maxRetries,
        batches,
        stepTimeoutMs,
        perCallCeilingMs,
        backoffOpts.baseMs ?? DEFAULT_BACKOFF_BASE_MS,
        backoffOpts.capMs ?? DEFAULT_BACKOFF_CAP_MS,
      );

      const fillResponses = await mapWithPool(
        jobs,
        concurrency,
        async (job) => {
          let lastError: unknown;
          for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
            if (abort.signal.aborted) {
              throw lastError ?? new Error("scopedInstanceExtractor: aborted by a sibling failure");
            }

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
                signal: abort.signal,
              });
              assertStopFinishReason(completion, job.context);
              const raw = parseJsonContent(completion.content, job.context);
              return parseWithSchema(job.group.schema, raw, job.context);
            } catch (cause) {
              lastError = cause;
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
          collectionArrays[job.group.key]![job.instanceIndex] = value;
        } else {
          groupResult[job.group.key] = value;
        }
      }
      for (const [key, arr] of Object.entries(collectionArrays)) {
        groupResult[key] = arr;
      }

      const mergeContext = `scopedInstanceExtractor: merged response for "${target.name}"`;
      const parsed = parseWithSchema(target.extractionSchema, groupResult, mergeContext);

      return { fields: normalize(parsed), raw: groupResult, usage: { calls: totalCalls } };
    },
  };
}
