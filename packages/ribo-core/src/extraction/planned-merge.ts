/**
 * @file The planned-only, schema-bound same-key merge. Ordinary objects and arrays are branches;
 * envelopes, row citations, scalars and null are atomic values. ADR 0043 keeps this out of the
 * legacy shallow merge, whose overlapping-piece behavior remains unchanged.
 */

import { z } from "zod";

import { stripOptionalNullable } from "../provenance/field-path.js";
import { isExtractedSchema } from "../provenance/provenance.js";
import type { GroupPieceMerger } from "./grouped-extractor.js";

const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType | undefined =>
  shape[key] as z.ZodType | undefined;

const isObjectValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const duplicate = (path: string): never => {
  throw new Error(
    `plannedMerge: duplicate atomic value at "${path}"; reviewed plan pieces must own each ` +
      "leaf and row citation exactly once.",
  );
};

const childPath = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

function mergeArrays(
  element: z.ZodType,
  existing: readonly unknown[],
  incoming: readonly unknown[],
  path: string,
): unknown[] {
  const merged = new Array<unknown>(Math.max(existing.length, incoming.length));
  for (let index = 0; index < merged.length; index += 1) {
    const hasExisting = Object.hasOwn(existing, index);
    const hasIncoming = Object.hasOwn(incoming, index);
    if (hasExisting && hasIncoming) {
      merged[index] = mergeNode(element, existing[index], incoming[index], `${path}[${index}]`);
    } else if (hasExisting) {
      merged[index] = existing[index];
    } else if (hasIncoming) {
      merged[index] = incoming[index];
    }
  }
  return merged;
}

function mergeObjects(
  schema: z.ZodObject,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const keys = [
    ...Object.keys(existing),
    ...Object.keys(incoming).filter((key) => !Object.hasOwn(existing, key)),
  ];
  for (const key of keys) {
    const hasExisting = Object.hasOwn(existing, key);
    const hasIncoming = Object.hasOwn(incoming, key);
    const valuePath = childPath(path, key);
    if (hasExisting && hasIncoming) {
      const field = fieldAt(schema.shape, key);
      merged[key] =
        field === undefined
          ? duplicate(valuePath)
          : mergeNode(field, existing[key], incoming[key], valuePath);
    } else if (hasExisting) {
      merged[key] = existing[key];
    } else {
      merged[key] = incoming[key];
    }
  }
  return merged;
}

/** Both values are present here; absence is settled by the caller through own-property checks. */
function mergeNode(schema: z.ZodType, existing: unknown, incoming: unknown, path: string): unknown {
  const stripped = stripOptionalNullable(schema);
  if (isExtractedSchema(stripped)) return duplicate(path);
  if (stripped instanceof z.ZodArray && Array.isArray(existing) && Array.isArray(incoming)) {
    return mergeArrays(stripped.element as z.ZodType, existing, incoming, path);
  }
  if (stripped instanceof z.ZodObject && isObjectValue(existing) && isObjectValue(incoming)) {
    return mergeObjects(stripped, existing, incoming, path);
  }
  return duplicate(path);
}

/**
 * Bind the planned same-key merger to the full enveloped schema. The callback is internal to
 * {@link plannedExtractor}; the grouped engine still owns the closing full-schema parse.
 */
export function createPlannedMerge(schema: z.ZodType): GroupPieceMerger {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error("createPlannedMerge: the full extraction schema must be a ZodObject.");
  }
  return (existing, incoming, key) => {
    const field = fieldAt(schema.shape, key);
    if (field === undefined) {
      throw new Error(`createPlannedMerge: the extraction schema has no top-level key "${key}".`);
    }
    return mergeNode(field, existing, incoming, key);
  };
}
