/**
 * @file The example translation: the corpus's authored few-shot examples into
 * the extraction target's shape.
 *
 * A manifest authors an example as a flat map of dotted leaf paths to plain
 * values (`"frame.material": "steel"`). The model, though, imitates the
 * wire schema — the enveloped one — and core projects examples by top-level
 * group key, so a flat map would silently drop every example from a per-group
 * call. This module is the translation: the dotted paths become objects nested
 * by group key (arrays transparent, as the leaf walk is), each leaf wrapped in
 * the envelope the wire schema asks for.
 *
 * The authored form stays the authored form — the run fingerprint hashes the
 * manifest's bytes — so the translation happens here, after the corpus is
 * loaded.
 */
import { stripOptionalNullable } from "@azx/ribo-core";
import { z } from "zod";

import { EvalError } from "./error.js";

/**
 * The envelope every leaf of an example carries — the wire schema's own leaf
 * envelope, with the value the manifest declared and no citation.
 */
interface ExampleEnvelope {
  readonly value: unknown;
  readonly confidence: number;
  readonly sourceSpan: string | null;
}

/**
 * One translated example: the transcript verbatim, and the fields in the
 * target's shape.
 */
export interface TranslatedExample {
  readonly transcript: string;
  readonly fields: unknown;
}

/** The dotted path of a leaf under a prefix — the leaf walk's own spelling. */
const childPath = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

/** The envelope around a declared value. */
const envelopeOf = (value: unknown): ExampleEnvelope => ({
  value,
  confidence: 1,
  sourceSpan: null,
});

/**
 * Build one node of the translated example, or `undefined` when the node holds
 * no declared value.
 *
 * The walk follows the schema's own shape: an object contributes its declared
 * members, an array contributes its single element (the corpus format's
 * collection groups hold one instance of the group's leaves), and a leaf
 * contributes the envelope around the declared value.
 *
 * The path an array's element contributes under is the array's own path — the
 * leaf walk's convention, where an array is transparent — so the lookup key
 * matches the inventory's leaf paths exactly.
 */
const buildNode = (
  node: z.ZodType,
  path: string,
  declared: Readonly<Record<string, unknown>>,
): unknown => {
  const stripped = stripOptionalNullable(node);
  if (stripped instanceof z.ZodObject) {
    const members: Record<string, unknown> = {};
    for (const key of Object.keys(stripped.shape)) {
      const member = buildNode(stripped.shape[key] as z.ZodType, childPath(path, key), declared);
      if (member !== undefined) members[key] = member;
    }
    return Object.keys(members).length > 0 ? members : undefined;
  }
  if (stripped instanceof z.ZodArray) {
    const element = stripOptionalNullable(stripped.element as z.ZodType);
    const inner = buildNode(element, path, declared);
    return inner === undefined ? undefined : [inner];
  }
  const value = declared[path];
  return value === undefined ? undefined : envelopeOf(value);
};

/**
 * Translate one authored example into the target's shape.
 *
 * Every declared path must name a leaf of the corpus's schema: a path that
 * names no leaf is a corpus authoring mistake, refused here — before any model
 * call — with the manifest, the example and the path named.
 * @param schema - The corpus's schema, in plain values.
 * @param leafPaths - The schema's leaf paths, as the one field inventory reports them.
 * @param example - The authored example: its transcript and its flat map.
 * @param manifestName - The corpus manifest's name, for the refusal's message.
 * @returns The translated example.
 * @throws {@link EvalError} when a declared path names no leaf of the schema.
 * @category Eval
 */
export function translateExample(
  schema: z.ZodObject,
  leafPaths: ReadonlySet<string>,
  example: { readonly transcript: string; readonly fields: Readonly<Record<string, unknown>> },
  manifestName: string,
): TranslatedExample {
  for (const path of Object.keys(example.fields)) {
    if (leafPaths.has(path)) continue;
    throw new EvalError(
      `eval: the corpus manifest "${manifestName}" declares the example ` +
        `"${example.transcript.slice(0, 60)}" with the leaf path "${path}", which names no leaf of ` +
        "the corpus's schema — the valid leaf paths are: " +
        `${[...leafPaths].join(", ")} (fix: use one of those paths in the example)`,
    );
  }
  const fields = buildNode(schema, "", example.fields);
  return { transcript: example.transcript, fields: fields ?? {} };
}
