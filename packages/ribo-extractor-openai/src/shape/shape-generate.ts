/**
 * @file The value generator for the reverse-direction round-trip property: a
 * deterministic walker over a zod schema that produces a value the schema
 * admits — for the EXTRACTION schema, so the property can generate in the
 * extraction space, reverse, and assert the derived patch parses.
 *
 * No generator exists in this repo — no fast-check, no zod-arbitrary — and the
 * property does not need one. What the property asks is not "do random values
 * survive" but "does EVERY value the extraction space admits reverse", and the
 * interesting axis is the schema's SHAPE (envelopes, groups, collections,
 * retyped leaves), which the walk enumerates structurally. So this walker is
 * exhaustive over kinds and deterministic over values, and the retype's
 * canonical-encoding edges are covered by running it once per member of a
 * small number pool.
 *
 * Determinism is also the point the other way: a failure reproduces. A random
 * generator's failing seed is a second artifact to keep; a deterministic
 * walker's failure is a path in the schema.
 */

import { z } from "zod";

import { childPath, isExtractedSchema, stripOptionalNullable } from "@azx/ribo-core";

/** `shape[key]` for a key that came from `Object.keys(shape)` — narrowed once. */
const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType => shape[key] as z.ZodType;

/** Options for {@link generateShapedValue}. */
export interface GenerateOptions {
  /**
   * The number emitted at every number leaf, one property run per pool member.
   * Defaults to `125` — the canonical-encoding example: `Number("12.5e1")` is
   * `125`, and its reverse is the string `"125"`.
   */
  readonly number?: number;
  /**
   * How many elements every array gets. Defaults to 2 — two elements exercise
   * element alignment — and `0` is the property's other run: a model may answer
   * an empty collection, and the reversal must still produce the key.
   */
  readonly arrayElements?: number;
}

/**
 * Generate a value the schema admits, walking its shape. Arrays produce two
 * elements so the property exercises element alignment, and the element index
 * varies the boolean leaves so the two elements are not the same value.
 */
export function generateShapedValue(
  schema: z.ZodType,
  options: GenerateOptions = {},
  path = "",
  index = 0,
): unknown {
  const stripped = stripOptionalNullable(schema);
  if (stripped instanceof z.ZodObject) {
    if (isExtractedSchema(stripped)) {
      // A leaf envelope: the value is the inner leaf's, the confidence is the
      // model's honest 1, and the span quotes — non-null, so the property
      // asserts the span actually travels rather than passing on a shared null.
      const value = stripOptionalNullable(fieldAt(stripped.shape, "value"));
      return {
        value: generateShapedValue(value, options, childPath(path, "value"), index),
        confidence: 1,
        sourceSpan: `quote of ${path}`,
      };
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(stripped.shape)) {
      out[key] = generateShapedValue(
        fieldAt(stripped.shape, key),
        options,
        childPath(path, key),
        index,
      );
    }
    return out;
  }
  if (stripped instanceof z.ZodArray) {
    const count = options.arrayElements ?? 2;
    return Array.from({ length: count }, (_, elementIndex) =>
      generateShapedValue(stripped.element as z.ZodType, options, path, elementIndex),
    );
  }
  if (stripped instanceof z.ZodString) return `value for ${path}`;
  if (stripped instanceof z.ZodNumber) return options.number ?? 125;
  if (stripped instanceof z.ZodBoolean) return index % 2 === 0;
  if (stripped instanceof z.ZodEnum) return stripped.options[0];
  if (stripped instanceof z.ZodLiteral) return [...stripped.values][0];
  throw new Error(
    `generateShapedValue(): unsupported shape at "${path === "" ? "<root>" : path}" ` +
      `(${stripped.constructor.name}) — the generator walks extraction schemas, which ` +
      "enveloped() has already narrowed to the supported kinds.",
  );
}
