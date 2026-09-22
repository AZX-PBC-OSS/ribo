import { z } from "zod";

import { isExtractedSchema, stripOptionalNullable } from "@azx/ribo-core";
import type { LeafPath } from "@azx/ribo-core";

/**
 * The enum members a leaf of an extraction schema may hold, in declaration order — or `null`
 * when the leaf is not an enum or `path` does not resolve through `schema`.
 *
 * Corroboration asks one calibrated question per committed leaf and must state the leaf's
 * members in it: without them a verifier reads the schema's own encoding of what was said —
 * a spoken duration recorded as the band containing it — as a fabrication (ADR 0017). The walk itself mirrors `ribo-extractor-openai`'s
 * `leafSchemaAtPath` but is deliberately a local copy, not an import: that package is a leaf
 * sibling, and a dependency between the two is a direction the architecture rules out. (Moving
 * the walk into core is a separate, scheduled refactor — do not do it here.)
 *
 * Two behaviours are contractual, and both differ from `leafSchemaAtPath` for the same reason:
 * THAT function resolves paths that came from data already parsed against the schema, so an
 * unresolvable path is a bug worth throwing over; THIS one answers exploratory questions about
 * any path a caller has, so `null` is the honest answer, not an error.
 *
 *   - **A numeric segment steps into the array's ELEMENT schema, never an index.** Every
 *     element of an array shares one schema, so a number addresses a position in DATA, not in
 *     the schema — `["windows", 0, "glazing"]` resolves the same way as any other index would.
 *     Trying to index the schema instead returns null for every leaf inside a collection group.
 *   - **The enum is read off the envelope's `value` member** (after stripping its nullability),
 *     recognised by core's own `isExtractedSchema` so this walk cannot drift from what an
 *     extraction leaf actually is.
 */
export const enumMembersAt = (schema: z.ZodType, path: LeafPath): readonly string[] | null => {
  let current = schema;
  for (const segment of path) {
    const next =
      typeof segment === "number"
        ? current instanceof z.ZodArray
          ? // `ZodArray.element` is typed against zod's core API; every schema here is built
            // through the classic API — the same narrowing leafSchemaAtPath makes.
            (current.element as z.ZodType)
          : undefined
        : current instanceof z.ZodObject
          ? (current.shape as Record<string, z.ZodType | undefined>)[segment]
          : undefined;
    if (next === undefined) return null;
    current = next;
  }
  if (!(current instanceof z.ZodObject) || !isExtractedSchema(current)) return null;
  const value = (current.shape as Record<string, z.ZodType | undefined>).value;
  if (value === undefined) return null;
  const inner = stripOptionalNullable(value);
  return inner instanceof z.ZodEnum ? inner.options.map((member) => String(member)) : null;
};
