/**
 * @file The codebase's one generic RUNTIME walk over `Enveloped<V>` data, as a
 * structure-preserving map over leaves — moved here from `gapFillExtractor`,
 * where it was module-private, so a core combinator that judges extraction
 * results can reach it (`sp2-judging-combinators-design.md` §4.6) and a host
 * writing their own combinator does not have to rewrite it. The walker in
 * `enveloped()` is schema-time and serves a different purpose.
 */

import type { Extracted } from "./provenance.js";

/**
 * Distinguish a leaf envelope from a nested enveloped group. The envelope's own
 * key names ARE fixed (provenance.ts's `{ value, confidence, sourceSpan }`), so
 * testing them hard-codes nothing adapter-specific; the load-bearing check is
 * `confidence` being a number — a group's members are themselves envelopes or
 * groups, never bare numbers.
 */
export const isExtractedLeaf = (node: unknown): node is Extracted<unknown> => {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
  const record = node as Record<string, unknown>;
  return "value" in record && "sourceSpan" in record && typeof record.confidence === "number";
};

/** A path through `Enveloped<V>` data: object keys and array indices. */
export type LeafPath = readonly (string | number)[];

/**
 * The one generic runtime walk over enveloped data, as a structure-preserving
 * map over leaves: `fn` sees every leaf with its path, and a subtree keeps its
 * identity when nothing under it changed. A pure visitor (returning every leaf
 * unchanged rebuilds nothing — `findAbstainedLeaves`'s use); a merge relies on
 * the identity preservation so untouched leaves stay reference-equal to the
 * base (`gapFillExtractor`'s). That identity property is load-bearing: a
 * rewrite that returns fresh objects everywhere would pass a deep-equality test
 * and still break the merge's contract.
 */
export const mapExtractedLeaves = (
  node: unknown,
  path: LeafPath,
  fn: (leaf: Extracted<unknown>, path: LeafPath) => Extracted<unknown>,
): unknown => {
  if (isExtractedLeaf(node)) return fn(node, path);
  if (Array.isArray(node)) {
    let changed = false;
    const mapped = node.map((element, index) => {
      const next = mapExtractedLeaves(element, [...path, index], fn);
      if (next !== element) changed = true;
      return next;
    });
    return changed ? mapped : node;
  }
  // Enveloped data has no primitives outside leaves, but the walker is generic;
  // pass anything else through rather than Object.entries-ing a string.
  if (node === null || typeof node !== "object") return node;
  let changed = false;
  const mapped: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    const next = mapExtractedLeaves(child, [...path, key], fn);
    if (next !== child) changed = true;
    mapped[key] = next;
  }
  return changed ? mapped : node;
};
