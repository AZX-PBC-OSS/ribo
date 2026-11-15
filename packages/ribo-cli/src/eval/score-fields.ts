/**
 * @file Reading what a run produced, out of the run's own fields.
 *
 * The runner's results carry the extraction's `fields` — the nested,
 * enveloped shape every strategy produces. The scorer reads one leaf out of
 * that shape by its dotted path, with arrays transparent: a leaf under a
 * collection is recorded once, at its element-relative path, and the run's
 * value for it is the list of the collection's instances' values.
 *
 * The envelope is core's own recogniser (`isExtractedLeaf`), never a
 * hand-declared key set. A leaf the run left without a value — a missing
 * subtree, a missing envelope, a null value — is an abstention, and the
 * scorer sees no value at all.
 */
import { isExtractedLeaf } from "@azx/ribo-core";

import type { EvalJsonValue } from "./types.js";

/**
 * The values a run produced for one leaf.
 *
 * An ordinary leaf has none or one; a leaf under a collection has one per
 * instance, in array order.
 */
export interface ProducedLeaf {
  /** The produced values, in order. Empty when the run abstained. */
  readonly values: readonly EvalJsonValue[];
  /** True when the leaf lives under a collection. */
  readonly inArray: boolean;
}

/**
 * The nodes a path reaches in the run's fields.
 *
 * Arrays are transparent, the way the leaf walk spells them: the path names
 * the array's own path, and every instance contributes the rest of the path.
 * @param node - The node to walk from.
 * @param segments - The path's remaining segments.
 * @returns The nodes the path reaches.
 */
const nodesAt = (node: unknown, segments: readonly string[]): unknown[] => {
  if (segments.length === 0) return [node];
  if (Array.isArray(node)) {
    return node.flatMap((element) => nodesAt(element, segments));
  }
  if (node === null || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const [head, ...rest] = segments;
  if (head === undefined) return [];
  return nodesAt(record[head], rest);
};

/**
 * The value one node carries, when it carries one.
 *
 * An envelope's value is the answer; a plain value (a row-granularity leaf)
 * is the answer itself. A null value is an abstention, not an answer.
 * @param node - The node to read.
 * @returns The value, or undefined when the node carries none.
 */
const valueOf = (node: unknown): EvalJsonValue | undefined => {
  if (isExtractedLeaf(node)) {
    const value = node.value;
    if (value === null || value === undefined) return undefined;
    return value as EvalJsonValue;
  }
  if (typeof node === "string" || typeof node === "boolean") return node;
  if (typeof node === "number") return Number.isFinite(node) ? node : undefined;
  return undefined;
};

/**
 * Read what a run produced for one leaf.
 * @param fields - The run's fields, as the runner reported them.
 * @param leafPath - The leaf's dotted path.
 * @param inArray - Whether the leaf lives under a collection.
 * @returns The leaf's produced values.
 * @category Eval
 */
export function readProducedLeaf(
  fields: unknown,
  leafPath: string,
  inArray: boolean,
): ProducedLeaf {
  if (fields === undefined || fields === null) return { values: [], inArray };
  const nodes = nodesAt(fields, leafPath.split("."));
  const values: EvalJsonValue[] = [];
  for (const node of nodes) {
    const value = valueOf(node);
    if (value !== undefined) values.push(value);
  }
  return { values, inArray };
}
