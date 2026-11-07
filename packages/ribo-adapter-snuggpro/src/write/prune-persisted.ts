import { stripOptionalNullable } from "@azx/ribo-core";
import { z } from "zod";

import { snuggValuesSchema } from "../schema.js";

/**
 * @file Prune a persisted review outcome down to the keys `snuggValuesSchema` still
 * declares.
 *
 * A field-set change strands sessions that are already stored: the write step parses
 * `reviewed` with the adapter's strict schema, so a persisted leaf the schema no
 * longer declares fails the parse, throws `TerminalError`, and the relay marks the
 * session `dead` on the first attempt. Pruning the persisted `reviewOutcome.fields`
 * once, before a write is attempted, un-strands them — the removed leaves had no
 * write target anyway.
 *
 * The KEEP set is walked off `snuggValuesSchema` on every call, never hardcoded: a
 * list of removed names cannot be checked against anything and goes stale the next
 * time the field set moves, while a schema-derived keep-set is correct by
 * construction. That also makes this a pure function of its input — no storage, no
 * network, no mutation — so a host can run it over its own persisted outcomes. The
 * storage package cannot do this work: which leaves a group keeps is adapter
 * knowledge, and no leaf package may depend on a sibling.
 *
 * Values are never touched. A `null` is a real WRITTEN value ("write this field
 * empty"), so pruning is about keys, never about emptiness.
 */

/** A group's declared leaves: the raw shape of the object one instance parses through. */
type DeclaredShape = z.ZodObject["shape"];

/**
 * One instance's declared keys, derived from a group's schema — unwrapped of the
 * group's `.optional()`, and of the element schema's for a collection.
 *
 * `null` when the group is neither a singleton object nor an array of objects —
 * a shape this schema does not declare, so a persisted value for it is passed
 * through untouched rather than pruned by a guess.
 */
const instanceShape = (group: z.ZodType): DeclaredShape | null => {
  const declared = stripOptionalNullable(group);
  // zod 4's `ZodArray.element` is typed as the core `$ZodType`; every schema in this
  // codebase is built through the classic API, so the cast is a narrowing, like
  // `enveloped.ts`'s.
  const instance =
    declared instanceof z.ZodArray
      ? stripOptionalNullable(declared.element as z.ZodType)
      : declared;
  return instance instanceof z.ZodObject ? instance.shape : null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Copy only the keys `shape` still declares. Values move by reference, never
 * validated or transformed — the parse at the write step stays the value's gate.
 */
const pruneKeys = (
  instance: Record<string, unknown>,
  shape: DeclaredShape,
): Record<string, unknown> => {
  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(instance)) {
    if (Object.hasOwn(shape, key)) pruned[key] = value;
  }
  return pruned;
};

/**
 * Prune one group's persisted value: an array's elements one by one (length and
 * order preserved), a singleton's keys directly. A value that is neither passes
 * through untouched — the write step's parse is what rejects malformed shapes.
 */
const pruneGroup = (groupValue: unknown, shape: DeclaredShape): unknown => {
  if (Array.isArray(groupValue)) {
    // `Array.isArray` narrows `unknown` to `any[]`; the element's honest type is
    // `unknown`, so the callback parameter says so instead of inheriting the `any`.
    return groupValue.map((instance: unknown) =>
      isPlainObject(instance) ? pruneKeys(instance, shape) : instance,
    );
  }
  return isPlainObject(groupValue) ? pruneKeys(groupValue, shape) : groupValue;
};

/**
 * Prune a persisted review outcome's `fields` — what review produced and storage
 * kept — down to the keys {@link snuggValuesSchema} still declares, at both levels:
 * a top-level group key the schema no longer declares is dropped, and a leaf key a
 * surviving group's shape no longer declares is dropped from it (each element of a
 * collection group individually). Returns a new record; the input is not mutated,
 * and every surviving value is passed through untouched.
 * @category Tool Adapters
 */
export function prunePersistedValues(fields: Record<string, unknown>): Record<string, unknown> {
  const groups = snuggValuesSchema.shape as unknown as Record<string, z.ZodType>;
  const pruned: Record<string, unknown> = {};
  for (const [group, groupValue] of Object.entries(fields)) {
    const groupSchema = groups[group];
    if (!groupSchema) continue;
    const shape = instanceShape(groupSchema);
    pruned[group] = shape === null ? groupValue : pruneGroup(groupValue, shape);
  }
  return pruned;
}
