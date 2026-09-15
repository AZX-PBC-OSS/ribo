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
 * behaviour, and the fallback rather than an error.
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
 */

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment --
   This file walks Zod schema internals. Zod 4's classic API exposes `.shape`, `.element`
   and `.unwrap()` as `any`; each use is guarded by runtime `instanceof z.Zod*` checks. */

import { z } from "zod";

import { isExtractedSchema } from "@azx/ribo-core";

/**
 * One top-level group of an extraction schema, narrowed to exactly that group's key.
 *
 * `key` is the group's top-level property name (e.g. `"hvac"`), or `""` for the
 * non-grouped fallback where `schema` carries the whole extraction schema in a
 * single entry.
 *
 * `schema` is shaped like the final answer but carrying exactly this group's
 * top-level key — `z.strictObject({ [key]: groupSchema })` — so Task 2 constrains
 * each chat call with it and merges responses by shallow `Object.assign` rather
 * than re-keying: each parsed response has one top-level key, so assigning them
 * in sequence produces the whole without any re-keying step.
 */
export interface ExtractionGroup {
  /** The top-level key this group covers, or `""` for the non-grouped fallback. */
  readonly key: string;
  /**
   * A zod schema carrying exactly this group's top-level key (or the whole schema
   * for the fallback). Strict/closed so a response carrying another group's key is
   * rejected — the split narrows rather than relabels. When `part` is present,
   * this carries only that piece's subset of `key`'s leaves, not all of them.
   */
  readonly schema: z.ZodType;
  /**
   * This entry's 0-based position among the pieces sharing `key`, present only
   * when `key`'s leaves were partitioned across multiple calls (see the file
   * header's "Nullable-union partitioning"). Undefined for a group under the cap,
   * and always undefined unless a caller opted in via `maxNullableUnionsPerGroup`.
   */
  readonly part?: number;
  /** The total number of pieces sharing `key`, present exactly when `part` is. */
  readonly parts?: number;
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
    return 1 + nullableUnions(schema.unwrap() as z.ZodType);
  }
  if (schema instanceof z.ZodArray) {
    return nullableUnions(schema.element as z.ZodType);
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;
    return Object.keys(shape).reduce((total, key) => total + nullableUnions(shape[key]!), 0);
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
  const weights = propertyKeys.map((k) => nullableUnions(candidate.shape[k]));
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  if (total <= maxUnions) {
    return [{ key, schema: z.strictObject({ [key]: value }) }];
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
    for (const leafKey of pieceKeys) pieceShape[leafKey] = candidate.shape[leafKey];
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
  // `ZodArray.element` is typed against zod's core API, but this function only
  // receives schemas built through the classic `z` API (`z.array`, `z.strictObject`,
  // etc.), so its runtime element is the same classic wrapper we already use.
  value instanceof z.ZodArray ? (value.element as z.ZodType) : value;

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

/**
 * Split an extraction schema into per-group schemas.
 *
 * Given a target's `extractionSchema`, produce the list of top-level groups and,
 * for each, a schema containing exactly that one key. The group list is derived
 * from the schema's own top-level properties, so this works for any adapter and
 * requires no adapter change.
 *
 * A schema that is not an object of groups — a flat enveloped schema whose
 * top-level properties are leaf envelopes, a top-level array of envelopes, a
 * non-object schema, or an empty object — yields a single entry whose `key` is
 * `""` and whose `schema` is the whole input. That is today's behaviour (one call
 * carrying everything) and the correct fallback, not an error.
 *
 * @param maxNullableUnionsPerGroup - When supplied, a group carrying more nullable
 *   unions than this is further partitioned into multiple entries sharing its
 *   `key` (see the file header's "Nullable-union partitioning" and
 *   `partitionGroup`). Omitted, the split keeps one-entry-per-group
 *   behaviour; both extractor callers pass a value (defaulting to
 *   {@link MAX_NULLABLE_UNIONS_PER_CALL}) so their per-call schemas stay under the
 *   provider limits regardless.
 */
export function splitExtractionSchema(
  schema: z.ZodType,
  maxNullableUnionsPerGroup?: number,
): readonly ExtractionGroup[] {
  if (!(schema instanceof z.ZodObject)) {
    return [{ key: "", schema }];
  }

  const shape = schema.shape;
  const keys = Object.keys(shape);
  if (keys.length === 0) {
    return [{ key: "", schema }];
  }

  // Every top-level property must be a group (a ZodObject, or a ZodArray of one,
  // that is not itself a leaf envelope) for the split to apply. A single envelope
  // at the top level — the shape a flat (non-grouped) enveloped schema has —
  // makes this false, and the whole schema is returned as one entry.
  const everyKeyIsGroup = keys.every((key) => {
    const candidate = groupCandidate(shape[key]);
    return candidate instanceof z.ZodObject && isGroupObject(candidate);
  });

  if (!everyKeyIsGroup) {
    return [{ key: "", schema }];
  }

  if (maxNullableUnionsPerGroup === undefined) {
    return keys.map((key) => ({
      key,
      schema: z.strictObject({ [key]: shape[key] }),
    }));
  }

  return keys.flatMap((key) =>
    partitionGroup(
      key,
      shape[key],
      groupCandidate(shape[key]) as z.ZodObject,
      maxNullableUnionsPerGroup,
    ),
  );
}
