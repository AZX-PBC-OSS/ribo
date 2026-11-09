/**
 * @file `perGroupExtractor` — the per-group preset over core's
 * {@link groupedExtractor} (composition plan Task 12,
 * `per-group-composition-design.md` §4.3).
 *
 * The scheduling half of the old implementation — the bounded pool, the derived
 * retry budget, the retry loop, the sibling abort, the merge by key, the second
 * trust-boundary parse, the single `normalize`, the usage sum — moved to
 * {@link groupedExtractor} (Task 11). What stays here is the DERIVED PLAN:
 * which pieces the schema splits into ({@link splitExtractionSchema}) and the
 * default {@link singleShotExtractor} built for each piece over a projected
 * target ({@link projectTarget}) — plus {@link overrideGroups}, the ergonomic
 * layer that lets a host replace or wrap ONE group's default entries without
 * rebuilding the other nineteen by hand.
 *
 * **The intermediate step is exported, not hidden.** If the preset built its map
 * internally, the common case — the defaults everywhere except one group — would
 * mean reconstructing twenty entries by hand, and nobody would; hosts would keep
 * calling the preset and the per-group capability would go unused. So the preset
 * is two steps, and the first is public: {@link perGroupPlan} returns the
 * per-key map of default entries (plus the unwrapped portion's, when the schema
 * has one) and the projected targets they were built from, as plain values a
 * host can read, log, assert on and spread, and {@link perGroupExtractor} is
 * `groupedExtractor({ target, ...planEntries, …timing })` over
 * `perGroupPlan(options)` and nothing more.
 *
 * **Requests are byte-identical to the pre-combinator implementation** —
 * `response_format.json_schema.name`, the schema, the message list, the order —
 * which is the regression gate: this package's `per-group.test.ts` suite
 * (including partitioning and progress units), the adapter's
 * `per-group-cap.test.ts`, and the adapter's frozen JSON Schema fixture. Three
 * details carry that identity:
 *
 *   - **The structured-output name** is today's construction:
 *     `${target.name}-${key}` with a 0-based `-<part>` suffix on a partitioned
 *     piece, set on the projected target (`projectTarget` keeps the target's
 *     own name; the plan overrides it, because the name IS the request's
 *     `json_schema.name`).
 *   - **The schema each call is pinned to** is the projected one-key strict
 *     object `projectTarget` builds — the same shape, built from the same leaf
 *     schemas, that the old code took from the split's piece.
 *   - **The messages** are the projected target's — its instructions and
 *     examples. When `groupInstructions` is provided, `projectTarget` supplies
 *     the group's instructions and the examples projected to the group (and
 *     narrowed to a partitioned piece's leaves); when it is not, the plan
 *     restores the target's full unprojected examples, which is what the old
 *     `buildGroupMessages` did for every call in that mode.
 *
 * **Two semantics moved with the retry unit, both documented in design §7.**
 * The unit of retry is now the group entry's `extract()` rather than the chat
 * call alone — a wrapper inside a retried group is retried with it. And
 * `usage.calls` sums what the entries report, so each default entry counts the
 * chat calls it made for the current run — failed attempts included, the way
 * the old loop counted them — and reports the count on its successful result.
 *
 * **Everything here speaks `Enveloped<V, P>`, not `V`** — the four things the
 * plan does with fields (constrain the model, parse each response, imitate the
 * example assistant turns, normalize) are all the provenance-enveloped shape
 * the model emits. See `single-shot.ts`'s header in `@azx/ribo-core` for the
 * full rationale.
 *
 * **The trust boundary still runs twice.** Each entry parses its response
 * against its own piece schema at the point of receipt; the combinator then
 * parses the merged whole against the full `extractionSchema` before
 * returning. The second parse catches a merge that produced a shape no single
 * call would have — it is not redundant.
 *
 * **Singleton mode.** `perGroupSingletonExtractor` (Tier 3) narrows each
 * collection group to a single element per call: the projected target carries
 * the singleton schema, so the model emits one object and cannot represent a
 * second instance. The entry then wraps the parsed singleton back into a
 * one-element array before the combinator's merge and full-schema parse, so
 * the final result still matches the original extraction schema.
 *
 * **The non-grouped fallback.** A target whose schema is not an object of
 * groups yields one entry covering the whole schema ({@link splitExtractionSchema}'s
 * fallback, keyed `""` internally), so this extractor makes one call — exactly
 * as today. The second trust-boundary parse is a no-op in that case (the piece
 * schema IS the full schema), but harmless. A MIXED schema — groups beside
 * loose top-level leaves — yields one entry per group plus the loose leaves as
 * the unwrapped portion: the plan carries it in its `unwrapped` slot and the
 * combinator folds it back onto the internal `""` key, so no plan code
 * distinguishes the loose pieces from the flat fallback's (mixed-schema-split
 * design §3, rows 8–9; ADR 0023).
 */

import { z } from "zod";

import { groupedExtractor } from "../grouped-extractor.js";
import type { BackoffOptions } from "../../storage/backoff.js";
import type { ChatClient } from "../../phases/chat-client.js";
import type { Enveloped, NoProvenance } from "../../provenance/enveloped.js";
import type { ExtractionObserver, GroupUnit } from "../extraction-observer.js";
import type { ExtractionTarget, Extractor } from "../extractor.js";
import type { GroupedEntries, GroupMap, UnwrappedEntry } from "../grouped-extractor.js";
import type { RetryBudgetObserver } from "../../async/retry-budget.js";

import {
  MAX_NULLABLE_UNIONS_PER_CALL,
  partitionLabelLine,
  splitExtractionSchema,
} from "../schema/split-schema.js";
import type { ExtractionGroup } from "../schema/split-schema.js";
import type { ShapePartitions } from "../shape/derived-shape.js";
import { assertWireSafeSchemaName, narrowToLeaves } from "../extraction-common.js";
import type { FieldGuidanceOptions } from "../field-guidance.js";
import { projectTarget } from "../project-target.js";
import { singleShotExtractor } from "../single-shot.js";
import type { ToolAdapterExample } from "../../write/adapter.js";

/**
 * Options for {@link perGroupExtractor} and {@link perGroupPlan}.
 *
 * @category Extraction
 */
export interface PerGroupOptions<V extends Record<string, unknown>, P = NoProvenance>
  extends BackoffOptions, ExtractionObserver<GroupUnit>, RetryBudgetObserver {
  /** The field knowledge: `name`, `extractionSchema`, `instructions`, and few-shot `examples`. */
  readonly target: ExtractionTarget<V, P>;
  /** The injected chat transport. A fake in tests; `openAiChat` in production. */
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
   * — on the MERGED result, not per group, by the combinator. See
   * {@link SingleShotOptions.normalize} for the full rationale; the difference
   * here is that it runs once across the whole enveloped shape rather than once
   * per partial shape.
   */
  readonly normalize?: (fields: Enveloped<V, P>) => Enveloped<V, P>;
  /**
   * Max concurrent group calls, applied by the combinator's pool. Defaults to 4.
   */
  readonly concurrency?: number;
  /**
   * Max retries per group after a transient failure (so the total attempts per
   * group is `maxRetries + 1`). Terminal failures (`TerminalError` —
   * truncation, content filtering, refusal, unsupported) are never retried and
   * never delay. Defaults to 2, capped by the derived budget — see
   * `deriveRetryBudget`.
   */
  readonly maxRetries?: number;
  /**
   * The relay's step timeout — the wall-clock ceiling inside which all group
   * calls plus their retries plus their backoff delays must complete. Defaults
   * to `900_000` (15 minutes), matching the relay's `DEFAULT_STEP_TIMEOUT_MS`.
   * The retry budget is capped so the worst case fits inside this.
   */
  readonly stepTimeoutMs?: number;
  /**
   * Conservative upper bound on one chat call's wall-clock duration, used to
   * derive the retry budget from the step-timeout relationship. Defaults to
   * `PER_CALL_CEILING_MS` (120,000 ms), the measured ceiling for the
   * managed transport. A faster transport (e.g., on-device) should lower this so
   * the retry budget is sized honestly.
   */
  readonly perCallCeilingMs?: number;
  /**
   * Injectable sleep used between retry attempts, so tests do not wait real
   * seconds. Defaults to `setTimeout`. The value passed is the
   * `fullJitterDelay` result in milliseconds.
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
   * costs one. A leaf count would split a 15-leaf row group for no gain. For a
   * MIXED schema the loose portion (the `""` pieces) packs against this cap
   * too — no emitted piece exceeds a cap the caller supplied.
   */
  readonly maxNullableUnionsPerGroup?: number;
  /**
   * Max serialized JSON Schema characters per piece, passed through to
   * {@link splitExtractionSchema}'s byte cap — see `SplitOptions` for why the
   * caller, not the library, supplies the number. Omitted, the split packs
   * against the union cap alone and requests are byte-identical to what they
   * have always been.
   */
  readonly maxSerializedCharsPerGroup?: number;
  /**
   * The derived shape's partitions record (`DerivedExtractionShape.partitions`),
   * forwarded to {@link splitExtractionSchema}: a group with an entry is cut
   * along its parts, and each piece's request appends
   * `partitionLabelLine` to its base instructions — the target's or
   * `groupInstructions`' text. Absent or empty, requests are byte-identical to
   * what they have always been.
   */
  readonly partitions?: ShapePartitions;
  /**
   * Where the schema's field descriptions travel, as in
   * {@link SingleShotOptions.fieldDescriptions}. Forwarded to every default
   * piece entry (each a {@link singleShotExtractor} over its projected target),
   * so a per-group call carries only its own group's guidance and a partitioned
   * piece only its piece's — the projected schema the entry walks IS the piece's.
   * A host replacing a group via {@link overrideGroups} builds its replacement's
   * prompt itself and decides there.
   */
  readonly fieldDescriptions?: FieldGuidanceOptions["fieldDescriptions"];
}

/**
 * The leaf keys one partitioned piece of a group asks the model for — read back
 * out of `group.schema` rather than threaded through as separate state, so this
 * can never drift from the schema the call is actually pinned to.
 *
 * A grouped piece's schema is `z.strictObject({ [group.key]: value })`, where
 * `value` is either the piece's narrowed group object (a singleton group, e.g.
 * `health`) or a `ZodArray` of it (a collection group, e.g. `hvac`). A FLAT
 * piece's schema (the byte-cap-flat path: `key === ""`) is the schema's own
 * top-level strict object with its leaves narrowed to the piece's subset —
 * there is no wrapping, so the leaves ARE the schema's keys directly.
 * @category Extraction
 */
export function partitionedLeafKeys(group: ExtractionGroup): readonly string[] {
  if (group.key === "") {
    return Object.keys((group.schema as z.ZodObject).shape);
  }
  const shape = (group.schema as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodType>;
  const value = shape[group.key]!;
  const candidate = value instanceof z.ZodArray ? (value.element as z.ZodType) : value;
  return Object.keys((candidate as z.ZodObject<z.ZodRawShape>).shape);
}

/**
 * The projected {@link ExtractionTarget}s behind a {@link PerGroupPlan}'s groups:
 * {@link GroupMap} key for key and index for index. Each is the target the
 * corresponding default entry was built from — the schema is always the piece's
 * one-key strict object, the name is the request's `json_schema.name`, and the
 * instructions/examples are the group's own when the plan carries
 * `groupInstructions` (the target's full unprojected ones when it does not,
 * which is what the requests have always carried in that mode). A host overriding
 * a group builds its replacement from `plan.targets[key]` and never touches
 * {@link projectTarget} for the group it is replacing, let alone the nineteen it
 * is not.
 */
/** The named-key arm's target map: one target (or ordered piece list) per top-level key. */
type NamedGroupTargets<V extends Record<string, unknown>, P> = {
  readonly [K in keyof V & string]:
    ExtractionTarget<Pick<V, K>, P> | readonly ExtractionTarget<Pick<V, K>, P>[];
};

/**
 * The unwrapped portion's target (or ordered piece list) — the target half of
 * core's {@link UnwrappedEntry}. A flat schema whose top-level properties are
 * leaf envelopes yields one target (the whole target), or — when a byte cap
 * partitions it — an ordered list, index-aligned with `parts`. The singular
 * option is the historical non-grouped fallback; the array form is what
 * `splitExtractionSchema` emits under a byte cap. Beside named keys — the
 * mixed shape — the slot carries the loose portion's piece target(s): the
 * piece's own strict-object schema, the target's name and instructions, and
 * the full (or, when partitioned, leaf-narrowed) examples.
 */
type UnwrappedTarget<V extends Record<string, unknown>, P> =
  ExtractionTarget<V, P> | readonly ExtractionTarget<V, P>[];

/**
 * The projected targets behind a {@link PerGroupPlan}'s NAMED groups —
 * {@link GroupMap} key for key and index for index. The unwrapped portion's
 * target is not a key here; it rides the plan's `unwrappedTarget` slot.
 * @category Extraction
 */
export type GroupTargets<V extends Record<string, unknown>, P = NoProvenance> = NamedGroupTargets<
  V,
  P
>;

/**
 * What {@link perGroupPlan} returns. Two shapes, mirroring
 * {@link GroupedEntries}' arms: an all-grouped plan carries the exhaustive
 * named maps and no unwrapped portion; a mixed or flat plan carries the named
 * maps (partial — the unwrapped portion owns the rest, or the whole schema)
 * beside the `unwrapped` entry and its `unwrappedTarget`. Hand both halves of
 * either shape straight to `groupedExtractor`: `groupedExtractor({ target,
 * groups: plan.groups, unwrapped: plan.unwrapped })` — narrowing on
 * `plan.unwrapped === undefined` first picks the arm.
 * @category Extraction
 */
export type PerGroupPlan<V extends Record<string, unknown>, P = NoProvenance> =
  | {
      /** Every top-level key is a group: the exhaustive per-key map of default entries. */
      readonly groups: GroupMap<V, P>;
      /** The projected targets those entries were built from, index-aligned with `groups`. */
      readonly targets: GroupTargets<V, P>;
      readonly unwrapped?: undefined;
      readonly unwrappedTarget?: undefined;
    }
  | {
      /** A mixed or flat plan: the named groups beside an unwrapped portion. */
      readonly groups: Partial<GroupMap<V, P>>;
      readonly targets: Partial<GroupTargets<V, P>>;
      /** The unwrapped portion's default entry (or ordered piece list). */
      readonly unwrapped: UnwrappedEntry<V, P>;
      /** The projected target(s) the unwrapped entry was built from, index-aligned. */
      readonly unwrappedTarget: UnwrappedTarget<V, P>;
    };

/**
 * The plan's default entry for one piece: a {@link singleShotExtractor} over the
 * piece's projected target, wrapped so that
 *
 *   - under singleton mode, its parsed one-element response is wrapped back
 *     into the array the full schema expects (the wrap the old merge applied),
 *     and
 *   - its reported `usage.calls` counts every chat call the piece made for the
 *     CURRENT run — failed attempts included, the way the pre-combinator loop
 *     counted them. The combinator sums what entries report and an entry that
 *     throws on attempt 1 never reports a result, so the entry counts its own
 *     calls: keyed by the run's signal, which the combinator hands it fresh per
 *     run and identical across a run's retry attempts.
 */
function defaultPieceEntry<W extends Record<string, unknown>, P = NoProvenance>({
  pieceTarget,
  chat,
  model,
  maxTokens,
  fieldDescriptions,
  wrapKey,
}: {
  readonly pieceTarget: ExtractionTarget<W, P>;
  readonly chat: ChatClient;
  readonly model: string;
  readonly maxTokens?: number;
  readonly fieldDescriptions?: FieldGuidanceOptions["fieldDescriptions"];
  /** The group key whose parsed singleton value is wrapped back into an array. */
  readonly wrapKey?: string;
}): Extractor<Enveloped<W, P>> {
  const entry = singleShotExtractor({
    target: pieceTarget,
    chat,
    model,
    maxTokens,
    fieldDescriptions,
  });
  const callsByRun = new WeakMap<AbortSignal, number>();
  return {
    extract: async (transcript, options) => {
      // A single-shot entry makes exactly one chat call per attempt of its
      // extract() — including an attempt that fails at the transport, the
      // finish-reason gate or the schema parse. The count survives the failed
      // attempt and rides the next successful result out.
      const signal = options?.signal;
      const calls = signal === undefined ? 1 : (callsByRun.get(signal) ?? 0) + 1;
      if (signal !== undefined) callsByRun.set(signal, calls);

      const result = await entry.extract(transcript, options);
      const fields =
        wrapKey === undefined
          ? result.fields
          : // The entry parsed the singleton schema `{ [key]: element }`; the
            // full schema expects `{ [key]: [element] }`. The cast names the
            // wrap the old merge applied — same construction, one level down.
            ({ [wrapKey]: [(result.fields as Record<string, unknown>)[wrapKey]] } as Enveloped<
              W,
              P
            >);
      return { ...result, fields, usage: { ...result.usage, calls } };
    },
  };
}

/**
 * Build the plan behind {@link perGroupExtractor}: the exhaustive per-key map of
 * default entries (a {@link singleShotExtractor} per piece, over a
 * {@link projectTarget}-projected target) and the projected targets those
 * entries were built from. Both are plain values a host can read, log, assert
 * on and spread — and the input to {@link overrideGroups}.
 *
 * The timing knobs the options carry (`concurrency`, `maxRetries`, backoff,
 * `onUnit`, …) are the combinator's business and are ignored here; only the
 * per-piece construction inputs are read.
 * @category Extraction
 */
export function perGroupPlan<V extends Record<string, unknown>, P = NoProvenance>(
  options: PerGroupOptions<V, P>,
): PerGroupPlan<V, P> {
  const {
    target,
    chat,
    model,
    maxTokens,
    groupInstructions,
    singleton = false,
    maxNullableUnionsPerGroup,
    maxSerializedCharsPerGroup,
    partitions,
    fieldDescriptions,
  } = options;

  // Split at plan time — the group list is a pure function of the schema and
  // does not depend on the transcript. The cap is always supplied (defaulting
  // to MAX_NULLABLE_UNIONS_PER_CALL) so a group that would overflow one call's
  // response schema is partitioned rather than rejected provider-side. A
  // non-grouped schema yields one fallback entry with key "".
  const pieces = splitExtractionSchema(target.extractionSchema, {
    maxNullableUnionsPerGroup: maxNullableUnionsPerGroup ?? MAX_NULLABLE_UNIONS_PER_CALL,
    ...(maxSerializedCharsPerGroup === undefined ? {} : { maxSerializedCharsPerGroup }),
    ...(partitions === undefined ? {} : { partitions }),
  });

  // The non-grouped fallback: the schema is not an object of groups, so there
  // are no pieces to compose — one entry covering the whole schema, built over
  // the target itself (its own name, instructions and unprojected examples),
  // carried in the plan's `unwrapped` slot. The combinator merges such an
  // entry by assigning its fields flat, exactly as the old merge did.
  const first = pieces[0];
  if (pieces.length === 1 && first !== undefined && first.key === "") {
    return {
      groups: {},
      targets: {},
      unwrapped: defaultPieceEntry({
        pieceTarget: target,
        chat,
        model,
        maxTokens,
        fieldDescriptions,
      }),
      unwrappedTarget: target,
    };
  }

  // Group the pieces by key, preserving the split's order: a partitioned
  // group's pieces are contiguous, so each key's list is index-aligned with its
  // `part` numbers.
  const byKey = new Map<string, ExtractionGroup[]>();
  for (const group of pieces) {
    const existing = byKey.get(group.key);
    byKey.set(group.key, existing ? [...existing, group] : [group]);
  }

  // The maps are built as plain records because the loop's key arrives as a
  // runtime string; the cast at the return names the invariant that makes it
  // sound — these keys ARE the schema shape's keys, and the schema is
  // `Enveloped<V, P>`, so they are exactly `keyof V & string`. The split's
  // loose pieces share `key === ""`: they are the unwrapped portion, assembled
  // into the plan's `unwrapped`/`unwrappedTarget` slots rather than a map key
  // — the "" marker they carry into the combinator is internal (ADR 0023).
  const groups: Record<string, unknown> = {};
  const targets: Record<string, unknown> = {};
  let unwrapped: unknown;
  let unwrappedTarget: unknown;

  for (const [groupKey, keyPieces] of byKey) {
    const key = groupKey as keyof V & string;
    const pieceEntries: unknown[] = [];
    const pieceTargets: unknown[] = [];

    for (const group of keyPieces) {
      // The leaf keys one partitioned piece asks the model for, so its few-shot
      // example narrows to the same subset the response_format constrains this
      // call to. Read from the piece's own schema — it cannot drift from it.
      const leafKeys = group.part !== undefined ? partitionedLeafKeys(group) : undefined;

      // Whether the piece's parsed response must be wrapped back into a
      // one-element array before the full schema sees it — singleton mode on a
      // collection group, detected on the piece's own schema exactly as the
      // pre-combinator implementation detected it. The flat path never collects
      // — pieces are top-level leaves, no array wrapping — so `wrapToArray`
      // stays false for `key === ""`.
      let wrapToArray = false;
      if (singleton && group.key !== "" && group.schema instanceof z.ZodObject) {
        const shape = (group.schema as z.ZodObject<z.ZodRawShape>).shape as Record<
          string,
          z.ZodType
        >;
        if (shape[group.key] instanceof z.ZodArray) wrapToArray = true;
      }

      // The structured-output name — identifies the piece in the request.
      // `-`, not `:` — a structured-output schema name is constrained to
      // [A-Za-z0-9_-] by at least one platform route (Helix rejects a colon
      // with a generic `400 validation_failed`, which reads identically to an
      // over-cap schema and costs an afternoon to tell apart). A partitioned
      // piece appends `-<part>` (0-based) so two calls sharing a (group) key
      // still get distinct names. FLAT pieces have no wrapping group key, so
      // the name omits the `-${key}` infix: `${target.name}` for a non-
      // partitioned flat piece, `${target.name}-<part>` for a partitioned one.
      // Guarded at construction — a colon in the target's name OR a schema
      // property's key lands here and must fail where the schema author is
      // present, not at the route.
      const partSuffix = group.part !== undefined ? `-${group.part}` : "";
      const name =
        group.key === ""
          ? `${target.name}${partSuffix}`
          : `${target.name}-${group.key}${partSuffix}`;
      assertWireSafeSchemaName(name, "perGroupPlan");

      // Build the piece target. Two shapes: a grouped piece goes through
      // {@link projectTarget} (the schema is wrapped in `{ [key]: … }` and
      // examples are projected to that key); a FLAT piece (the byte-cap-flat
      // path, `key === ""`) cannot — there is no wrapping key to project
      // through and no top-level key to read back from — so its target is
      // built directly: the piece's own schema, the target's instructions,
      // and (for a PARTITIONED flat piece) the few-shot examples narrowed to
      // this piece's leaf subset. An unpartitioned flat piece keeps the
      // target's full examples unchanged — there is only one piece, the
      // schema is unchanged, and the narrowing would be a no-op. `Pick<V,
      // typeof key>` collapses to `{}` for `key === ""`; the cast names what
      // the runtime shape is (a narrowed flat subset of V's keys) — the
      // second trust-boundary parse validates the merge against the full
      // schema, so a wrong shape surfaces as a `SchemaParseError` rather than
      // a silent partial merge.
      let pieceTarget: ExtractionTarget<Pick<V, typeof key>, P>;
      if (group.key === "") {
        const examples =
          leafKeys === undefined
            ? (target.examples ?? [])
            : (target.examples ?? []).map(
                (ex): ToolAdapterExample<Enveloped<Pick<V, typeof key>, P>> => ({
                  transcript: ex.transcript,
                  fields: narrowToLeaves(ex.fields, leafKeys) as Enveloped<Pick<V, typeof key>, P>,
                }),
              );
        pieceTarget = {
          name,
          extractionSchema: group.schema,
          instructions: target.instructions,
          examples,
        } as ExtractionTarget<Pick<V, typeof key>, P>;
      } else {
        // When `groupInstructions` is provided the call gets its own
        // instructions and a projected example (narrowed to this piece's
        // leaves under partitioning, first element under singleton); otherwise
        // it gets the target's full instructions and UNPROJECTED examples —
        // today's behaviour, so the requests stay byte-identical. A labelled
        // piece (a `partitions` entry) appends the partition label line to
        // whichever base this call uses — the label is the prompt's only
        // trace of the part boundary.
        const withGroupPrompt = groupInstructions !== undefined;
        const baseInstructions = withGroupPrompt
          ? groupInstructions(group.key)
          : target.instructions;
        const instructions =
          group.label === undefined
            ? baseInstructions
            : `${baseInstructions}\n\n${partitionLabelLine(group.key, group.label, group.elsewhere)}`;
        const projected = projectTarget<V, P, typeof key>(target, key, {
          instructions,
          leafKeys,
          singleton,
        });
        pieceTarget = withGroupPrompt
          ? { ...projected, name }
          : { ...projected, name, examples: target.examples };
      }

      pieceEntries.push(
        defaultPieceEntry<Pick<V, typeof key>, P>({
          pieceTarget,
          chat,
          model,
          maxTokens,
          fieldDescriptions,
          wrapKey: wrapToArray ? group.key : undefined,
        }),
      );
      pieceTargets.push(pieceTarget);
    }

    // One entry for an unpartitioned key; the ordered piece list for a
    // partitioned one. The shape is the combinator's own
    // `Extractor | readonly Extractor[]` per key. The loose pieces (key "")
    // assemble into the unwrapped slots instead of the named maps.
    const entry = pieceEntries.length === 1 ? pieceEntries[0] : pieceEntries;
    const pieceTarget = pieceTargets.length === 1 ? pieceTargets[0] : pieceTargets;
    if (groupKey === "") {
      unwrapped = entry;
      unwrappedTarget = pieceTarget;
    } else {
      groups[key] = entry;
      targets[key] = pieceTarget;
    }
  }

  return unwrapped === undefined
    ? { groups: groups as GroupMap<V, P>, targets: targets as GroupTargets<V, P> }
    : {
        groups: groups as Partial<GroupMap<V, P>>,
        targets: targets as Partial<GroupTargets<V, P>>,
        unwrapped: unwrapped as UnwrappedEntry<V, P>,
        unwrappedTarget: unwrappedTarget as UnwrappedTarget<V, P>,
      };
}

/**
 * One group's override: a function applied PER PIECE of that group's plan entry,
 * handing it the piece's default extractor, the piece's projected target, and
 * the piece's index. Its return replaces that piece.
 *
 * Per piece is the semantically right unit — not a convenience: a group can be
 * PARTITIONED into multiple pieces when it exceeds the nullable-union cap (the
 * Snugg Pro `health` group is exactly such a group), and an override API that
 * silently applied to only the first piece would be worse than none. A piece's
 * wrapper re-asks exactly that piece's leaves against a schema that fits. The
 * same function can also replace a group outright — by ignoring its first
 * argument and building from the second; the piece's projected target keeps the
 * partitioning intact for a replacement that maps over pieces.
 * @category Extraction
 */
export type GroupOverride<
  V extends Record<string, unknown>,
  P = NoProvenance,
  K extends keyof V & string = keyof V & string,
> = (
  entry: Extractor<Pick<Enveloped<V, P>, K>>,
  target: ExtractionTarget<Pick<V, K>, P>,
  index: number,
) => Extractor<Pick<Enveloped<V, P>, K>>;

/**
 * Apply per-group overrides to a {@link perGroupPlan} result: the defaults
 * everywhere, except the groups named in `overrides`.
 *
 * Returns the FULL composition — untouched keys are reference-equal to
 * `plan.groups`'s and the plan's `unwrapped` entry threads through untouched,
 * so a host spreads the result straight into `groupedExtractor` (`groupedExtractor({
 * target, ...overrideGroups(plan, { … }) })`) and a test or status panel can
 * still enumerate the running map and name the overridden keys. An override
 * key the plan does not carry is a compile error for a TypeScript caller (the
 * overrides object is keyed by the schema's own top-level keys) and a
 * construction-time throw naming the key for a JS caller — including any
 * override against a non-grouped fallback plan, which has no per-group entries
 * to override.
 * @category Extraction
 */
export function overrideGroups<V extends Record<string, unknown>, P = NoProvenance>(
  plan: PerGroupPlan<V, P>,
  overrides: { readonly [K in keyof V & string]?: GroupOverride<V, P, K> },
): GroupedEntries<V, P> {
  // The same read/write-through-a-record cast the plan's builder and the
  // combinator's coverage check use: the map's keys are the schema's own
  // top-level keys, checked at construction. The unwrapped portion is not a
  // key in the map — it rides the plan's `unwrapped` slot.
  const groupRecord = plan.groups as Readonly<Record<string, unknown>>;
  const targetRecord = plan.targets as Readonly<Record<string, unknown>>;
  const overrideRecord = overrides as Readonly<
    Record<string, ((entry: never, target: never, index: number) => unknown) | undefined>
  >;

  // Shallow copy: untouched keys keep their references.
  const result: Record<string, unknown> = { ...groupRecord };

  for (const key of Object.keys(overrideRecord)) {
    const override = overrideRecord[key];
    if (override === undefined) continue;
    if (!(key in groupRecord)) {
      const namedKeys = Object.keys(groupRecord);
      if (plan.unwrapped !== undefined && namedKeys.length === 0) {
        throw new Error(
          `overrideGroups: the plan's schema is not an object of groups, so there are ` +
            `no per-group entries to override (asked to override "${key}").`,
        );
      }
      if (plan.unwrapped !== undefined) {
        // A MIXED plan: there ARE per-group entries, and the loose leaves ride
        // the unwrapped portion — which takes no override: the overrides
        // object is keyed by `V`'s top-level keys and the unwrapped portion is
        // not one (mixed-schema-split design, open question 4; ADR 0023).
        // Passing `unwrapped` to groupedExtractor yourself is the escape hatch.
        throw new Error(
          `overrideGroups: the plan has no group "${key}" — its groups are ` +
            `${namedKeys.map((existing) => `"${existing}"`).join(", ")}, and its loose ` +
            `leaves ride the unwrapped portion, which takes no override. Pass \`unwrapped\` ` +
            `to groupedExtractor yourself to change loose handling.`,
        );
      }
      throw new Error(
        `overrideGroups: the plan has no group "${key}" — its schema's top-level keys ` +
          `are ${Object.keys(groupRecord)
            .map((existing) => `"${existing}"`)
            .join(", ")}.`,
      );
    }
    const entry = groupRecord[key];
    const pieceTargets = targetRecord[key];
    const call = override as (entry: unknown, target: unknown, index: number) => unknown;
    result[key] = Array.isArray(entry)
      ? (entry as readonly unknown[]).map((piece, index) =>
          call(piece, (pieceTargets as readonly unknown[])[index], index),
        )
      : call(entry, pieceTargets, 0);
  }

  return (
    plan.unwrapped === undefined
      ? { groups: result }
      : { groups: result, unwrapped: plan.unwrapped }
  ) as GroupedEntries<V, P>;
}

/**
 * The per-group managed-LLM extractor — the preset. One chat call per top-level
 * group (per partitioned piece), concurrently with a bounded pool, assembled
 * into one result. It is {@link groupedExtractor} over {@link perGroupPlan}'s
 * default map and nothing more: the combinator owns the pool, the retry budget,
 * the retry, the sibling abort, the merge, the second trust-boundary parse, the
 * single `normalize`, the usage sum and the `GroupUnit` events.
 *
 * `usage.calls` reports the real number of calls made, including retries — the
 * default entries count their own calls per run, failed attempts included.
 * @category Extraction
 */
export function perGroupExtractor<V extends Record<string, unknown>, P = NoProvenance>(
  options: PerGroupOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  const {
    target,
    normalize,
    concurrency,
    maxRetries,
    stepTimeoutMs,
    perCallCeilingMs,
    delay,
    baseMs,
    capMs,
    random,
    onUnit,
    onRetryBudget,
    requireRetryBudget,
  } = options;
  const plan = perGroupPlan(options);
  // The plan's two shapes map onto the combinator's options arms: no unwrapped
  // portion is the exhaustive named map alone; an unwrapped portion rides
  // beside the (partial) named map. Narrowing on `unwrapped` picks the arm —
  // a bare spread of the union would not match any single arm.
  const entries: GroupedEntries<V, P> =
    plan.unwrapped === undefined
      ? { groups: plan.groups }
      : { groups: plan.groups, unwrapped: plan.unwrapped };
  return groupedExtractor({
    target,
    ...entries,
    normalize,
    concurrency,
    maxRetries,
    stepTimeoutMs,
    perCallCeilingMs,
    delay,
    baseMs,
    capMs,
    random,
    onUnit,
    onRetryBudget,
    requireRetryBudget,
  });
}

/**
 * Tier 2 of the instance-modeling ladder: per-group calls where the model emits
 * the full array for each collection group. This is the default {@link perGroupExtractor}
 * behaviour, exposed as a named strategy so the ladder and the tests can refer
 * to it unambiguously.
 * @category Extraction
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
 * @category Extraction
 */
export function perGroupSingletonExtractor<V extends Record<string, unknown>, P = NoProvenance>(
  options: PerGroupOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  return perGroupExtractor({ ...options, singleton: true });
}
