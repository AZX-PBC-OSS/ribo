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
 *
 * **The preset.** Since Wave 5 this is a {@link phasedExtractor} preset of two
 * phases — the inventory phase (`inventory-phase.ts`) runs the roster pass once
 * and interprets all of it in its merge (stated-empty spans, empty-collection
 * seeding, the instance cap), and the fill phase (`fill-phase.ts`) derives one
 * job per `(group, piece, instance)` from the settled roster, makes each job's
 * one chat call, and recombines the outcomes with `mergeGroupPieces`. The
 * scheduling, retry, sibling abort, deadline, unit stream, usage accumulation and
 * closing trust-boundary parse are the engine's. What stays here is the group
 * preparation, every message and scope builder, and {@link normalize}'s
 * application — which deliberately wraps the engine rather than being handed to
 * it (see the note on `normalize` below).
 */

import { z } from "zod";

import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  PER_CALL_CEILING_MS,
  phasedExtractor,
} from "@azx/ribo-core";
import type {
  AnnotatedTranscript,
  BackoffOptions,
  ChatClient,
  ChatMessage,
  Enveloped,
  ExtractionObserver,
  Extractor,
  ExtractionResult,
  ExtractionTarget,
  ExtractOptions,
  FillScope,
  NoProvenance,
  PhaseUnit,
  RetryBudgetObserver,
  Roster,
  RosterCandidate,
} from "@azx/ribo-core";

import { assertWireSafeSchemaName, narrowToLeaves } from "@azx/ribo-core";
import { fillPhase } from "./fill-phase.js";
import { inventoryPhase } from "./inventory-phase.js";
import { partitionedLeafKeys } from "../strategies/per-group.js";
import { MAX_NULLABLE_UNIONS_PER_CALL, splitExtractionSchema } from "../schema/split-schema.js";
import type { ExtractionGroup } from "../schema/split-schema.js";

// Re-export the generic inventory/fill vocabulary from core, where both the
// adapter and the extractor strategy can reach it without a package cycle.
export type { FillScope, Roster, RosterCandidate } from "@azx/ribo-core";

/**
 * Options for {@link scopedInstanceExtractor}.
 *
 * The retry budget is derived per phase boundary inside `extract()` — the
 * engine derives each phase's share from the time remaining when that phase's
 * item count is known. This keeps the zero-budget behaviour a real difference
 * from {@link perGroupExtractor}, which derives at construction and throws
 * there: a zero-derived budget with `requireRetryBudget` throws a
 * `TerminalError` from `extract()`, not at construction — no retry
 * fixes a configuration error, and the queue should reach `dead` rather than
 * burn its attempt budget rediscovering that.
 */
export interface ScopedFillOptions<V extends Record<string, unknown>, P = NoProvenance>
  extends BackoffOptions, ExtractionObserver<PhaseUnit>, RetryBudgetObserver {
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
   * before any fill can fan out — the phases run in order.
   */
  readonly concurrency?: number;
  /** Max retries per fill call after a transient failure. Defaults to 2. The
   * inventory phase pins its own zero — the roster pass is one-shot. */
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
  /**
   * Max serialized JSON Schema characters per piece ({@link splitExtractionSchema}'s
   * `maxSerializedCharsPerGroup`). The library carries no provider's number for it
   * (ADR 0015) — the route's ceiling is the caller's to know. Omitted, no byte-cap
   * packing runs and the union cap is the only partition boundary. Same effect as
   * the per-group preset's option; supplied here so callers routing through the
   * scoped-instance preset don't have to compose `prepareGroups`+`fillPhase` by
   * hand to opt in. Partitioning multiplies fill calls per instance, never the
   * instance count.
   */
  readonly maxSerializedCharsPerGroup?: number;
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

/** A prepared group, with its per-instance fill schema and error context. */
export interface PreparedGroup {
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
   * see the fill phase's merge in {@link fillPhase}.
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
    const element: unknown = (groupValue[instanceIndex] ?? groupValue[0]) as unknown;
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
export function buildFillScope(
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
export function singletonFillScope(groupKey: string): FillScope {
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
 * Build the prepared groups the scoped-instance phases consume, from the split's
 * {@link ExtractionGroup} list.
 *
 * This is the ONE construction site for {@link PreparedGroup} — lifted out of
 * `scopedInstanceExtractor` and exported so a host composing its own phase list
 * builds the same groups the preset builds, and the test fixtures build them the
 * same way. The members the split provides (key, schema, part, parts) become the
 * full prepared shape here: the collection array unwrap (a collection
 * group's fill schema is ONE instance, never the array — that is what makes "a
 * fill cannot add an instance" true), the `draft-2020-12` rendering, the
 * wire-safe name, the error context, and `leafKeys` for a partitioned piece.
 *
 * **The wire name is the FILL variant** — `${target.name}-${key}-fill${partSuffix}`,
 * not `perGroupPlan`'s `${target.name}-${key}${partSuffix}`. Same charset rule,
 * same part suffix; the `-fill` infix keeps the scoped fill call for a key from
 * carrying the same `response_format.json_schema.name` as the per-group call for
 * that key, which is the name a log or a route-side error cites — the two
 * strategies name the same group differently so their calls are distinguishable.
 * The name is guarded here: a colon in the target's name or a schema property's
 * key throws at construction naming the character (see
 * `assertWireSafeSchemaName`).
 */
export function prepareGroups<V extends Record<string, unknown>, P = NoProvenance>(
  target: ExtractionTarget<V, P>,
  groups: readonly ExtractionGroup[],
): readonly PreparedGroup[] {
  return groups.map((group) => {
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
    // perGroupPlan uses, and for the same reason. The flat (non-grouped) path
    // appends the same suffix: pieces of a partitioned flat schema share
    // `key === ""`, so dropping the suffix there would name N pieces the same
    // and make a route-side error unrecoverable for want of `part`. No
    // `-${group.key}` infix — flat pieces have no group key to slot in.
    const partSuffix = group.part !== undefined ? `-${group.part}` : "";
    const name = group.key
      ? `${target.name}-${group.key}-fill${partSuffix}`
      : `${target.name}-fill${partSuffix}`;
    assertWireSafeSchemaName(name, "prepareGroups");
    // Error contexts must be distinct for the same reason: a parse failure on
    // piece 2 of a 3-piece flat schema is otherwise indistinguishable from the
    // piece-1 failure that just preceded it, because the message above names
    // the target only.
    const context = group.key
      ? group.part !== undefined
        ? `scopedInstanceExtractor: fill for "${target.name}" group "${group.key}" (part ${group.part + 1}/${group.parts})`
        : `scopedInstanceExtractor: fill for "${target.name}" group "${group.key}"`
      : group.part !== undefined
        ? `scopedInstanceExtractor: fill for "${target.name}" (part ${group.part + 1}/${group.parts})`
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
}

/**
 * Build a scoped per-instance {@link Extractor} for a target.
 *
 * A {@link phasedExtractor} preset of two phases. On each `extract`:
 *   1. **The inventory phase** runs `inventory(transcript)` — one call,
 *      regardless of how any group's leaves are partitioned — and its merge
 *      interprets the whole roster: a `stated: "none"` entry records its span
 *      in `statedEmptyGroups` and seeds the group `[]`; a group missing from
 *      the roster or carrying no `current` candidates is seeded `[]`; a group
 *      exceeding `instanceCap` throws before any fill call is made — the cap
 *      exists to fail loudly rather than silently truncate a collection, and
 *      partitioning changes leaf count per call, never instance count.
 *   2. **The fill phase** derives one job per `(group, piece, instance)`:
 *      for each top-level group from {@link splitExtractionSchema} — called
 *      with the leaf cap, so a group whose per-instance leaf count exceeds it
 *      arrives as one entry per piece, each carrying only its piece's leaves —
 *      collection groups get one fill call per `current` candidate PER PIECE,
 *      singletons (and the `""` fallback) one call per piece. Each job parses
 *      its response against the single-instance wrapper schema for that group
 *      piece.
 *   3. The fill phase's merge recombines the outcomes: pieces sharing one
 *      `(group, instance)` slot with {@link mergeGroupPieces} — the same
 *      recombination the per-group extractor applies at group level — and
 *      collection arrays indexed by the job's instance index, never by arrival
 *      order. It also writes `raw` — the assembled pre-normalize record.
 *   4. The engine runs the second trust-boundary parse against the full
 *      `extractionSchema`; `normalize` then applies to the parsed fields —
 *      AFTER the parse, exactly as today (see below).
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
    maxSerializedCharsPerGroup,
    onUnit,
    onRetryBudget,
    requireRetryBudget,
  } = options;

  // The union cap defaults to the same ceiling the per-group extractor applies,
  // for the same reason: an over-cap per-instance schema is rejected
  // provider-side, and tier 1 was the one strategy still sending every group
  // whole. The byte cap is a separate opt-in: when the route's structured-
  // output ceiling is character-counted, the union check passes through and
  // the request is rejected at the provider with a 400 indistinguishable from
  // every other schema rejection. PerGroupOptions exposes the same pair for the
  // per-group extractor; this option keeps the two presets symmetric so a
  // caller moving between them doesn't have to learn a second knob shape.
  const splitOptions: { maxNullableUnionsPerGroup: number; maxSerializedCharsPerGroup?: number } = {
    maxNullableUnionsPerGroup: maxNullableUnionsPerGroup ?? MAX_NULLABLE_UNIONS_PER_CALL,
  };
  if (maxSerializedCharsPerGroup !== undefined) {
    splitOptions.maxSerializedCharsPerGroup = maxSerializedCharsPerGroup;
  }
  const groups = splitExtractionSchema(target.extractionSchema, splitOptions);
  const prepared = prepareGroups(target, groups);

  const engine = phasedExtractor<V, P>({
    target,
    phases: [
      inventoryPhase<V, P>({ inventory, prepared, instanceCap }),
      fillPhase<V, P>({ target, chat, model, maxTokens, prepared, buildFillInstructions }),
    ],
    concurrency,
    maxRetries,
    stepTimeoutMs,
    perCallCeilingMs,
    delay,
    // BackoffOptions members pass straight through: the signature is unchanged,
    // so TypeScript would not catch dropping them, and no test supplies them —
    // a silent loss of injectable jitter, which is what makes retry tests
    // deterministic. The defaults match the engine's own.
    baseMs: baseMs ?? DEFAULT_BACKOFF_BASE_MS,
    capMs: capMs ?? DEFAULT_BACKOFF_CAP_MS,
    random,
    requireRetryBudget,
    onRetryBudget,
    onUnit,
  });

  return {
    async extract(
      transcript: AnnotatedTranscript,
      extractOptions?: ExtractOptions,
    ): Promise<ExtractionResult<Enveloped<V, P>>> {
      const result = await engine.extract(transcript, extractOptions);
      // `normalize` wraps the engine rather than being handed to it, and both
      // halves of that matter. Today it runs AFTER the closing parse and takes
      // a full `Enveloped<V, P>`; the engine's run-level option runs BEFORE the
      // parse and takes the draft's deep partial. Handing it over would change
      // two things at once: a normalize whose output does not satisfy the
      // schema would newly throw, and the preset would need a cast to bridge
      // the types. Awaiting the engine and applying it to `result.fields`
      // preserves today's order exactly — and needs no cast, because the
      // parsed fields are already `Enveloped<V, P>`.
      return { ...result, fields: normalize(result.fields) };
    },
  };
}
