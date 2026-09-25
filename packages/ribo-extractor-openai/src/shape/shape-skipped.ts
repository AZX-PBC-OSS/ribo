/**
 * @file Reversal for a skip report: the inner extractor names skipped items in
 * the EXTRACTION shape's keys, and a caller reviewing the derived patch needs
 * them in the patch's.
 *
 * Only `nest` moves a leaf across a top-level key (`shape-operation.ts`), so a
 * group whose mapped leaves all land under its own key is the same group in
 * both spaces and keeps its coordinates; only a `leaf` a regroup moved needs
 * re-pathing. A nest group exists only on the extraction side: its item
 * becomes one per patch key the group feeds, without the instance and part
 * coordinates, which describe a group the patch does not have. Wherever the
 * mapping cannot narrow — a `leaf` naming no mapped leaf, a nest piece whose
 * leaves the report does not list — the report widens rather than naming a
 * path the patch lacks. Over-reporting is the direction a review screen can
 * afford.
 */

import type { SkippedItem } from "@azx/ribo-core";

import type { ShapeMapping } from "./shape-mapping.js";

/** The patch path of the extraction leaf at `path`, when the mapping has one. */
const sourceOf = (mapping: ShapeMapping, path: string): string | undefined =>
  Object.hasOwn(mapping.leaves, path) ? mapping.leaves[path]!.source : undefined;

const topOf = (path: string): string => path.split(".")[0]!;

/** `item` re-keyed, with its leaf replaced (or dropped) and its coordinates kept. */
const rekeyed = (item: SkippedItem, key: string, leaf: string | undefined): SkippedItem => {
  const { phaseId, leaf: _leaf, key: _key, ...coordinates } = item;
  return { phaseId, key, ...(leaf === undefined ? {} : { leaf }), ...coordinates };
};

const reverseOne = (item: SkippedItem, mapping: ShapeMapping): SkippedItem[] => {
  if (item.key === "") return [item];
  const sources = Object.entries(mapping.leaves)
    .filter(([path]) => path === item.key || path.startsWith(`${item.key}.`))
    .map(([, leaf]) => leaf.source);
  const patchKeys = [...new Set(sources.map(topOf))];
  const leafSource =
    item.leaf === undefined ? undefined : sourceOf(mapping, `${item.key}.${item.leaf}`);

  const isNest = patchKeys.length > 0 && (patchKeys.length > 1 || patchKeys[0] !== item.key);
  if (!isNest) {
    const leaf = leafSource?.slice(item.key.length + 1);
    return [rekeyed(item, item.key, leaf)];
  }
  const keys = leafSource === undefined ? patchKeys : [topOf(leafSource)];
  return keys.map((key) => ({ phaseId: item.phaseId, key }));
};

/**
 * The inner extractor's skip report in the derived patch's keys — see the file
 * header. Items that reverse to the same patch-space item are named once.
 */
export function reverseSkippedItems(
  items: readonly SkippedItem[],
  mapping: ShapeMapping,
): SkippedItem[] {
  const seen = new Set<string>();
  const reversed: SkippedItem[] = [];
  for (const item of items) {
    for (const candidate of reverseOne(item, mapping)) {
      const identity = JSON.stringify(candidate);
      if (seen.has(identity)) continue;
      seen.add(identity);
      reversed.push(candidate);
    }
  }
  return reversed;
}
