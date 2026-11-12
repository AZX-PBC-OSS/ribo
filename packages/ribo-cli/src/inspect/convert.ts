/**
 * The schema-input contract (design §5, ADR 0038): the entry takes a JSON
 * Schema **document** in OpenAPI 3.0 form and converts it with its own zod —
 * no zod object crosses the public entry in either direction. Every refusal
 * here is a could-not-run fault: `SchemaInspectError`, which the bin maps to
 * exit 2 with nothing on stdout.
 */
import { z } from "zod";

import { SchemaInspectError } from "./error.js";

/** The JSON Schema keywords that mark an object as a schema document. */
const SCHEMA_VOCABULARY = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contains",
  "dependencies",
  "deprecated",
  "description",
  "else",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "if",
  "items",
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "nullable",
  "oneOf",
  "pattern",
  "patternProperties",
  "prefixItems",
  "properties",
  "propertyNames",
  "readOnly",
  "required",
  "then",
  "title",
  "type",
  "uniqueItems",
  "unevaluatedItems",
  "unevaluatedProperties",
  "writeOnly",
]);

/**
 * The message out of a thrown fault — the converter and the walk always throw
 * `Error`, but a non-Error sentinel must not become the string "undefined".
 */
const faultMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function assertJsonSchemaDocument(document: unknown): asserts document is Record<string, unknown> {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new SchemaInspectError(
      `expected a JSON Schema document in OpenAPI 3.0 form, but found ` +
        `${document === null ? "null" : Array.isArray(document) ? "a bare array" : `a bare ${typeof document}`}`,
    );
  }
  const keys = Object.keys(document);
  if (keys.length === 0 || !keys.some((key) => SCHEMA_VOCABULARY.has(key))) {
    throw new SchemaInspectError(
      "expected a JSON Schema document in OpenAPI 3.0 form, but the object carries none of the " +
        `JSON Schema vocabulary (its keys: ${keys.length === 0 ? "none" : keys.join(", ")})`,
    );
  }
}

/** Is this JSON Schema node the draft-2020-12 null type — `{ "type": "null" }`? */
const isNullTypeArm = (arm: unknown): boolean =>
  typeof arm === "object" && arm !== null && (arm as Record<string, unknown>)["type"] === "null";

/**
 * Depth-first search for the draft-2020-12 nullability form — an `anyOf` with
 * a `null` arm, at any depth. Returns the path of the first offender, or
 * undefined.
 */
const findNullArm = (node: unknown, at: string): string | undefined => {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      const found = findNullArm(item, `${at}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null) return undefined;
  const record = node as Record<string, unknown>;
  const here = at === "" ? "<root>" : at;
  const anyOf = record["anyOf"];
  if (Array.isArray(anyOf)) {
    for (const [index, arm] of anyOf.entries()) {
      if (isNullTypeArm(arm)) return `${here}.anyOf[${index}]`;
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const found = findNullArm(value, at === "" ? key : `${at}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * Refuse a draft-2020-12-form document loudly, before any conversion — never
 * silently converted to unions (design §5, ADR 0038). Nullability is
 * precisely the rendering that shifts between zod versions, so a document
 * that speaks the wrong dialect is a could-not-run fault naming the form, the
 * OpenAPI 3.0 form the command takes, the exporter one-liner that produces
 * it, and the docs page that shows the one-liner.
 */
export function refuseDraft2020Nullability(document: unknown): void {
  const at = findNullArm(document, "");
  if (at === undefined) return;
  throw new SchemaInspectError(
    `the document carries draft-2020-12 nullability — an "anyOf" with a "null" arm — at ${at}. ` +
      'The inspect command takes the OpenAPI 3.0 form, nullability written as "nullable": true. ' +
      'Zod\'s own exporter emits that form: z.toJSONSchema(schema, { target: "openapi-3.0" }). ' +
      "See docs/guide/from-a-schema.md.",
  );
}

/**
 * Convert the document with the loader's own zod — `z.fromJSONSchema` under
 * the `openapi-3.0` default target (design §5: no hand-rolled converter, so
 * there is no second implementation of the dialect to drift from).
 */
export function convertDocument(document: unknown): z.ZodObject {
  assertJsonSchemaDocument(document);
  refuseDraft2020Nullability(document);
  let schema: z.ZodType;
  try {
    schema = z.fromJSONSchema(document, { defaultTarget: "openapi-3.0" });
  } catch (error) {
    throw new SchemaInspectError(
      `the document could not be converted from OpenAPI 3.0 form: ${faultMessage(error)} ` +
        "— the limit is z.fromJSONSchema, which does not convert every JSON Schema construct; " +
        "rewrite the construct out of the document before inspecting it " +
        "(see docs/guide/from-a-schema.md)",
    );
  }
  if (!(schema instanceof z.ZodObject)) {
    throw new SchemaInspectError(
      "expected an object schema at the document root — the leaf inventory only walks objects",
    );
  }
  return schema;
}
