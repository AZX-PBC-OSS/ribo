import { isExtractedSchema, stripOptionalNullable, walkLeafInventory } from "@azx/ribo-core";
import type { LeafInventoryEntry } from "@azx/ribo-core";
import { z } from "zod";

/**
 * @file The report's field inventory: one entry per SCHEMA FIELD, counted by
 * core's own `walkLeafInventory`. An enveloped extraction schema wraps every
 * field in a `{ value, confidence, sourceSpan }` envelope, and that walk —
 * built for plain patch schemas — descends every object to its scalar leaves,
 * so walking the enveloped form directly counts each envelope's three members
 * as three leaves and inflates everything built from the inventory
 * (leafCount, guidance coverage, the reformat lint) exactly 3x. Core's own
 * notion of a field on an enveloped schema is one envelope per field — the
 * identification `isExtractedSchema` makes and the group machinery counts —
 * so the walk is fed the schema with each envelope unwrapped to its `value`
 * member, which carries the field's leaf kind and description. The walk
 * itself is never reimplemented: this file only reshapes the input to it.
 *
 * Under `"row"` or `"none"` granularity there are no envelopes and the unwrap
 * is the identity; the row unit's own `sourceSpan` string is counted as a
 * leaf, as the document that carries it states.
 */

/** `shape[key]`, narrowed once — the move core's own `fieldAt` makes. */
const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType => shape[key] as z.ZodType;

/** One field of the schema, with any envelope unwrapped to its `value` member. */
const unwrapField = (field: z.ZodType): z.ZodType => {
  const stripped = stripOptionalNullable(field);
  if (!(stripped instanceof z.ZodObject)) {
    return stripped instanceof z.ZodArray
      ? z.array(unwrapField(stripped.element as z.ZodType))
      : stripped;
  }
  // Core's envelope recognition, verbatim — never a re-declared key set.
  if (isExtractedSchema(stripped)) return fieldAt(stripped.shape, "value");
  const unwrapped: Record<string, z.ZodType> = {};
  for (const key of Object.keys(stripped.shape)) {
    unwrapped[key] = unwrapField(fieldAt(stripped.shape, key));
  }
  return z.object(unwrapped);
};

/**
 * Walk a zod object schema for its FIELD inventory: core's
 * `walkLeafInventory` over the schema with every provenance envelope unwrapped
 * to its `value` member, so one entry per field — the count core's group
 * machinery and the Snugg adapter's own tests pin. The walk's own refusals
 * (a scalar array, a union, a record) pass through verbatim.
 * @category Inspect
 */
export function walkFieldInventory(schema: z.ZodObject): LeafInventoryEntry[] {
  const stripped = stripOptionalNullable(schema);
  if (isExtractedSchema(stripped)) {
    // A root that IS one envelope: one field, walked under the member name the
    // document itself carries ("value") — the only name a root envelope has.
    return walkLeafInventory(z.object({ value: unwrapField(stripped) }));
  }
  const unwrapped = unwrapField(schema);
  if (!(unwrapped instanceof z.ZodObject)) {
    // Unreachable — the root is an object and not an envelope, so the unwrap
    // rebuilds an object. Guarded for the type, never silently reshaped.
    throw new Error("walkFieldInventory(): the unwrapped root is not an object schema");
  }
  return walkLeafInventory(unwrapped);
}
