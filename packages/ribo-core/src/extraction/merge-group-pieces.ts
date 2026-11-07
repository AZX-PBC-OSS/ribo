/**
 * @file The partitioned-group merge — recombine two group values that are pieces
 * of the SAME top-level key. Moved to core beside `groupedExtractor`, which owns
 * the merge, and so that the per-group and instance-fill strategies (which moved
 * into core from `ribo-extractor-openai` with it) share the one copy instead of
 * importing it through a sibling module.
 */

/**
 * Recombine two group values that are both pieces of the SAME key (a
 * partitioned group's leaves, split across two or more calls) into one.
 *
 * A singleton group's pieces are each a plain leaf-envelope object; they combine
 * by shallow merge, since every piece carries a disjoint subset of leaf keys.
 *
 * A collection group's pieces are each a full array of instances, one element
 * per instance, but each element carries only that piece's leaf subset (per the
 * file header: split within one instance's fields, never across instances or the
 * array wrapper). Recombining is therefore element-WISE by index: index `i` in
 * every piece is the same instance. This assumes every piece's call agreed on the
 * same instance count and order — both calls extract from the identical
 * transcript, so in practice they do — but if they disagree (a real model
 * inconsistency, not a code defect), the merge does not hide it: a short instance
 * is missing the other piece's keys, which the full extraction schema requires,
 * so the second trust-boundary parse (`parseWithSchema`) rejects the merge
 * with a `SchemaParseError` rather than silently emitting a partial instance.
 * @category Extraction
 */
export function mergeGroupPieces(existing: unknown, incoming: unknown): unknown {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    const length = Math.max(existing.length, incoming.length);
    const merged: unknown[] = [];
    for (let i = 0; i < length; i++) {
      merged.push({
        ...(existing[i] as Record<string, unknown> | undefined),
        ...(incoming[i] as Record<string, unknown> | undefined),
      });
    }
    return merged;
  }
  return {
    ...(existing as Record<string, unknown>),
    ...(incoming as Record<string, unknown>),
  };
}
