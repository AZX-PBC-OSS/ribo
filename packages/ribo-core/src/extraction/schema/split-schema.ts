/**
 * @file Split an extraction schema into per-group schemas — the pure, model-free
 * half of R3 (per-group extraction).
 *
 * Extraction sends one chat call carrying the whole `extractionSchema`. With the
 * vendor field descriptions that schema is 39,741 bytes against a hard 32,768 cap,
 * so today we strip the descriptions and send 19,301 — losing the vendor's
 * authoritative text for 51 fields. Splitting the call per top-level group puts
 * every group comfortably under the cap **with** its descriptions (largest is
 * `health` at 13,273). This module turns one schema into the list of per-group
 * schemas; Task 2 makes the calls.
 *
 * The group list is **derived** from the schema's own top-level properties — no
 * adapter change, no hard-coded group names. `enveloped()` (ribo-core) recurses
 * into the seven resource groups rather than swallowing each into one envelope,
 * so the enveloped schema keeps the same seven top-level keys. Those keys ARE the
 * groups. A collection group (e.g. `hvac` with multiple instances) arrives as a
 * `ZodArray` whose element is a group object; the split unwraps that array and
 * still produces one entry per group. An adapter whose schema is not an object of
 * groups (a flat enveloped schema whose top-level properties are leaves, or a
 * top-level array of envelopes) gets one entry covering the whole schema — today's
 * behaviour, and the fallback rather than an error. A MIXED schema — some
 * top-level keys groups, some loose leaves — splits both ways at once: one entry
 * per group, plus the loose leaves as piece(s) keyed `""` (the unwrapped
 * portion) appended after the groups, so one loose key no longer vetoes the
 * other keys' grouping (mixed-schema-split design; ADR 0023). Because the mixed
 * branch is actively constructing pieces, the loose portion packs against
 * whichever caps were supplied — the byte cap, or the union cap alone — while
 * the all-flat fallback keeps its pinned rule: union cap only, no split at all.
 *
 * Nullable-union partitioning: a model-family investigation on the managed route
 * found that Anthropic-family models reject a response schema carrying more than
 * 16 nullable unions — a ceiling independent of the byte-size and nesting-depth
 * caps this module already respects, and invisible today because the managed route
 * is pinned to OpenAI-family models, which accept far more. Most of Snugg Pro's
 * groups already exceed it, a live break the moment that pin changes.
 * `splitExtractionSchema` fixes this at the source: when a caller passes
 * `maxNullableUnionsPerGroup`, a group carrying more than that is further
 * partitioned into multiple entries that all carry the SAME `key` (so the response
 * still lands under the one top-level property consumers expect) and are
 * distinguished by `part`/`parts`. A collection group is split within one
 * instance's property set, never across instances or the array wrapper — every
 * partitioned entry for `hvac` still carries `z.array(...)`, just with a narrower
 * per-instance shape; the same instance index across two calls is the same
 * instance. The caller (`perGroupExtractor`, or `scopedInstanceExtractor` at its
 * own `(group, instance)` slots) makes one call per entry and recombines the
 * pieces sharing a key back into one document/instance array — see their merge
 * steps. This partitioning is opt-in at this layer (omit the cap for
 * one-entry-per-group behaviour); both extractor callers default it to
 * {@link MAX_NULLABLE_UNIONS_PER_CALL} and let their own callers tune the number,
 * because a host bound by a different limit — this repo's own OpenAI-compatible
 * route is a byte cap, not a union count — should not inherit a number sized for
 * another provider.
 *
 * **The count is unions, not leaves, and that distinction is the whole point.** An
 * enveloped leaf costs two unions (`value` and `sourceSpan`, both `X.nullable()`),
 * so while every leaf was enveloped a cap of "8 leaves" and a cap of "16 unions"
 * were the same rule and the module counted leaves. A group that declares `"row"`
 * or `"none"` provenance (`enveloped()`'s `provenance` option) has plain
 * `X.nullable()` leaves worth one union each, so 15 of them plus a row `sourceSpan`
 * fit in a single call — and a leaf count would still split that group in two,
 * buying exactly nothing from the coarser provenance. Counting the nullable-union
 * cap observed on the Anthropic-family managed route — whether 16 is the vendor's
 * own limit or this route's translation of it is not established, only that the
 * limit is real and model-family-specific — is what makes the option pay. A
 * caller tuning the number is tuning the same unit: a byte-capped route sets a
 * bound it measured in unions, not in leaves.
 *
 * **Serialized size is the other cap, and it is a caller's option for the same
 * reason.** The structured-output route rejects a schema that serializes past a
 * character ceiling — `schema must serialize to <= 32768 characters and nest
 * <= 12 levels` — and a schema with few unions and many bytes sails through
 * every union check straight into that 400, which is the failure a newcomer
 * actually meets. `maxSerializedCharsPerGroup` makes the split pack against the
 * measured serialized size of each piece as well. The library carries no
 * provider's number for it: the ceiling is named by ONE route's error text and
 * differs by route, so the caller whose chat client chose the route supplies the
 * number (see `SplitOptions.maxSerializedCharsPerGroup`). Whether the caps
 * interact — a piece small enough in bytes is usually small enough in unions —
 * is not assumed: both are checked, because checking one is not checking the
 * other. The structured-output property-count and enum-value caps, and the
 * nesting-depth cap named in the same error text, are NOT packed against here —
 * see `docs/guide/schema-at-scale.md` for what they are.
 */

import { z } from "zod";

import { isExtractedSchema } from "../../provenance/provenance.js";
import type { ShapePartitions } from "../shape/derived-shape.js";

/**
 * Narrowed accessors for the zod internals this file walks.
 *
 * Zod 4's classic API types them loosely: a bare object's `.shape` indexes to `any`,
 * and `.element` / `.unwrap()` are typed against zod's CORE api, whose wrappers are not
 * the classic classes these runtime values actually are. Every schema this module sees
 * is built through the classic `z` API (`z.array`, `z.strictObject`, …), and every use
 * is guarded by an `instanceof z.Zod*` check — so each accessor narrows once, the same
 * move `ribo-core`'s `fieldAt` makes, rather than any call site silencing the
 * unsafe-* rules.
 */

/** `.unwrap()` past a nullable/optional wrapper: the classic schema it wraps. */
const unwrapped = (schema: z.ZodNullable | z.ZodOptional): z.ZodType =>
  schema.unwrap() as z.ZodType;

/** `.element` of a classic array schema: the classic schema of each item. */
const arrayElement = (schema: z.ZodArray): z.ZodType => schema.element as z.ZodType;

/** `shape[key]` for a key that came from the shape's own keys: a `ZodType` by construction. */
const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType => shape[key] as z.ZodType;

/**
 * One top-level group of an extraction schema, narrowed to exactly that group's key.
 *
 * `key` is the group's top-level property name (e.g. `"hvac"`), or `""` for
 * the UNWRAPPED PORTION — pieces whose schema is not nested under a group key.
 * For an all-flat schema (top-level properties are leaves rather than groups)
 * that portion is the whole schema — the non-grouped fallback; for a mixed
 * schema it is only the loose leaves. The unwrapped portion may be SEVERAL
 * entries sharing `key === ""`: one per partitioned piece, distinguished by
 * `part`/`parts`, when a byte cap was supplied and the portion's serialized
 * size exceeds it. Each unwrapped piece's `schema` is
 * `z.strictObject({ leafA, leafB, … })` (no wrapping object) carrying a
 * disjoint subset of the schema's top-level leaves.
 *
 * `schema` is shaped like the final answer but carrying exactly this group's
 * top-level key — `z.strictObject({ [key]: groupSchema })` — so Task 2 constrains
 * each chat call with it and merges responses by shallow `Object.assign` rather
 * than re-keying: each parsed response has one top-level key, so assigning them
 * in sequence produces the whole without any re-keying step.
 */
export interface ExtractionGroup {
  /** The top-level key this group covers, or `""` for the unwrapped portion. */
  readonly key: string;
  /**
   * A zod schema carrying exactly this group's top-level key (or the schema's
   * own top-level leaves, narrowed to the piece's subset, for the flat
   * fallback). Strict/closed so a response carrying another group's key is
   * rejected — the split narrows rather than relabels. When `part` is present,
   * this carries only that piece's subset of `key`'s leaves, not all of them.
   */
  readonly schema: z.ZodType;
  /**
   * This entry's 0-based position among the pieces sharing `key`, present only
   * when `key`'s leaves were partitioned across multiple calls. Partitioning
   * applies when a caller opted in via `maxNullableUnionsPerGroup` (the grouped
   * path) or via `maxSerializedCharsPerGroup` (the union AND flat paths) — or
   * when a `partitions` entry cuts the group along its parts, which always
   * numbers its pieces. Undefined for a group under the cap with no partition.
   */
  readonly part?: number;
  /** The total number of pieces sharing `key`, present exactly when `part` is. */
  readonly parts?: number;
  /**
   * The partition label this piece was cut along — the parts record's label
   * (`remainder` for the applier's implicit remainder part). Present exactly
   * when the group has an entry in the caller's `partitions`, even when the
   * group fits whole under the caps: a partitioned group is one piece per part.
   * The request builders render {@link partitionLabelLine} from it.
   */
  readonly label?: string;
}

/**
 * The per-call ceiling this module partitions against: 16 nullable unions, the
 * cap measured against Anthropic-family models on the managed route (16 accepted,
 * 18 rejected). Whether 16 is the vendor's own limit or this route's translation
 * of it is not established — only that it is real and model-family-specific. See
 * the file header. Exported so a caller and its tests share one number rather
 * than two that can drift.
 *
 * **Unions, not leaves.** This used to be `MAX_ENVELOPED_LEAVES_PER_GROUP = 8`,
 * and 8 was only ever the cap divided by the two nullable unions an enveloped
 * leaf emits. That division stops holding the moment a group declares `"row"` or
 * `"none"` provenance (`enveloped()`'s `provenance` option): those leaves are
 * plain `X.nullable()` and cost ONE union each, so a 15-leaf row group plus its
 * row span is 16 unions and fits in a single call — while a leaf count of 8 would
 * still split it in two and buy nothing. Counting the nullable-union cap observed
 * on the Anthropic-family managed route removes the assumption instead of
 * re-deriving it; whether 16 is the vendor's own limit or this route's
 * translation of it is not established here.
 *
 * Nothing moves for an all-enveloped schema: 8 leaves x 2 unions is exactly 16,
 * so every partition boundary this module produced before is the boundary it
 * produces now.
 */
export const MAX_NULLABLE_UNIONS_PER_CALL = 16;

/**
 * The caps {@link splitExtractionSchema} packs against, as an options bag.
 *
 * A bare number as the second argument is still accepted and means
 * `{ maxNullableUnionsPerGroup: number }` — every caller written before the byte
 * cap existed keeps working untouched.
 *
 * Both members are optional, and an absent member means THAT CAP IS OFF — the
 * split packs against only the caps the caller supplied. The library carries no
 * provider's number for the byte cap (see the file header): the caller whose
 * chat client chose the route supplies the route's own. `perGroupPlan` and
 * `scopedInstanceExtractor` default the union cap to
 * {@link MAX_NULLABLE_UNIONS_PER_CALL}; the byte cap reaches them as a
 * pass-through option where their caller knows the route.
 */
export interface SplitOptions {
  /**
   * Max nullable unions per piece before a group is partitioned across multiple
   * entries sharing its key. A mixed schema's loose portion (the `""` pieces)
   * packs against this cap too — the module emits no piece over a cap it was
   * given — while an ALL-FLAT schema is still not split by it at all (see
   * `splitExtractionSchema`'s doc for the distinction). Omitted, the split
   * keeps one-entry-per-group behaviour (the pre-option behaviour, and today's
   * default for a bare positional call).
   */
  readonly maxNullableUnionsPerGroup?: number;
  /**
   * Max serialized JSON Schema characters per piece, measured with
   * `z.toJSONSchema(schema, { target: "draft-2020-12" })` — the same rendering
   * the request's `response_format` carries. A group whose piece exceeds it is
   * partitioned further, exactly as the union cap partitions. Omitted, size is
   * not measured and nothing packs against it.
   *
   * A single property that cannot fit any piece — its own serialized size is
   * over the cap — throws at construction, naming the group, the property, the
   * measured size, the cap and this option: a silent over-cap piece would fail
   * later at the provider with a 400 indistinguishable from other schema
   * rejections (see the file header), and the schema author is present at
   * construction.
   */
  readonly maxSerializedCharsPerGroup?: number;
  /**
   * The derived shape's partitions record (`DerivedExtractionShape.partitions`):
   * group key → part label → the group's direct field names in extraction-schema
   * space. A group with an entry is cut along its parts FIRST — one subset per
   * label in record order, each subset then packed by the caps as usual — and
   * every piece of the group carries its part's `label`. The cut applies even
   * when the whole group fits under the caps (a partition changes what one call
   * may mix, not only how much). Fields no part names ride an implicit
   * `remainder` piece, so nothing goes unextracted from a hand-built record;
   * the applier writes `remainder` itself. Absent or empty, every group is cut
   * exactly as before — byte-identical output.
   */
  readonly partitions?: ShapePartitions;
}

/** Normalize the second argument: a bare number is the pre-options positional union cap. */
function normalizeOptions(options?: number | SplitOptions): SplitOptions {
  if (typeof options === "number") return { maxNullableUnionsPerGroup: options };
  return options ?? {};
}

/**
 * The one line a labelled piece's request carries, naming the part it covers —
 * the same sentence under the per-group calls, the per-instance fills and the
 * batched fills, so a call always says which slice of the group it is asking
 * about. The part is the unit of every call shape (spec §4); the line is the
 * prompt's only trace of it. Exported because the phase presets build their own
 * requests and reuse it verbatim.
 */
export function partitionLabelLine(groupKey: string, label: string): string {
  return `This call covers the ${label} fields of ${groupKey}.`;
}

/**
 * The serialized size of a schema, in the exact rendering a request's
 * `response_format` carries. Exported for the extraction strategies above this
 * module, which must measure the WHOLE schema against the same caps the split
 * packs its pieces against.
 *
 * Measured on the FULL rendering, descriptions included — the conservative
 * upper bound of the wire size. Under `fieldDescriptions: "prompt"` the
 * wire schema is stripped at the render sites, so it only ever lands further
 * under a byte cap than this count reports; the split packs exactly as before.
 */
export function serializedCharCount(schema: z.ZodType): number {
  return JSON.stringify(z.toJSONSchema(schema, { target: "draft-2020-12" })).length;
}

/**
 * The nesting depth of a schema's serialized JSON Schema rendering — the same
 * rendering {@link serializedCharCount} measures — as the structured-output
 * route counts it: raw JSON nesting, a scalar counting 1 and every object or
 * array adding 1. `anyOf` arms and array indices are levels, so every
 * `.nullable()` costs two. Probed against the live route on 2026-09-22: 12
 * passes, 13 is rejected, and a one-property schema was rejected for a nested
 * array inside an `enum` value. Counting only `properties` descents, as this
 * once did, ranked a rejected schema shallower than accepted ones.
 *
 * Measured, never packed against: the split partitions on unions and bytes,
 * while the depth cap is named in the same route error and deliberately NOT
 * packed against (see the file header), so this number exists for a caller to
 * compare against their own route's cap — the adapter's
 * `SCHEMA_NESTING_DEPTH_CAP` suite is the worked example. Descriptions are
 * scalars beside `type`, so stripping them never changes it.
 */
export function serializedNestingDepth(schema: z.ZodType): number {
  return jsonNestingDepth(z.toJSONSchema(schema, { target: "draft-2020-12" }));
}

function jsonNestingDepth(node: unknown): number {
  if (node === null || typeof node !== "object") return 1;
  let deepest = 0;
  for (const child of Object.values(node)) deepest = Math.max(deepest, jsonNestingDepth(child));
  return 1 + deepest;
}

/**
 * How many nullable unions a whole schema costs the response schema — the
 * per-call unit {@link MAX_NULLABLE_UNIONS_PER_CALL} counts in. Exported beside
 * {@link serializedCharCount} for the same reason: a strategy deciding between
 * one call and a split asks this of the whole schema.
 */
export function nullableUnionCount(schema: z.ZodType): number {
  return nullableUnions(schema);
}

/**
 * How many nullable unions one property of a group costs the response schema.
 *
 * Counts every `ZodNullable` in the subtree, which is what a nullable union IS in
 * the emitted JSON Schema (`anyOf: [X, { type: "null" }]`). An enveloped leaf has
 * two (`value`, `sourceSpan`); a plain leaf under `"row"`/`"none"` provenance has
 * one; a row's own `sourceSpan` has one. Optionals are counted too — no extraction
 * schema this module sees has any, but one would emit the same union shape, and a
 * count that silently ignored it would under-report.
 */
function nullableUnions(schema: z.ZodType): number {
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) {
    return 1 + nullableUnions(unwrapped(schema));
  }
  if (schema instanceof z.ZodArray) {
    return nullableUnions(arrayElement(schema));
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    return Object.keys(shape).reduce(
      (total, key) => total + nullableUnions(fieldAt(shape, key)),
      0,
    );
  }
  return 0;
}

/**
 * Greedily fill pieces from `weights` in declaration order, never exceeding
 * `limit`. Returns one property count per piece, and so the FEWEST pieces the cap
 * allows.
 *
 * Declaration order is preserved, so which properties land in which piece is a
 * pure, deterministic function of the schema itself — no adapter knowledge, no
 * hard-coded field names, matching the rest of this module's derive-don't-
 * configure approach.
 */
function fewestPieces(weights: readonly number[], limit: number): number[] {
  const sizes: number[] = [];
  let count = 0;
  let load = 0;
  for (const weight of weights) {
    if (count > 0 && load + weight > limit) {
      sizes.push(count);
      count = 0;
      load = 0;
    }
    count++;
    load += weight;
  }
  if (count > 0) sizes.push(count);
  return sizes;
}

/** Split `total` properties into at most `parts` pieces of equal COUNT. */
function equalCounts(total: number, parts: number): number[] {
  const pieceSize = Math.ceil(total / parts);
  const sizes: number[] = [];
  for (let start = 0; start < total; start += pieceSize) {
    sizes.push(Math.min(pieceSize, total - start));
  }
  return sizes;
}

/** Does every piece of this layout stay under the union cap? */
function fits(weights: readonly number[], sizes: readonly number[], limit: number): boolean {
  let start = 0;
  for (const size of sizes) {
    let load = 0;
    for (let i = start; i < start + size; i++) load += weights[i]!;
    if (load > limit) return false;
    start += size;
  }
  return true;
}

/**
 * Split one top-level group's properties into pieces of at most `maxUnions`
 * nullable unions each, as evenly sized as possible.
 *
 * Two passes, because "fewest pieces" and "evenly sized" are different answers.
 * The first fills to the cap and so finds the minimum number of CALLS, which is
 * the number that matters; the second re-slices into that many pieces of equal
 * property count, which is what turns 12 enveloped leaves into 6+6 rather than
 * 8+4. Both fit under the cap, but even pieces make per-call cost predictable and
 * leave no piece sitting one wording change from the ceiling. The even layout is
 * only taken if it actually fits — equal COUNTS need not mean equal unions once a
 * group mixes enveloped and plain leaves — so the cap is never traded for tidiness.
 *
 * `value` is the group's raw top-level property — either the group object
 * directly (a singleton group, e.g. `health`) or a `ZodArray` of it (a collection
 * group, e.g. `hvac`). `candidate` is `value` with any array wrapper already
 * peeled off (by the caller, via {@link groupCandidate}) — the object whose keys
 * are this group's leaves, plus, under `"row"` provenance, the row's own
 * `sourceSpan`. The split narrows only `candidate`'s shape; a collection group's
 * array wrapper is rebuilt around each piece unchanged, so a partition never spans
 * instances or unwraps the array itself.
 */
function partitionGroup(
  key: string,
  value: z.ZodType,
  candidate: z.ZodObject,
  maxUnions: number,
): ExtractionGroup[] {
  const propertyKeys = Object.keys(candidate.shape);
  const weights = propertyKeys.map((k) => nullableUnions(fieldAt(candidate.shape, k)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  if (total <= maxUnions) {
    return [{ key, schema: z.strictObject({ [key]: value }) }];
  }

  // A single property whose own weight exceeds the cap cannot fit any piece —
  // `fewestPieces` would emit it alone, over the cap, and the request would die
  // at the provider with a 400 indistinguishable from every other schema
  // rejection. Fail at construction instead, where the schema author is present.
  // (No test or caller of the shipped schemas hits this: every enveloped leaf
  // is two unions, half the default cap.)
  const overweight = propertyKeys.findIndex((_, i) => weights[i]! > maxUnions);
  if (overweight >= 0) {
    throw new Error(
      `splitExtractionSchema: group "${key}" has a property ` +
        `"${propertyKeys[overweight]}" that cannot fit any piece — it costs ` +
        `${weights[overweight]} nullable unions, over the maxNullableUnionsPerGroup cap of ` +
        `${maxUnions}. Narrow the schema or raise the cap.`,
    );
  }

  const minimal = fewestPieces(weights, maxUnions);
  const even = equalCounts(propertyKeys.length, minimal.length);
  const sizes = fits(weights, even, maxUnions) ? even : minimal;

  const isArray = value instanceof z.ZodArray;
  const pieces: ExtractionGroup[] = [];
  let start = 0;
  for (let part = 0; part < sizes.length; part++) {
    const pieceKeys = propertyKeys.slice(start, start + sizes[part]!);
    start += sizes[part]!;
    const pieceShape: Record<string, z.ZodType> = {};
    for (const leafKey of pieceKeys) pieceShape[leafKey] = fieldAt(candidate.shape, leafKey);
    const pieceCandidate = z.strictObject(pieceShape);
    const pieceValue = isArray ? z.array(pieceCandidate) : pieceCandidate;
    pieces.push({
      key,
      schema: z.strictObject({ [key]: pieceValue }),
      part,
      parts: sizes.length,
    });
  }
  return pieces;
}

/**
 * A top-level group may be a plain `ZodObject` or a `ZodArray` whose element is
 * that group object. Arrays are not groups themselves; the element schema is what
 * the split inspects. This matters because a collection group (e.g. `hvac` with
 * multiple instances) arrives as `z.array(GroupSchema)` after the derivation that
 * turns patch objects into collections, and the per-group call must still be
 * constrained to one top-level key.
 */
const groupCandidate = (value: z.ZodType): z.ZodType =>
  // `arrayElement` narrows the core-typed element to the classic wrapper — this
  // function only receives schemas built through the classic `z` API.
  value instanceof z.ZodArray ? arrayElement(value) : value;

/**
 * Split one top-level group's properties into pieces that satisfy BOTH caps,
 * greedily in declaration order. Used when a byte cap is supplied; the
 * union-only path keeps {@link partitionGroup}'s even-sizing exactly, because
 * the request regression gates pin the boundaries it produces.
 *
 * Greedy rather than two-pass even: the even pass re-slices by property COUNT
 * and verifies unions after the fact, which cannot see bytes. Here a piece is
 * closed the first time the NEXT property would push it over either cap, and
 * every emitted piece was measured under both caps when it was closed — the
 * measurement is the final piece's own serialized form, so `$defs` folding and
 * wrapper overhead are counted exactly, not estimated from per-property sums.
 * The cost is O(n²) serializations in the group's property count, paid once at
 * construction.
 *
 * The even-sizing nicety is deliberately not reproduced here: a piece layout
 * that fits exact bytes is a fact about the schema, not a tidiness target, and
 * a cap is never traded for even pieces.
 */
function partitionGroupTwoCaps(
  key: string,
  value: z.ZodType,
  candidate: z.ZodObject,
  maxUnions: number | undefined,
  maxChars: number,
): ExtractionGroup[] {
  const propertyKeys = Object.keys(candidate.shape);
  const isArray = value instanceof z.ZodArray;
  const pieceSchema = (keys: readonly string[]): z.ZodObject => {
    const pieceShape: Record<string, z.ZodType> = {};
    for (const leafKey of keys) pieceShape[leafKey] = fieldAt(candidate.shape, leafKey);
    const pieceCandidate = z.strictObject(pieceShape);
    return z.strictObject({ [key]: isArray ? z.array(pieceCandidate) : pieceCandidate });
  };
  const unionWeight = (keys: readonly string[]): number =>
    keys.reduce((sum, k) => sum + nullableUnions(fieldAt(candidate.shape, k)), 0);
  const charWeight = (keys: readonly string[]): number =>
    keys.length === 0 ? 0 : serializedCharCount(pieceSchema(keys));

  const fits = (keys: readonly string[]): boolean =>
    (maxUnions === undefined || unionWeight(keys) <= maxUnions) && charWeight(keys) <= maxChars;

  const pieces: string[][] = [];
  let current: string[] = [];
  for (const leafKey of propertyKeys) {
    if (!fits([leafKey])) {
      // A single property that fits no piece: every partition carries it over
      // the cap, so the split cannot serve this schema. Fail here, where the
      // schema author is present — the alternative is a request that fails at
      // the provider with a 400 that reads identically to every other schema
      // rejection. See `SplitOptions`'s members for both caps' phrasing.
      const measured = [
        ...(maxUnions === undefined ? [] : [`${unionWeight([leafKey])} nullable unions`]),
        `${charWeight([leafKey])} serialized characters`,
      ].join(" and ");
      const caps =
        maxUnions === undefined
          ? `the maxSerializedCharsPerGroup cap of ${maxChars}`
          : `the caps (maxNullableUnionsPerGroup ${maxUnions}, maxSerializedCharsPerGroup ${maxChars})`;
      throw new Error(
        `splitExtractionSchema: group "${key}" has a property "${leafKey}" that cannot fit any ` +
          `piece — one piece carrying it alone is ${measured}, over ${caps}. ` +
          `Narrow the schema or raise the cap.`,
      );
    }
    const trial = [...current, leafKey];
    if (fits(trial)) {
      current = trial;
    } else {
      pieces.push(current);
      current = [leafKey];
    }
  }
  if (current.length > 0) pieces.push(current);

  // A group that fits as one piece carries NO part/parts — the same shape the
  // union-only path emits for an unpartitioned group, so names, examples and
  // `leafKeys` downstream cannot tell the two paths apart.
  if (pieces.length === 1) {
    return [{ key, schema: pieceSchema(pieces[0]!) }];
  }

  return pieces.map((pieceKeys, part) => ({
    key,
    schema: pieceSchema(pieceKeys),
    part,
    parts: pieces.length,
  }));
}

/**
 * Cut one group along its partition's parts, then pack each part's subset with
 * the packer the group would otherwise use (`pack`).
 *
 * Each part becomes a candidate object of exactly its fields — in schema
 * declaration order, whatever order the record listed them in — and the
 * packer's pieces inherit the part's label. Every piece is then renumbered
 * across the WHOLE key (`part` 0…n−1, `parts` n), so the merge, the request
 * names and skipped-item reporting see one cut per key, whatever packed each
 * part inside it. Fields no part names ride one implicit `remainder` piece:
 * the applier writes `remainder` itself, so this only guards a hand-built
 * record against silently dropping a leaf from every piece.
 */
function cutAlongParts(
  key: string,
  value: z.ZodType,
  candidate: z.ZodObject,
  partition: Readonly<Record<string, readonly string[]>>,
  pack: (partCandidate: z.ZodObject) => readonly ExtractionGroup[],
): ExtractionGroup[] {
  const shape = candidate.shape;
  const propertyKeys = Object.keys(shape);
  const named = new Set<string>();
  for (const fields of Object.values(partition)) {
    for (const field of fields) named.add(field);
  }
  const labelled: (readonly [string, readonly string[]])[] = Object.entries(partition);
  const remainder = propertyKeys.filter((field) => !named.has(field));
  if (remainder.length > 0) labelled.push(["remainder", remainder]);

  const pieces: ExtractionGroup[] = [];
  for (const [label, fields] of labelled) {
    for (const field of fields) {
      if (!Object.hasOwn(shape, field)) {
        throw new Error(
          `splitExtractionSchema: group "${key}" has a partition field "${field}" that is not a ` +
            `property of the group — a partition's fields are the group's direct properties.`,
        );
      }
    }
    // Declaration order, not the record's listing order: the labels decide the
    // cut, the schema decides what order a part's fields travel in.
    const fieldSet = new Set(fields);
    const partShape: Record<string, z.ZodType> = {};
    for (const field of propertyKeys) {
      if (fieldSet.has(field)) partShape[field] = fieldAt(shape, field);
    }
    const partCandidate = z.strictObject(partShape);
    for (const piece of pack(partCandidate)) pieces.push({ ...piece, label });
  }
  return pieces.map((piece, part) => ({ ...piece, part, parts: pieces.length }));
}

/**
 * Split a FLAT extraction schema's top-level properties into pieces that
 * satisfy the supplied caps, greedily in declaration order. The flat
 * counterpart of {@link partitionGroupTwoCaps}): the input is the schema's
 * top-level object — the schema is not an object of nested groups, so there
 * is no `ZodArray` to rebuild around a piece and no per-group wrapping key to
 * preserve. Each emitted piece is `z.strictObject({ leafA, leafB, … })` — the
 * WHOLE schema with the unallocated leaves removed.
 *
 * Either cap may be off (`undefined`); the caller guarantees at least one is
 * on. The all-flat fallback reaches here only under a byte cap — under the
 * union cap alone an all-flat schema is not split at all — but a MIXED
 * schema's loose portion packs through here under the union cap alone too:
 * the module is actively constructing the mixed pieces, so everything it
 * emits must satisfy the caps it was given (see `splitExtractionSchema`).
 *
 * The pieces share `key === ""`, the existing flat-fallback marker, and a
 * downstream consumer recombines them with a shallow `Object.assign`: each
 * piece's parsed response is the disjoint subset of leaves it asked for, and
 * assignment in piece order is the merge (no leaf overlaps another piece's,
 * by construction). The single-overweight-leaf refusal mirrors
 * {@link partitionGroupTwoCaps} but names the leaf alone — there is no
 * enclosing group to anchor it to.
 */
function partitionFlatTwoCaps(
  wholeSchema: z.ZodObject,
  maxUnions: number | undefined,
  maxChars: number | undefined,
): ExtractionGroup[] {
  const candidate = wholeSchema;
  const propertyKeys = Object.keys(candidate.shape);
  const pieceSchema = (keys: readonly string[]): z.ZodObject => {
    const pieceShape: Record<string, z.ZodType> = {};
    for (const leafKey of keys) pieceShape[leafKey] = fieldAt(candidate.shape, leafKey);
    return z.strictObject(pieceShape);
  };
  const unionWeight = (keys: readonly string[]): number =>
    keys.reduce((sum, k) => sum + nullableUnions(fieldAt(candidate.shape, k)), 0);
  const charWeight = (keys: readonly string[]): number =>
    keys.length === 0 ? 0 : serializedCharCount(pieceSchema(keys));

  const fits = (keys: readonly string[]): boolean =>
    (maxUnions === undefined || unionWeight(keys) <= maxUnions) &&
    (maxChars === undefined || charWeight(keys) <= maxChars);

  const pieces: string[][] = [];
  let current: string[] = [];
  for (const leafKey of propertyKeys) {
    if (!fits([leafKey])) {
      const measured = [
        ...(maxUnions === undefined ? [] : [`${unionWeight([leafKey])} nullable unions`]),
        ...(maxChars === undefined ? [] : [`${charWeight([leafKey])} serialized characters`]),
      ].join(" and ");
      const caps =
        maxUnions === undefined
          ? `the maxSerializedCharsPerGroup cap of ${maxChars}`
          : maxChars === undefined
            ? `the maxNullableUnionsPerGroup cap of ${maxUnions}`
            : `the caps (maxNullableUnionsPerGroup ${maxUnions}, maxSerializedCharsPerGroup ${maxChars})`;
      throw new Error(
        `splitExtractionSchema: schema has a property "${leafKey}" that cannot fit any ` +
          `piece — one piece carrying it alone is ${measured}, over ${caps}. ` +
          `Narrow the schema or raise the cap.`,
      );
    }
    const trial = [...current, leafKey];
    if (fits(trial)) {
      current = trial;
    } else {
      pieces.push(current);
      current = [leafKey];
    }
  }
  if (current.length > 0) pieces.push(current);

  // A flat schema that fits as one piece carries NO part/parts, and the entry's
  // schema IS the whole input — preserving `Object.is` identity with the input
  // so the existing per-group fallback (single-piece plan entry keyed "",
  // target's instructions, full examples, the canonical `schema` reference) is
  // byte-identical whether a byte cap was supplied and the schema fits it, or
  // none was supplied at all.
  if (pieces.length === 1) {
    return [{ key: "", schema: wholeSchema }];
  }

  return pieces.map((pieceKeys, part) => ({
    key: "",
    schema: pieceSchema(pieceKeys),
    part,
    parts: pieces.length,
  }));
}

/**
 * Whether a `ZodObject` is a **group** (a nested object of leaves or sub-groups)
 * rather than an **envelope** (a `{ value, confidence, sourceSpan }` leaf wrapper).
 *
 * This used to test that every property was itself a `ZodObject`: an enveloped
 * group's properties are all envelopes, and an envelope's own `confidence` is a
 * bare `z.number()`, so the two were separable without naming the envelope's keys.
 * That reading breaks the moment a group declares `"row"` or `"none"` provenance,
 * because those groups' properties are plain leaves — not objects — so the test
 * calls such a group an envelope, decides the whole schema is not grouped, and
 * silently collapses the per-group split back to one call carrying everything.
 *
 * So the question is asked directly instead: `isExtractedSchema` (ribo-core, beside
 * the `extractedSchema` it recognises) says whether this IS an envelope, and
 * anything else with properties is a group. An empty object is neither — nothing to
 * ask about — so it returns `false` and falls back.
 */
const isGroupObject = (obj: z.ZodObject): boolean =>
  Object.keys(obj.shape).length > 0 && !isExtractedSchema(obj);

/** How the split sees one top-level key: a group it can split per key, or a loose leaf. */
export type TopLevelKeyKind = "group" | "loose";

/** One top-level key of an extraction schema, with the kind the split's gate assigns it. */
export interface TopLevelKey {
  readonly key: string;
  readonly kind: TopLevelKeyKind;
}

/**
 * The answer to the split's opening question, as a value a caller can read.
 *
 * `"not-an-object"` and `"empty"` are the two pre-key fallbacks: a schema that
 * is not a `ZodObject`, or one with no properties, takes the single `""` entry
 * under every cap. The `"keys"` form carries the object back, narrowed, so the
 * split — and only code sharing its walk — reads the same keys and values the
 * verdict was computed from, with no second `instanceof` narrowing to drift
 * from.
 */
export type TopLevelKeyKinds =
  | { readonly form: "not-an-object" }
  | { readonly form: "empty" }
  | {
      readonly form: "keys";
      readonly schema: z.ZodObject;
      readonly keys: readonly TopLevelKey[];
      /**
       * The split's gate, computed where its inputs live: every top-level key
       * is a group, so the grouped path applies. One loose key makes this
       * false and the whole schema takes the flat fallback.
       */
      readonly everyKeyIsGroup: boolean;
    };

/**
 * Classify a schema's top-level keys the way {@link splitExtractionSchema}
 * does — because the split derives its grouped/flat decision from THIS
 * function's answer. Every top-level property must be a group (a `ZodObject`,
 * or a `ZodArray` of one, that is not itself a leaf envelope) for the split to
 * apply; a single loose top-level leaf — the shape a flat (non-grouped)
 * enveloped schema has at every key — sends the whole schema down the flat
 * fallback. Exported so a diagnostic (`describeExtraction`) reports the split's
 * own verdict rather than a parallel walk that agrees today and drifts
 * tomorrow.
 */
export function topLevelKeyKinds(schema: z.ZodType): TopLevelKeyKinds {
  if (!(schema instanceof z.ZodObject)) {
    return { form: "not-an-object" };
  }
  const shape = schema.shape;
  const keys = Object.keys(shape);
  if (keys.length === 0) {
    return { form: "empty" };
  }
  const classified = keys.map((key): TopLevelKey => {
    const candidate = groupCandidate(fieldAt(shape, key));
    return {
      key,
      kind: candidate instanceof z.ZodObject && isGroupObject(candidate) ? "group" : "loose",
    };
  });
  return {
    form: "keys",
    schema,
    keys: classified,
    everyKeyIsGroup: classified.every((entry) => entry.kind === "group"),
  };
}

/**
 * Split an extraction schema into per-group schemas.
 *
 * Given a target's `extractionSchema`, produce the list of top-level groups and,
 * for each, a schema containing exactly that one key. The group list is derived
 * from the schema's own top-level properties, so this works for any adapter and
 * requires no adapter change.
 *
 * A schema with NO group keys — a top-level array of envelopes, a non-object
 * schema, an empty object, or an object whose top-level properties are all
 * leaf envelopes — returns ONE entry whose `key` is `""` and whose `schema` is
 * the whole input, under every cap (with a byte cap, a flat OBJECT partitions
 * over its top-level leaves into several `""`-sharing entries — the packed-flat
 * path). An empty object or a non-object is either un-partitionable (a
 * non-object cannot be packed by top-level keys, because there are no
 * top-level keys) or has nothing to partition (an empty object has no leaves),
 * so the whole schema lands in a single fallback entry. A caller with a
 * top-level array of envelopes over a byte cap still gets the silent oversized
 * request this change set out to kill — that schema is a real call site, and
 * the fix is to wrap it in an object of groups (or to skip the byte cap). The
 * split does not invent structure the schema does not carry.
 *
 * A MIXED schema — some top-level keys groups, some loose leaves — splits both
 * ways at once: the group keys take the grouped path unchanged, and the loose
 * keys are collected into a strict object of their own, keyed `""`, appended
 * after the groups. That loose object packs through the same flat machinery
 * (pieces sharing `""`, `part`/`parts`) under a byte cap — and under the
 * union cap alone too, because here the module is actively constructing
 * pieces and everything it emits must satisfy the caps it was given (the
 * all-flat asymmetry below is the contrast case). `""` therefore means THE
 * UNWRAPPED PORTION, not "the whole schema": the two coincide only when no
 * top-level key is a group (mixed-schema-split design §5; ADR 0023).
 *
 * Without a byte cap, the flat object path is also a single entry: one call
 * carrying everything — the measured-good single-shot path. With a byte cap,
 * the flat object path partitions over its top-level keys into several
 * entries that all share `key === ""`, each a strict object carrying a
 * disjoint subset of leaves. Every consumer that special-cases `""` (the
 * per-group plan's early-return for the under-cap flat case,
 * `groupedExtractor`'s merge, `prepareGroups`, the inventory/fill phases) was
 * written to handle that case — its shallow-assign merge recombines a
 * partitioned flat schema's pieces in declaration order, because each piece's
 * parsed response holds a disjoint subset of leaves. **The union cap alone
 * does not partition an ALL-FLAT schema** (the test at
 * `split-schema-unions.test.ts:96` pins this), and the distinction is the
 * argument: when the schema is all-flat the module declines to split at all
 * and returns the input, claiming nothing — so there is no emitted piece to
 * hold against the cap. In a mixed split the module IS constructing pieces,
 * so the loose portion packs under the union cap too; the asymmetry is not
 * "flat material never partitions by unions" but "the module never emits a
 * piece that exceeds a cap it was given".
 *
 * @param options - The caps to pack against, as a {@link SplitOptions} bag — or
 *   a bare number, which is the pre-options positional form and means
 *   `maxNullableUnionsPerGroup`. Absent members mean those caps are off; see the
 *   interface for both defaults and why the byte cap carries no provider's
 *   number.
 */
export function splitExtractionSchema(
  schema: z.ZodType,
  options?: number | SplitOptions,
): readonly ExtractionGroup[] {
  const { maxNullableUnionsPerGroup, maxSerializedCharsPerGroup, partitions } =
    normalizeOptions(options);

  // The grouped/flat question is asked of the shared classifier — asked ONCE,
  // here, so `describeExtraction` can report this function's own answer rather
  // than re-implement it. The `"keys"` form carries the shape the verdict was
  // computed from, so nothing below re-narrows the schema.
  const classification = topLevelKeyKinds(schema);
  if (classification.form !== "keys") {
    return [{ key: "", schema }];
  }
  const objectSchema = classification.schema;
  const shape = objectSchema.shape;

  // Split the classified keys into the two the mixed split needs. The KINDS come
  // from the shared classifier above, not from a second walk: `describeExtraction`
  // reports this function's own verdict, and a duplicated predicate here is
  // exactly the drift its agreement matrix exists to catch. A key is a group when
  // its candidate (the value, or the array's element) is a ZodObject that is not
  // itself a leaf envelope; loose otherwise — a leaf envelope (the flat case) or
  // an array of envelopes. One loose key used to veto the whole split (the old
  // `everyKeyIsGroup` gate collapsed a mixed schema to the flat fallback); now the
  // groups split as groups and the loose keys ride their own piece(s) keyed "" —
  // the unwrapped portion (mixed-schema-split design §5.1).
  const groupKeys: string[] = [];
  const looseKeys: string[] = [];
  for (const entry of classification.keys) {
    (entry.kind === "group" ? groupKeys : looseKeys).push(entry.key);
  }

  if (groupKeys.length === 0) {
    // The non-grouped fallback: no groups at all. Without a byte cap, this is
    // the whole schema as one entry — the unchanged behaviour under ADR 0015
    // (default-off byte cap, union cap irrelevant — see the file header &
    // `split-schema-unions.test.ts` for the union path pinning).
    //
    // **With a byte cap, the flat fallback now partitions** — every consumer that
    // special-cases `key === ""` (per-group's early-return, grouped-extractor's
    // merge, scoped-instance's prepare-groups, the inventory/fill phases) was
    // written to handle a single flat entry; the pieces this helper produces
    // share `key === ""` and a downstream consumer recombines them with the
    // existing shallow-assign merge, because each piece's parsed response is a
    // disjoint subset of the schema's leaves and the pieces run in declaration
    // order.
    if (maxSerializedCharsPerGroup === undefined) {
      return [{ key: "", schema }];
    }
    // No groups to partition over — the boundary property the grouped branch
    // walks doesn't exist. The flat packer reads the schema's own top-level keys
    // and produces pieces without a wrapping object.
    return partitionFlatTwoCaps(
      objectSchema,
      maxNullableUnionsPerGroup,
      maxSerializedCharsPerGroup,
    );
  }

  // The group entries are the grouped path verbatim, run over the group keys.
  // Under a byte cap the pieces are measured exactly (see
  // `partitionGroupTwoCaps`), so the request's own rendering is what was
  // verified. A group with a `partitions` entry is cut along its parts first —
  // each part's subset packed by the same packer the whole group would have
  // had, every piece renumbered across the key and carrying its part's label.
  const groupPieces: ExtractionGroup[] =
    maxSerializedCharsPerGroup !== undefined
      ? groupKeys.flatMap((key) => {
          const value = fieldAt(shape, key);
          const candidate = groupCandidate(value) as z.ZodObject;
          const pack = (partCandidate: z.ZodObject): readonly ExtractionGroup[] =>
            partitionGroupTwoCaps(
              key,
              value,
              partCandidate,
              maxNullableUnionsPerGroup,
              maxSerializedCharsPerGroup,
            );
          const partition = partitions?.[key];
          return partition === undefined
            ? pack(candidate)
            : cutAlongParts(key, value, candidate, partition, pack);
        })
      : maxNullableUnionsPerGroup === undefined
        ? groupKeys.flatMap((key) => {
            const value = fieldAt(shape, key);
            const partition = partitions?.[key];
            if (partition === undefined) {
              return [{ key, schema: z.strictObject({ [key]: value }) }];
            }
            const candidate = groupCandidate(value) as z.ZodObject;
            const pack = (partCandidate: z.ZodObject): readonly ExtractionGroup[] => [
              {
                key,
                schema: z.strictObject({
                  [key]: value instanceof z.ZodArray ? z.array(partCandidate) : partCandidate,
                }),
              },
            ];
            return cutAlongParts(key, value, candidate, partition, pack);
          })
        : groupKeys.flatMap((key) => {
            const value = fieldAt(shape, key);
            const candidate = groupCandidate(value) as z.ZodObject;
            const partition = partitions?.[key];
            if (partition === undefined) {
              return partitionGroup(key, value, candidate, maxNullableUnionsPerGroup);
            }
            // The part's own subset rides as `value`, so the packer's
            // fits-in-one-piece arm rebuilds the part, not the whole group.
            const pack = (partCandidate: z.ZodObject): readonly ExtractionGroup[] =>
              partitionGroup(
                key,
                value instanceof z.ZodArray ? z.array(partCandidate) : partCandidate,
                partCandidate,
                maxNullableUnionsPerGroup,
              );
            return cutAlongParts(key, value, candidate, partition, pack);
          });

  if (looseKeys.length === 0) {
    return groupPieces;
  }

  // The loose remainder, appended after the groups (the order the plan's
  // key-grouping preserves into the schedule — design §5.2). One strict object
  // of the loose leaves keyed "" when no cap binds it — or, under EITHER cap,
  // that object's own flat packing. Here the asymmetry is the argument: when
  // the schema is ALL-flat the module declines to split at all under the
  // union cap alone and returns the input, claiming nothing (the pinned rule
  // of `split-schema-unions.test.ts:96`); in a MIXED split the module is
  // actively constructing pieces, so everything it emits must satisfy the
  // caps it was given — a 94-union loose piece behind a caller's cap of 16 is
  // a provider 400 of exactly the kind ADR 0013 exists to convert. The flat
  // packer walks a schema's top-level keys, so it is handed the rebuilt loose
  // object; its pieces are already unwrapped leaf subsets, so no relabelling
  // is needed.
  const looseShape: Record<string, z.ZodType> = {};
  for (const key of looseKeys) looseShape[key] = fieldAt(shape, key);
  const looseSchema = z.strictObject(looseShape);
  const loosePieces: ExtractionGroup[] =
    maxSerializedCharsPerGroup !== undefined
      ? partitionFlatTwoCaps(looseSchema, maxNullableUnionsPerGroup, maxSerializedCharsPerGroup)
      : maxNullableUnionsPerGroup !== undefined
        ? partitionFlatTwoCaps(looseSchema, maxNullableUnionsPerGroup, undefined)
        : [{ key: "", schema: looseSchema }];
  return [...groupPieces, ...loosePieces];
}
