import { z } from "zod";

/**
 * @file The abstained value a failed phase item writes: walk a BUILT extraction
 * schema and produce the all-null shape that parses against that same schema.
 *
 * A phase running under `onItemFailure: "skip"` hands a failed item to its
 * `merge` with nothing to write — but the closing trust-boundary parse still
 * requires every leaf. The merge's answer is an abstention: the value the piece
 * WOULD have contributed, with every leaf at the floor (`value: null`,
 * `confidence: 0`, `sourceSpan: null` for an envelope leaf; `null` for a plain
 * one). Deriving it from the piece's own schema means the output is shaped by
 * the very schema the closing parse validates against, whatever granularity the
 * group declared — the built schema structurally encodes the granularity, so no
 * option is threaded and the walk cannot drift from `enveloped()`'s decision
 * table.
 *
 * The walk mirrors `enveloped()`'s: strip wrappers, then match the shape.
 * `isExtractedSchema` is reused rather than a second recognizer grown — it was
 * built for exactly the envelope-vs-row ambiguity, and the envelope case MUST
 * be recognized before the generic object case (an envelope IS an object;
 * recursing into it would null `confidence`, which is a non-nullable number,
 * producing a value that fails the very parse this helper exists to satisfy).
 */
import { stripOptionalNullable } from "./field-path.js";
import { isExtractedSchema } from "./provenance.js";

/**
 * The leaf kinds a plain `null` answers for — the same allowlist
 * `enveloped()` wraps, mirrored here so a shape it would have refused at
 * construction is refused here too rather than silently nulled.
 */
const isSupportedLeaf = (field: z.ZodType): boolean =>
  field instanceof z.ZodEnum ||
  field instanceof z.ZodLiteral ||
  field instanceof z.ZodString ||
  field instanceof z.ZodNumber ||
  field instanceof z.ZodBoolean;

/**
 * The abstained value for one node of a built extraction schema, at `path` —
 * a schema-time diagnostic, named in the throw exactly as `enveloped()` names
 * its own.
 */
const abstainedAt = (field: z.ZodType, path: string): unknown => {
  const stripped = stripOptionalNullable(field);

  // Before the object case: an envelope IS a strict object, and recursing into
  // it would emit `confidence: null` — a non-nullable number's parse failure.
  // The literal is `nullEnvelope()`'s exactly; it is not imported because
  // `nullEnvelope` lives in the phases layer and importing it here would
  // invert that layering (a test pins the equality instead).
  if (isExtractedSchema(stripped)) {
    return { value: null, confidence: 0, sourceSpan: null };
  }

  if (stripped instanceof z.ZodObject) {
    // THE CAST: a bare ZodObject's `.shape` indexes loosely; the keys came from
    // the shape itself, so every value is a ZodType by construction — narrowed
    // once here, the same one-narrowing `enveloped.ts`'s `fieldAt` does.
    const shape = stripped.shape as Record<string, z.ZodType>;
    const abstained: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      abstained[key] = abstainedAt(shape[key]!, childPath);
    }
    return abstained;
  }

  // An array abstains to the empty array: one `items` schema describes every
  // element, so an empty array is the abstention for the whole collection and
  // parses against `z.array(element)` with no minimum.
  if (stripped instanceof z.ZodArray) return [];

  if (isSupportedLeaf(stripped)) return null;

  throw new Error(
    `abstainedValue(): unsupported shape at "${path === "" ? "<root>" : path}" ` +
      `(${stripped.constructor.name}). ` +
      "Only enum, literal, string, number, boolean, nested objects and arrays can be abstained — " +
      "records and unions have no null shape the closing parse would accept.",
  );
};

/**
 * The abstained value for a built extraction schema (or a piece of one — piece
 * schemas are built-schema derivatives, so every call site holds one): every
 * leaf at the abstention floor, every array empty, every object closed.
 *
 * The result is guaranteed to parse against the schema it was derived from —
 * that guarantee is the helper's whole point and what its tests pin.
 */
export const abstainedValue = (schema: z.ZodType): unknown => abstainedAt(schema, "");
