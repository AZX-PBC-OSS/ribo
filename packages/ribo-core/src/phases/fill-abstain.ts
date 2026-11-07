/**
 * @file The abstained-value writes both fill phases share. `fillAbsentKeys`
 * moved here verbatim from `fill-phase.ts` when the batched fill phase grew
 * the second caller; `abstainedElement` is the one-element answer a skipped
 * batched piece spreads across every instance of a collection.
 */

import { abstainedValue } from "../provenance/abstained-value.js";
import type { z } from "zod";

/**
 * The error arm's write — `mergeGroupPieces` restricted to keys the slot does
 * NOT have. A failed piece's abstained value must never blank what the slot
 * already holds: an envelope with a null value can carry a non-null
 * `sourceSpan` a later pass relies on, and a committed value must survive a
 * failed re-ask (`narrowToAbstained`'s whole point). Later-wins is safe for the
 * success arm only because partitioned pieces hold disjoint leaf sets; an
 * abstained piece covers the piece's FULL leaf set, so it needs under-fill.
 * @category Extraction
 */
export const fillAbsentKeys = (slot: unknown, abstained: unknown): unknown => {
  // An absent slot takes the abstained value whole — the common case, and what
  // lets a group whose every job failed still assemble a full array.
  if (slot === undefined || slot === null) return abstained;
  // A slot that is not a leaf map is not under-fillable; leave it for the
  // closing parse to judge rather than destroying whatever it holds.
  if (typeof slot !== "object" || Array.isArray(slot)) return slot;
  const abstainedRecord = abstained as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...(slot as Record<string, unknown>) };
  for (const [key, leafValue] of Object.entries(abstainedRecord)) {
    if (!Object.hasOwn(merged, key)) merged[key] = leafValue;
  }
  return merged;
};

/**
 * The abstained value of ONE element of a collection piece. The piece's
 * prepared schema is the one-key object `{ [key]: element }` (`prepareGroups`
 * unwraps the array), so the group's entry in its abstained value IS one
 * abstained element. Reading `abstainedValue` off a schema still holding the
 * `z.array(element)` would answer `[]` — the abstention for the whole
 * collection, not for one instance of it, and not what a skipped batched piece
 * writes into every slot.
 * @category Extraction
 */
export const abstainedElement = (pieceSchema: z.ZodType, key: string): unknown =>
  // THE CAST: the abstained value of a one-key object schema is a one-key
  // record; the closing parse judges the shape.
  (abstainedValue(pieceSchema) as Record<string, unknown>)[key];
