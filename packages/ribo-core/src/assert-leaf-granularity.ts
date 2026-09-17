import { z } from "zod";

import { ROW_SOURCE_SPAN_KEY } from "./enveloped.js";
import { stripOptionalNullable } from "./field-path.js";
import { isExtractedSchema } from "./provenance.js";

/**
 * @file The construction-time guard both judging combinators build on
 * (`sp2-judging-combinators-design.md` §4.5): refuse a target whose groups are
 * not derived at `"leaf"` provenance granularity, before any call is made.
 *
 * `consensusExtractor` and `validateExtractor` both work by walking per-leaf
 * provenance envelopes — the walk is {@link isExtractedLeaf}'s, in
 * `extracted-leaves.ts`. A `"row"` group has no such envelopes — it is plain
 * nullable values plus one row-level span — and a `"none"` group has none
 * either, and the walk passes both straight through. A combinator running
 * against such a target would compare nothing and count nothing while
 * returning a result that looks judged — silently blind exactly where
 * hallucination is worst, since row provenance exists because per-cell
 * citations were measured 37% fabricated. So a host with such a target learns
 * at construction, the same refusal `threePhaseExtractor` already makes for the
 * same reason. This module holds the refusal so both combinators (and any host
 * writing their own) share one implementation of it.
 */

/**
 * Is this zod type a group derived at `"leaf"` granularity — every leaf a
 * per-leaf provenance envelope?
 *
 * A recursive predicate, NOT an unwrap-then-check. A one-level "unwrap the
 * array, then check the object's properties" version rejects legitimate
 * `"leaf"` schemas in a way the Snugg Pro adapter would never reveal:
 * `enveloped()` derives `z.array(z.string())` to an array of ENVELOPES, so
 * after unwrapping the array the check is holding an envelope, whose own
 * properties are not envelopes — and since that envelope carries a
 * `sourceSpan` key, the row/none discrimination would misreport the group as
 * `"row"`. An array nested inside a group and a top-level bare leaf fail the
 * same way. Nesting at `"leaf"` granularity genuinely exists — `enveloped()`
 * recurses a nested `z.ZodObject` at the group's granularity — so the check
 * recurses; it does not reject a group whose properties are themselves groups.
 *
 * The five cases, in the order they are checked:
 *
 *   - `isExtractedSchema` → leaf, short-circuit. This case MUST come first: an
 *     envelope is an object whose own properties (`value`, `confidence`,
 *     `sourceSpan`) are not themselves envelopes, so the object branch below
 *     would recurse into them and reject a legitimate leaf.
 *   - a `z.ZodArray` → recurse into its element.
 *   - an optional/nullable wrapper → recurse into its inner type.
 *   - a `z.ZodObject` → recurse into every property; leaf only if all of them
 *     are.
 *   - anything else (a bare nullable primitive) → not leaf granularity.
 */
const isLeafGranular = (schema: z.ZodType): boolean => {
  if (isExtractedSchema(schema)) return true;
  if (schema instanceof z.ZodArray) {
    // `ZodArray.element` is typed against zod's core API; every schema here is
    // built through the classic API — the same narrowing split-schema's
    // groupCandidate makes.
    return isLeafGranular(schema.element as z.ZodType);
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    // `.unwrap()`'s declared return type defaults to the core (not classic)
    // `$ZodType` once narrowed only by `instanceof`; every wrapper in this
    // codebase wraps a classic `z.ZodType` — the same cast
    // `stripOptionalNullable` makes.
    return isLeafGranular(schema.unwrap() as z.ZodType);
  }
  if (schema instanceof z.ZodObject) {
    // `ZodRawShape` values are core `$ZodType`; cast the shape, as per-group
    // does — every schema here is built through the classic API.
    const shape = schema.shape as Record<string, z.ZodType>;
    return Object.values(shape).every((property) => isLeafGranular(property));
  }
  return false;
};

/**
 * Refuse a group that is not leaf granularity, discriminating `"row"` from
 * `"none"` — the two failures have different fixes.
 *
 * The discrimination runs on the ROW UNIT only — the group object itself, or
 * the element of a collection group — never on a nested object the recursion
 * reached. A nested object inside a `"row"` group gets plain leaves and NO
 * `sourceSpan` key of its own, so discriminating at the recursion's failure
 * point would report that subtree as `"none"` when the group is `"row"`.
 * Granularity is a property of the group; the recursion above only answers
 * whether a leaf envelope was found.
 *
 * Arrays are unwrapped to the first non-array, not one level: `enveloped()`
 * makes each element of ANY array nested inside a row group its own row, so in
 * a doubly-nested collection the row unit carrying the span sits one array
 * deeper than the group's own.
 */
const refuseGroup = (groupKey: string, group: z.ZodType, combinator: string): never => {
  let rowUnit = stripOptionalNullable(group);
  while (rowUnit instanceof z.ZodArray) {
    rowUnit = stripOptionalNullable(rowUnit.element as z.ZodType);
  }
  const granularity =
    rowUnit instanceof z.ZodObject && Object.hasOwn(rowUnit.shape, ROW_SOURCE_SPAN_KEY)
      ? "row"
      : "none";
  throw new Error(
    `${combinator}: group "${groupKey}" has plain leaves, so it appears to have been derived ` +
      `at "${granularity}" provenance granularity. This combinator needs a per-leaf ` +
      "provenance envelope on every leaf — it judges a result by walking those envelopes, " +
      "so it would silently judge nothing in this group. " +
      `Derive "${groupKey}" at "leaf" granularity, or use a combinator that speaks ` +
      `${granularity} provenance.`,
  );
};

/**
 * Assert that `schema` — a target's `extractionSchema`, what `enveloped()`
 * built — is fully `"leaf"` granularity: every leaf a per-leaf provenance
 * envelope, so the judging combinators that walk those envelopes have
 * something to walk. Returns nothing on success; throws naming the combinator,
 * the offending group, which granularity that group appears to be, and what
 * the combinator needs, because the fix differs between the two granularities.
 *
 * A bare assertion function, deliberately: no combinator-facing API sits on
 * top of it. The top level of the schema is a group container — its
 * properties are the groups, keyed the way `ProvenanceMap` keys them — and
 * granularity is a property of a group, so the walk below only finds WHICH
 * group offends; the recursion answers only whether a leaf envelope was
 * found.
 */
export const assertLeafGranularity = (schema: z.ZodType, options: { combinator: string }): void => {
  const { combinator } = options;
  const stripped = stripOptionalNullable(schema);
  // A schema that is one leaf envelope — no group container at all — is leaf
  // granularity outright.
  if (isExtractedSchema(stripped)) return;
  if (!(stripped instanceof z.ZodObject)) {
    // Not a group container and not an envelope: a collection of envelopes
    // perhaps, or a shape `enveloped()` would never produce. The recursive
    // predicate answers it; a refusal has no group key to name but the root.
    if (!isLeafGranular(stripped)) refuseGroup("<root>", stripped, combinator);
    return;
  }
  // `ZodRawShape` values are core `$ZodType`; cast the shape, as `fieldAt` does
  // in `enveloped.ts` — every schema here is built through the classic API.
  const shape = stripped.shape as Record<string, z.ZodType>;
  for (const [key, group] of Object.entries(shape)) {
    if (isLeafGranular(group)) continue;
    refuseGroup(key, group, combinator);
  }
};
