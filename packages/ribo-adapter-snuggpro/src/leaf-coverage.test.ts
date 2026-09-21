import { stripOptionalNullable } from "@azx/ribo-core";
import { expect, test } from "vitest";
import { z } from "zod";
import { SNUGG_ENDPOINTS } from "./endpoints.generated.js";
import { snuggValuesSchema } from "./schema.js";

/**
 * Every leaf the schema captures must have a write target. The absence of this
 * test once let a real defect sit unnoticed: most of the `job` group's leaves
 * had no write target at all, found only by reading the live vendor spec. A
 * leaf added to `snuggValuesSchema` without a matching accepted parameter in
 * `SNUGG_ENDPOINTS` is data the pipeline captures, reviews and then silently
 * drops on the wire — the worst kind of loss, because review showed it to a
 * human as accepted.
 */

/** Narrowing helper — a bare zod shape indexes to `any` (the `fieldAt` precedent). */
const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType => shape[key] as z.ZodType;

/** Collect the leaf names inside one group's schema, recursing into arrays and nested objects. */
function leafNames(schema: z.ZodType): string[] {
  const stripped = stripOptionalNullable(schema);
  if (stripped instanceof z.ZodArray) {
    return leafNames(stripped.element as z.ZodType);
  }
  if (stripped instanceof z.ZodObject) {
    const names: string[] = [];
    for (const key of Object.keys(stripped.shape)) {
      const childNames = leafNames(fieldAt(stripped.shape, key));
      if (childNames.length === 0) {
        names.push(key);
      } else {
        for (const leaf of childNames) {
          names.push(`${key}.${leaf}`);
        }
      }
    }
    return names;
  }
  return [];
}

/** Map each top-level group of `snuggValuesSchema` to the leaf names declared inside it. */
function groupLeafNames(schema: z.ZodType): Record<string, string[]> {
  const stripped = stripOptionalNullable(schema);
  if (!(stripped instanceof z.ZodObject)) return {};
  const result: Record<string, string[]> = {};
  for (const key of Object.keys(stripped.shape)) {
    result[key] = leafNames(fieldAt(stripped.shape, key));
  }
  return result;
}

test("every leaf of every group is accepted by that group's write operations", () => {
  const groupLeaves = groupLeafNames(snuggValuesSchema);
  expect(Object.keys(groupLeaves)).not.toHaveLength(0);
  for (const [group, leaves] of Object.entries(groupLeaves)) {
    const entry = SNUGG_ENDPOINTS[group];
    if (!entry) throw new Error(`no SNUGG_ENDPOINTS entry for group "${group}"`);
    const accepted = new Set(
      [entry.create, entry.update, entry.upsert].flatMap((op) =>
        op ? Object.keys(op.params) : [],
      ),
    );
    for (const leaf of leaves) {
      expect(
        accepted.has(leaf),
        `"${group}.${leaf}" is captured but no write operation accepts it`,
      ).toBe(true);
    }
  }
});
