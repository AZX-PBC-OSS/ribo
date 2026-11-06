/**
 * @file Project an {@link ExtractionTarget} onto one top-level group key.
 *
 * This is the pure, model-free half of per-group extraction beside
 * `splitExtractionSchema`: given a target and a key, return a new target
 * whose `extractionSchema` is the one-key strict object R3 already sends
 * (`{ [key]: groupSchema }`), whose examples are projected to that key, and
 * whose instructions can be replaced by per-group text.
 *
 * Keeping this as a standalone pure function lets a caller hand a projected
 * target to any strategy — a `singleShotExtractor`, a `gapFillExtractor`, a
 * `schemaRetryExtractor` — rather than only to the internal per-group loop.
 */

import { z } from "zod";

import type { Enveloped, NoProvenance } from "../provenance/enveloped.js";
import type { ExtractionTarget } from "./extractor.js";
import type { ToolAdapterExample } from "../write/adapter.js";

import { narrowToLeaves, projectExample, projectSingletonExample } from "./extraction-common.js";

/**
 * Narrow a group value (a group object or a `z.array` of them) to a subset of
 * leaf keys, mirroring `splitExtractionSchema`'s partition step and
 * `narrowToLeaves`'s value step.
 *
 * The returned value keeps the same array/non-array shape as the input, but
 * the object shape inside it carries only `leafKeys`. Throws if a requested
 * leaf key is absent — a partitioned piece's schema must exactly match the
 * leaves its few-shot example is narrowed to.
 */
function narrowGroupValueToLeaves(value: z.ZodType, leafKeys: readonly string[]): z.ZodType {
  const candidate = value instanceof z.ZodArray ? (value.element as z.ZodType) : value;
  if (!(candidate instanceof z.ZodObject)) {
    throw new Error(
      `projectTarget: cannot narrow a non-object group value to leaves. ` +
        `Requested leaves: ${leafKeys.join(", ")}.`,
    );
  }

  const shape = candidate.shape as Record<string, z.ZodType>;
  const narrowedShape: Record<string, z.ZodType> = {};
  for (const leafKey of leafKeys) {
    if (!Object.hasOwn(shape, leafKey)) {
      throw new Error(
        `projectTarget: leaf "${leafKey}" is not a property of this group's schema. ` +
          `Known leaves: ${Object.keys(shape).join(", ")}.`,
      );
    }
    narrowedShape[leafKey] = shape[leafKey]!;
  }

  const narrowedCandidate = z.strictObject(narrowedShape);
  return value instanceof z.ZodArray ? z.array(narrowedCandidate) : narrowedCandidate;
}

/**
 * Options for {@link projectTarget}.
 * @category Extraction
 */
export interface ProjectTargetOptions {
  /**
   * Instructions to use in place of the target's own. When omitted, the
   * projected target keeps `target.instructions` — the non-grouped fallback
   * behaviour.
   */
  readonly instructions?: string;
  /**
   * When supplied, the projected schema and examples are narrowed to exactly
   * these leaves of the group, matching a partitioned piece from
   * `splitExtractionSchema`.
   */
  readonly leafKeys?: readonly string[];
  /**
   * When true and the group is a collection (`z.array`), the projected schema
   * and examples carry a single element rather than the array — the Tier 3
   * degraded shape.
   */
  readonly singleton?: boolean;
}

/**
 * Narrow an extraction target to one top-level group key.
 *
 * Returns a target whose `extractionSchema` is a strict object carrying exactly
 * `{ [key]: groupSchema }` (narrowed by `leafKeys` or singleton element when
 * requested), whose few-shot examples are projected to that key, and whose
 * instructions are either supplied or inherited.
 *
 * The target's schema must be a `z.ZodObject` with `key` as one of its
 * shape properties — that is the grouped schema shape `enveloped`
 * produces. A non-grouped schema should bypass projection entirely rather than
 * call this function.
 *
 * @typeParam V - the plain field values of the original target.
 * @typeParam P - the original target's per-group provenance granularity map.
 * @typeParam K - the top-level group key being projected.
 * @category Extraction
 */
export function projectTarget<
  V extends Record<string, unknown>,
  P = NoProvenance,
  K extends keyof V & string = keyof V & string,
>(
  target: ExtractionTarget<V, P>,
  key: K,
  options?: ProjectTargetOptions,
): ExtractionTarget<Pick<V, K>, P> {
  const instructions = options?.instructions ?? target.instructions;
  const { leafKeys, singleton } = options ?? {};

  const schema = target.extractionSchema;
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      `projectTarget: target "${target.name}" extractionSchema is not a ZodObject, ` +
        `so key "${key}" cannot be projected.`,
    );
  }

  const shape = schema.shape as Record<string, z.ZodType>;
  const groupValue = shape[key];
  if (groupValue === undefined) {
    throw new Error(
      `projectTarget: target "${target.name}" has no top-level key "${key}". ` +
        `Known keys: ${Object.keys(shape).join(", ")}.`,
    );
  }

  let narrowedValue: z.ZodType = groupValue;
  if (singleton && narrowedValue instanceof z.ZodArray) {
    narrowedValue = narrowedValue.element as z.ZodType;
  }
  if (leafKeys !== undefined) {
    narrowedValue = narrowGroupValueToLeaves(narrowedValue, leafKeys);
  }

  // A computed key gives zod `{ [x: string]: ZodType }`, so it cannot infer what we just built.
  // Asserting a construction we control, unlike narrowing an opaque schema — that uses `instanceof`.
  const projectedSchema = z.strictObject({ [key]: narrowedValue }) as unknown as z.ZodType<
    Enveloped<Pick<V, K>, P>
  >;

  const projectedExamples: ToolAdapterExample<Enveloped<Pick<V, K>, P>>[] = [];
  for (const example of target.examples ?? []) {
    const projected = singleton
      ? projectSingletonExample(example, key)
      : projectExample(example, key);
    if (projected === null) continue;

    const fields =
      leafKeys !== undefined
        ? { [key]: narrowToLeaves(projected.fields[key], leafKeys) }
        : projected.fields;

    projectedExamples.push({
      transcript: projected.transcript,
      fields: fields as Enveloped<Pick<V, K>, P>,
    });
  }

  return {
    name: target.name,
    extractionSchema: projectedSchema,
    instructions,
    examples: projectedExamples,
  };
}
