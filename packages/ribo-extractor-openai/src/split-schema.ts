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
   * rejected — the split narrows rather than relabels.
   */
  readonly schema: z.ZodType;
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
 */
export function splitExtractionSchema(schema: z.ZodType): readonly ExtractionGroup[] {
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

  return keys.map((key) => ({
    key,
    schema: z.strictObject({ [key]: shape[key] }),
  }));
}
