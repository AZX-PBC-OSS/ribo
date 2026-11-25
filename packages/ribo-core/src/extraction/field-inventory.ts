import { z } from "zod";

import { ROW_SOURCE_SPAN_KEY } from "../provenance/enveloped.js";
import { stripOptionalNullable } from "../provenance/field-path.js";
import { isExtractedSchema } from "../provenance/provenance.js";
import { walkLeafInventory } from "./shape/leaf-inventory.js";
import type { LeafInventoryEntry } from "./shape/leaf-inventory.js";

/** `shape[key]`, narrowed once for zod's indexed shape type. */
const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType => shape[key] as z.ZodType;

/** Unwrap one field, dropping only citations attached to row units. */
const unwrapField = (field: z.ZodType, isRow = false): z.ZodType => {
  const stripped = stripOptionalNullable(field);
  if (!(stripped instanceof z.ZodObject)) {
    return stripped instanceof z.ZodArray
      ? z.array(unwrapField(stripped.element as z.ZodType, true))
      : stripped;
  }
  if (isExtractedSchema(stripped)) return fieldAt(stripped.shape, "value");

  const unwrapped: Record<string, z.ZodType> = {};
  for (const key of Object.keys(stripped.shape)) {
    const member = fieldAt(stripped.shape, key);
    // A real leaf may also be named sourceSpan; envelope recognition distinguishes it.
    if (isRow && key === ROW_SOURCE_SPAN_KEY && !isExtractedSchema(stripOptionalNullable(member))) {
      continue;
    }
    unwrapped[key] = unwrapField(member);
  }
  return z.object(unwrapped);
};

/**
 * Unwrap recognised provenance envelopes to their declared value schemas and omit row-only
 * citations. Collection structure and leaf descriptions remain intact.
 *
 * @category Extraction
 */
export function unwrapFieldEnvelopes(schema: z.ZodObject): z.ZodObject {
  const stripped = stripOptionalNullable(schema);
  if (isExtractedSchema(stripped)) {
    return z.object({ value: unwrapField(stripped) });
  }

  const groups: Record<string, z.ZodType> = {};
  for (const key of Object.keys(schema.shape)) {
    groups[key] = unwrapField(fieldAt(schema.shape, key), true);
  }
  return z.object(groups);
}

/**
 * Return one element-relative dotted-path entry per real schema field. Provenance envelope members
 * and row citations are excluded; nested collections contribute their element leaves once.
 * Unsupported shapes retain {@link walkLeafInventory}'s path-named refusals.
 *
 * @category Extraction
 */
export function walkFieldInventory(schema: z.ZodObject): LeafInventoryEntry[] {
  return walkLeafInventory(unwrapFieldEnvelopes(schema));
}
