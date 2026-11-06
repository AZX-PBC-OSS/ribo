/**
 * @file `schemaExtractor` — the entry point that takes a RAW zod schema.
 *
 * Someone hands Ribo the plain patch schema they wrote — or generated from a
 * database, an OpenAPI spec, a TS interface — plus a chat client and a model,
 * and gets an {@link Extractor}. Everything between is this module's job:
 *
 *   - **The `enveloped()` derivation runs here.** A plain zod schema is not a
 *     valid `extractionSchema`, and the derivation — with its provenance
 *     granularity choice — is the most confusing step in the library for a
 *     newcomer. An entry point that took an already-built TARGET would leave
 *     that step outside itself and not meet the bar. A caller who already holds
 *     a derived schema passes it under `extractionSchema` instead (see
 *     {@link EnvelopedSchemaExtractorOptions}) and it is used as-is — enveloping
 *     an enveloped schema would double-wrap it.
 *   - **The single-shot-vs-per-group selection runs here.** If the WHOLE derived
 *     schema fits under the caps, one call does the work — single-shot with a
 *     good prompt is at the accuracy floor on the measured Snugg corpus, route
 *     and model (`docs/spikes/0003-extraction-search-plan/README.md` — a measurement on
 *     THAT corpus, not a general property); otherwise the schema is split and
 *     each piece gets its own call.
 *
 * **Overlap with `perGroupExtractor`, and why this is a new name rather than a
 * widened option on it.** `perGroupExtractor` already takes a target/chat/model,
 * already handles flat schemas (its `""` fallback is effectively single-shot
 * for one), grouped schemas, and union-cap partitioning. The deltas are: a raw
 * schema input, single-shot when the WHOLE schema fits rather than one call per
 * group always, and byte-cap awareness. That is thin enough that extending
 * `perGroupExtractor` was a live option — but its byte-identical request
 * regression gate forbids silently changing its request shapes, and
 * single-shot-when-it-fits CHANGES the request shape (fewer calls, a different
 * `json_schema.name`). So the selection lives here, above the presets:
 * `perGroupExtractor` keeps its one-call-per-group contract pinned, and this
 * constructor composes it (or `singleShotExtractor`) as the evidence indicates.
 * The name says what is new: the schema is the input. See ADR 0014.
 *
 * **No provider's byte cap is baked in here.** Both caps are options; the union
 * cap defaults to `MAX_NULLABLE_UNIONS_PER_CALL` (measured, honestly labelled —
 * see its own doc), and the byte cap defaults OFF because the ceiling is named
 * by ONE route's error text and the caller whose chat client chose the route
 * knows it. See ADR 0015 and `SplitOptions.maxSerializedCharsPerGroup`.
 */

import type { z } from "zod";

import { enveloped } from "../../provenance/enveloped.js";
import type { BackoffOptions } from "../../storage/backoff.js";
import type { ChatClient } from "../../phases/chat-client.js";
import type { Enveloped, NoProvenance, ProvenanceMap } from "../../provenance/enveloped.js";
import type { ExtractionObserver, GroupUnit, WholeUnit } from "../extraction-observer.js";
import type { Extractor, ExtractionTarget } from "../extractor.js";
import type { RetryBudgetObserver } from "../../async/retry-budget.js";

import { assertWireSafeSchemaName } from "../extraction-common.js";
import type { ShapePartitions } from "../shape/derived-shape.js";
import {
  MAX_NULLABLE_UNIONS_PER_CALL,
  nullableUnionCount,
  serializedCharCount,
} from "../schema/split-schema.js";
import { perGroupExtractor } from "./per-group.js";
import { singleShotExtractor } from "../single-shot.js";

/**
 * The shared members both option shapes carry. The per-group timing knobs ride
 * along for the split path and are ignored on the single-shot path — a single
 * call has no pool to size and no retry budget to derive, and saying so here is
 * cheaper than a second options bag that drifts.
 */
interface SchemaExtractorShared<V extends Record<string, unknown>>
  extends BackoffOptions, ExtractionObserver<WholeUnit | GroupUnit>, RetryBudgetObserver {
  /** Stable identifier for the extraction — the request's base `json_schema.name`. */
  readonly name: string;
  /** Natural-language guidance for the extractor: what each field means. */
  readonly instructions: string;
  /** The injected chat transport. A fake in tests; a real client in production. */
  readonly chat: ChatClient;
  /** The model id passed through to the endpoint. */
  readonly model: string;
  /** Cap on generated tokens, passed through to each chat request. */
  readonly maxTokens?: number;
  /**
   * The deterministic, model-free pass run after the trust-boundary parse, on
   * the merged fields. Defaults to identity.
   */
  readonly normalize?: (fields: Enveloped<V, NoProvenance>) => Enveloped<V, NoProvenance>;
  /**
   * Max nullable unions per call before a group is partitioned. Defaults to
   * {@link MAX_NULLABLE_UNIONS_PER_CALL} — the measured cap, honestly labelled.
   * See `SplitOptions.maxNullableUnionsPerGroup`.
   */
  readonly maxNullableUnionsPerGroup?: number;
  /**
   * Max serialized JSON Schema characters per call — for the WHOLE schema on the
   * single-shot path, per piece on the per-group path. Defaults OFF: the
   * ceiling is named by one route's error text and the caller whose chat client
   * chose the route supplies it. See `SplitOptions.maxSerializedCharsPerGroup`
   * and ADR 0015.
   */
  readonly maxSerializedCharsPerGroup?: number;
  /** Max concurrent group calls on the per-group path. Defaults to 4. Ignored single-shot. */
  readonly concurrency?: number;
  /** Max retries per group after a transient failure, per-group path. Ignored single-shot. */
  readonly maxRetries?: number;
  /** Wall-clock ceiling for the whole extraction, per-group path. Ignored single-shot. */
  readonly stepTimeoutMs?: number;
  /** Conservative upper bound on one chat call, per-group path. Ignored single-shot. */
  readonly perCallCeilingMs?: number;
  /** Injectable sleep between retries. Defaults to `setTimeout`. */
  readonly delay?: (ms: number) => Promise<void>;
}

/**
 * Options for {@link schemaExtractor} when the caller brings the PLAIN patch
 * schema — the newcomer's shape. `enveloped()` runs here, with the caller's
 * `provenance` map deciding the granularity per group; the return type is exact.
 * @category Extraction
 */
export interface RawSchemaExtractorOptions<
  S extends z.ZodObject,
  P extends ProvenanceMap<S>,
> extends SchemaExtractorShared<Record<string, unknown>> {
  /**
   * The PLAIN patch schema you wrote. The derivation runs inside — every leaf
   * gains its provenance envelope (or its group's coarser granularity), and the
   * result is parsed against the derived schema.
   */
  readonly schema: S;
  /** Per-group provenance granularity, handed straight to `enveloped()`. */
  readonly provenance?: P;
  /** Not on this shape — this options bag brings the raw patch. */
  readonly extractionSchema?: never;
}

/**
 * Options for {@link schemaExtractor} when the caller already holds a derived
 * extraction schema. Used as-is — no second derivation runs, because enveloping
 * an enveloped schema double-wraps it. The type parameter `V` is the caller's
 * plain-values type — the patch the schema was derived from.
 * @category Extraction
 */
export interface EnvelopedSchemaExtractorOptions<
  V extends Record<string, unknown>,
> extends SchemaExtractorShared<V> {
  /**
   * An ALREADY-derived extraction schema (what `enveloped()` returns, e.g. an
   * adapter's). Carried under the target contract's own name, which is also
   * why there is no `provenance` here: the granularity was chosen when the
   * schema was derived.
   */
  readonly extractionSchema: ExtractionTarget<V, NoProvenance>["extractionSchema"];
  /**
   * The derived shape's partitions record (`DerivedExtractionShape.partitions`),
   * forwarded to the per-group split. Only on this shape: the raw shape runs
   * `enveloped()` inside and takes no shape operations, so it has no
   * partitions to give. A non-empty record also
   * forces the per-group path: one call over the whole schema would mix parts.
   */
  readonly partitions?: ShapePartitions;
  /** Not on this shape — this options bag brings the derived schema. */
  readonly schema?: never;
  readonly provenance?: never;
}

/**
 * The implementation's V-erased view of the options — not exported. The overloads
 * above carry the precise typing; this shape only has to ACCEPT both of them:
 * `schema`/`provenance` from the raw shape, `extractionSchema` from the derived
 * shape, and a `normalize` whose parameter is `never` (so every precise
 * `normalize` is assignable to it) and whose return is `unknown` (so every
 * precise return is assignable back).
 */
interface SchemaExtractorImplOptions extends Omit<
  SchemaExtractorShared<Record<string, unknown>>,
  "normalize"
> {
  readonly schema?: z.ZodObject;
  readonly provenance?: ProvenanceMap<z.ZodObject>;
  readonly extractionSchema?: EnvelopedSchemaExtractorOptions<
    Record<string, unknown>
  >["extractionSchema"];
  readonly partitions?: ShapePartitions;
  readonly normalize?: (fields: never) => unknown;
}

/** The implementation's return: the overloads narrow it per shape. */
type SchemaExtractorResult = Extractor<Enveloped<Record<string, unknown>, NoProvenance>>;

/**
 * Build an {@link Extractor} from a zod schema, a chat client and a model —
 * deriving the extraction schema and picking the call shape for the caller.
 *
 * Overload 1 takes the RAW patch (typed exactly, derivation inside); overload 2
 * takes an already-derived schema under `extractionSchema`, its `V` declared by
 * the caller. Which one applies follows which key the caller filled — there is
 * nothing to detect and no wrong detection to have.
 *
 * The selection between the two call shapes is a construction-time measurement,
 * not a model call: the whole derived schema is measured against both caps (the
 * union cap defaulting to {@link MAX_NULLABLE_UNIONS_PER_CALL}, the byte cap
 * applying only when supplied), and under the caps one `singleShotExtractor` is
 * built; past them a `perGroupExtractor` over the split. The selection is static
 * per construction — the schema and the caps are — which is what keeps this
 * library's construction synchronous.
 * @category Extraction
 */
export function schemaExtractor<
  S extends z.ZodObject,
  const P extends ProvenanceMap<S> = NoProvenance,
>(options: RawSchemaExtractorOptions<S, P>): Extractor<Enveloped<z.infer<S>, P>>;
/** @category Extraction */
export function schemaExtractor<V extends Record<string, unknown>>(
  options: EnvelopedSchemaExtractorOptions<V>,
): Extractor<Enveloped<V, NoProvenance>>;
/** @category Extraction */
export function schemaExtractor(options: SchemaExtractorImplOptions): SchemaExtractorResult {
  // Exactly one of the two shapes is filled; the keys name which the caller
  // brought, so there is nothing to detect and no wrong detection to have. The
  // overloads make both-or-neither unrepresentable for a TS caller; a JS caller
  // gets the same construction-time error instead of an undefined dereference.
  if (options.schema !== undefined && options.extractionSchema !== undefined) {
    throw new TypeError(
      "schemaExtractor: pass EITHER the plain patch schema (`schema`) OR an already-derived " +
        "extraction schema (`extractionSchema`) — not both.",
    );
  }
  const extractionSchema =
    options.extractionSchema ??
    (options.schema === undefined
      ? // Unreachable for a TS caller (the overloads require one key); a JS
        // caller passing neither is a construction mistake, not a default.
        ((): never => {
          throw new TypeError(
            "schemaExtractor: pass the plain patch schema under `schema` — or an " +
              "already-derived extraction schema under `extractionSchema`.",
          );
        })()
      : // The derivation of the caller's own patch. That its return is a
        // `ZodType<Enveloped<V, P>>` is the fact the adapter contract asserts
        // structurally and `enveloped.test.ts` pins as mutually assignable; at
        // this erased-to-`z.ZodObject` level the compiler sees it directly. The
        // caller's provenance map rides through to the derivation.
        enveloped(options.schema, {
          provenance: options.provenance,
        }));

  // The name goes onto the wire — directly single-shot, inside every piece's
  // name per-group. Guard where it is built.
  assertWireSafeSchemaName(options.name, "schemaExtractor");

  // The target the selected strategy consumes. The cast names the same fact as
  // the one above: the caller's V describes the schema they brought.
  const target = {
    name: options.name,
    extractionSchema,
    instructions: options.instructions,
  } as ExtractionTarget<Record<string, unknown>, NoProvenance>;

  // Selection: the WHOLE schema under both caps is one call; otherwise split
  // and go per-group. The union cap defaults to the measured constant; the byte
  // cap applies only when supplied — the caller knows their route's ceiling. A
  // non-empty partitions record forces the per-group path even when the schema
  // would fit: one call over the whole schema would mix the parts the caller
  // named, which is the one thing a partition forbids.
  const hasPartitions =
    options.partitions !== undefined && Object.keys(options.partitions).length > 0;
  const unionCap = options.maxNullableUnionsPerGroup ?? MAX_NULLABLE_UNIONS_PER_CALL;
  const wholeFits =
    !hasPartitions &&
    nullableUnionCount(extractionSchema) <= unionCap &&
    (options.maxSerializedCharsPerGroup === undefined ||
      serializedCharCount(extractionSchema) <= options.maxSerializedCharsPerGroup);

  const { chat, model, maxTokens, normalize, onUnit, onRetryBudget, requireRetryBudget } = options;

  if (wholeFits) {
    return singleShotExtractor<Record<string, unknown>, NoProvenance>({
      target,
      chat,
      model,
      maxTokens,
      // THE CAST: the impl options V-erase `normalize` so both overloads'
      // precise types are assignable to it; each overload re-types the result.
      ...(normalize === undefined
        ? {}
        : {
            normalize: normalize as (
              fields: Enveloped<Record<string, unknown>, NoProvenance>,
            ) => Enveloped<Record<string, unknown>, NoProvenance>,
          }),
      ...(onUnit === undefined ? {} : { onUnit }),
    });
  }

  return perGroupExtractor<Record<string, unknown>, NoProvenance>({
    target,
    chat,
    model,
    maxTokens,
    normalize: normalize as (
      fields: Enveloped<Record<string, unknown>, NoProvenance>,
    ) => Enveloped<Record<string, unknown>, NoProvenance>,
    maxNullableUnionsPerGroup: unionCap,
    ...(options.maxSerializedCharsPerGroup === undefined
      ? {}
      : { maxSerializedCharsPerGroup: options.maxSerializedCharsPerGroup }),
    ...(options.partitions === undefined ? {} : { partitions: options.partitions }),
    concurrency: options.concurrency,
    maxRetries: options.maxRetries,
    stepTimeoutMs: options.stepTimeoutMs,
    perCallCeilingMs: options.perCallCeilingMs,
    delay: options.delay,
    baseMs: options.baseMs,
    capMs: options.capMs,
    random: options.random,
    onUnit,
    onRetryBudget,
    requireRetryBudget,
  });
}
