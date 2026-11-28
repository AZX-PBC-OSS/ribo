/**
 * @file The one CLI-side walk that answers "which collection is this leaf
 * under?" over the corpus's zod schema.
 *
 * The leaf inventory's `inArray` flag says a leaf lives below one or more
 * collections but not WHICH one — and `inArray` alone never decides collection
 * membership. The proposer (and the review sheet after it) need the dotted
 * path of the leaf's NEAREST array ancestor: that is the collection whose
 * rows a proposal reports, and the path a proposal's collection entry must
 * name. A scalar leaf has no collection path at all.
 *
 * The traversal mirrors core's `walkLeafInventory` walk exactly — same
 * optional/nullable stripping, same array-of-objects transparency, same
 * refusal for an array whose element is not an object — so the two walks can
 * never disagree about what a leaf is or where it lives. Core's walk is not
 * changed: this is the CLI-side companion that carries the array path the
 * inventory does not.
 */
import { z } from "zod";

import { childPath, stripOptionalNullable } from "@azx/ribo-core";

/**
 * One leaf's collection membership, as the walk reports it.
 * @category Eval
 */
export interface CollectionPathEntry {
  /** The leaf's dotted path, spelled exactly as the leaf inventory spells it. */
  readonly path: string;
  /**
   * The dotted path of the leaf's nearest array ancestor — the collection
   * whose instances the leaf is read per. Absent for a scalar leaf.
   */
  readonly collectionPath?: string;
}

function walk(
  field: z.ZodType,
  path: string,
  collectionPath: string | undefined,
  out: CollectionPathEntry[],
): void {
  const stripped = stripOptionalNullable(field);
  if (stripped instanceof z.ZodObject) {
    for (const key of Object.keys(stripped.shape)) {
      walk(stripped.shape[key] as z.ZodType, childPath(path, key), collectionPath, out);
    }
    return;
  }
  if (stripped instanceof z.ZodArray) {
    const element = stripOptionalNullable(stripped.element as z.ZodType);
    if (!(element instanceof z.ZodObject)) {
      throw new Error(
        `walkCollectionPaths(): the array at "${path || "<root>"}" has a ` +
          `${element.constructor.name} element — model the element as an object.`,
      );
    }
    for (const key of Object.keys(element.shape)) {
      walk(element.shape[key] as z.ZodType, childPath(path, key), path, out);
    }
    return;
  }
  out.push({ path, ...(collectionPath === undefined ? {} : { collectionPath }) });
}

/**
 * Walk a zod object schema and return, for every leaf, the path of its
 * nearest array ancestor — absent for a scalar leaf. For a leaf under nested
 * arrays, the nearest (innermost) array ancestor is the answer, because that
 * is the collection whose rows carry the leaf, and the path the scorer's
 * array-transparent read flattens along.
 * @param schema - The schema to walk, as the corpus loader converted it.
 * @returns One entry per leaf, in walk order.
 * @category Eval
 */
export function walkCollectionPaths(schema: z.ZodObject): readonly CollectionPathEntry[] {
  const out: CollectionPathEntry[] = [];
  walk(schema, "", undefined, out);
  return out;
}
