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
 * Leaf-count partitioning: a model-family investigation on the managed route found
 * that Anthropic-family models reject a response schema carrying more than 16
 * nullable unions, and `Enveloped<V>` emits two nullable-union members per leaf
 * (`value` and `sourceSpan`, both `X.nullable()`) — so the real per-call ceiling is
 * 8 enveloped leaves, independent of the byte-size and nesting-depth caps this
 * module already respects. That ceiling is invisible today because the managed
 * route is pinned to OpenAI-family models, which accept far more, but two of
 * Snugg Pro's seven groups (`hvac` at 12 leaves, `health` at 14) already exceed
 * it — a live break the moment that pin changes. `splitExtractionSchema` fixes
 * this at the source: when a caller passes `maxLeavesPerGroup`, a group whose leaf
 * count exceeds it is further partitioned into multiple entries that all carry the
 * SAME `key` (so the response still lands under the one top-level property
 * consumers expect) and are distinguished by `part`/`parts`. A collection group is
 * split within one instance's leaf set, never across instances or the array
 * wrapper — every partitioned entry for `hvac` still carries `z.array(...)`, just
 * with a narrower per-instance shape; the same instance index across two calls is
 * the same instance. The caller (`perGroupExtractor`, or `scopedInstanceExtractor`
 * at its own `(group, instance)` slots) makes one call per entry and recombines
 * the pieces sharing a key back into one document/instance array — see their
 * merge steps. This partitioning is opt-in at this layer (omit
 * `maxLeavesPerGroup` for one-entry-per-group behaviour); both extractor callers
 * default it to {@link MAX_ENVELOPED_LEAVES_PER_GROUP} and let their own callers
 * tune the number.
 */

import { z } from "zod";

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
   * header's "Leaf-count partitioning"). Undefined for a group under the cap, and
   * always undefined unless a caller opted in via `maxLeavesPerGroup`.
   */
  readonly part?: number;
  /** The total number of pieces sharing `key`, present exactly when `part` is. */
  readonly parts?: number;
}

/**
 * The default per-call leaf ceiling this module partitions against — 8 enveloped
 * leaves, derived from the Anthropic-family 16-nullable-union cap and
 * `Enveloped<V>`'s two nullable unions per leaf (`value`, `sourceSpan`). See the
 * file header. Exported so a caller and its tests share one number rather than
 * two that can drift.
 */
export const MAX_ENVELOPED_LEAVES_PER_GROUP = 8;

/**
 * Split one top-level group's leaves into pieces of at most `maxLeaves` each, as
 * evenly sized as possible. `Object.keys` order is preserved, so which leaves land
 * in which piece is a pure, deterministic function of the schema's own declaration
 * order — no adapter knowledge, no hard-coded field names, matching the rest of
 * this module's derive-don't-configure approach.
 *
 * `value` is the group's raw top-level property — either the group object
 * directly (a singleton group, e.g. `health`) or a `ZodArray` of it (a collection
 * group, e.g. `hvac`). `candidate` is `value` with any array wrapper already
 * peeled off (by the caller, via {@link groupCandidate}) — the object whose keys
 * are this group's enveloped leaves. The split narrows only `candidate`'s shape; a
 * collection group's array wrapper is rebuilt around each piece unchanged, so a
 * partition never spans instances or unwraps the array itself.
 */
function partitionGroup(
  key: string,
  value: z.ZodType,
  candidate: z.ZodObject,
  maxLeaves: number,
): ExtractionGroup[] {
  const leafKeys = Object.keys(candidate.shape);

  if (leafKeys.length <= maxLeaves) {
    return [{ key, schema: z.strictObject({ [key]: value }) }];
  }

  const isArray = value instanceof z.ZodArray;
  const partCount = Math.ceil(leafKeys.length / maxLeaves);
  // Evenly sized pieces, not "maxLeaves then a small remainder" — 12 leaves at a
  // cap of 8 becomes 6+6, not 8+4. Both fit under the cap, but even pieces make
  // per-call cost more predictable and avoid a piece sized suspiciously close to
  // the ceiling.
  const pieceSize = Math.ceil(leafKeys.length / partCount);

  const pieces: ExtractionGroup[] = [];
  for (let part = 0, start = 0; start < leafKeys.length; part++, start += pieceSize) {
    const pieceKeys = leafKeys.slice(start, start + pieceSize);
    const pieceShape: Record<string, z.ZodType> = {};
    for (const leafKey of pieceKeys) pieceShape[leafKey] = candidate.shape[leafKey];
    const pieceCandidate = z.strictObject(pieceShape);
    const pieceValue = isArray ? z.array(pieceCandidate) : pieceCandidate;
    pieces.push({
      key,
      schema: z.strictObject({ [key]: pieceValue }),
      part,
      parts: partCount,
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
 * Whether a `ZodObject` is a **group** (a nested object whose properties are
 * themselves objects — envelopes or sub-groups) rather than an **envelope** (a
 * `{ value, confidence, sourceSpan }` leaf wrapper).
 *
 * `enveloped()` either recurses into a nested `ZodObject` (producing a group whose
 * properties are all envelopes) or wraps a leaf in `extractedSchema` (producing an
 * envelope whose `confidence` is a bare `z.number()` and whose `sourceSpan` is a
 * `z.string().nullable()` — neither a `ZodObject`). So a group's properties are
 * all `ZodObject`s and an envelope's never are, which is what distinguishes them
 * without hard-coding the envelope's key names (fragile) or walking to the leaf
 * type inside `value` (over-specified). An empty object is neither — it has no
 * properties to be envelopes — so it returns `false` and falls back.
 */
const isGroupObject = (obj: z.ZodObject): boolean => {
  const shape = obj.shape;
  const keys = Object.keys(shape);
  if (keys.length === 0) return false;
  return keys.every((key) => shape[key] instanceof z.ZodObject);
};

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
 * @param maxLeavesPerGroup - When supplied, a group whose leaf count exceeds this
 *   is further partitioned into multiple entries sharing its `key` (see the file
 *   header's "Leaf-count partitioning" and {@link partitionGroup}). Omitted, the
 *   split keeps one-entry-per-group behaviour; both extractor callers pass a
 *   value (defaulting to {@link MAX_ENVELOPED_LEAVES_PER_GROUP}) so their
 *   per-call schemas stay under the provider limits regardless.
 */
export function splitExtractionSchema(
  schema: z.ZodType,
  maxLeavesPerGroup?: number,
): readonly ExtractionGroup[] {
  if (!(schema instanceof z.ZodObject)) {
    return [{ key: "", schema }];
  }

  const shape = schema.shape;
  const keys = Object.keys(shape);
  if (keys.length === 0) {
    return [{ key: "", schema }];
  }

  // Every top-level property must be a group (a ZodObject, or a ZodArray of a
  // ZodObject, whose values are all ZodObjects) for the split to apply. A single
  // envelope at the top level — the shape a flat (non-grouped) enveloped schema
  // has — makes this false, and the whole schema is returned as one entry.
  const everyKeyIsGroup = keys.every((key) => {
    const candidate = groupCandidate(shape[key]);
    return candidate instanceof z.ZodObject && isGroupObject(candidate);
  });

  if (!everyKeyIsGroup) {
    return [{ key: "", schema }];
  }

  if (maxLeavesPerGroup === undefined) {
    return keys.map((key) => ({
      key,
      schema: z.strictObject({ [key]: shape[key] }),
    }));
  }

  return keys.flatMap((key) =>
    partitionGroup(key, shape[key], groupCandidate(shape[key]) as z.ZodObject, maxLeavesPerGroup),
  );
}
