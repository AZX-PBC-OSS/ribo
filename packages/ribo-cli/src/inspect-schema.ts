/**
 * The inspect entry (design §2): one importable function over the same JSON
 * Schema document the bin takes — never a zod object (ADR 0038). A zod object
 * cannot cross a process boundary, so the bin could only ever see a document;
 * an entry that accepted both would carry inputs with different honesty
 * properties. One input, one conversion path, one set of caveats.
 */
import { walkLeafInventory } from "@azx/ribo-core";
import { z } from "zod";

import { cliVersion, coreVersion } from "./versions.js";

/**
 * The version of the report's JSON contract (design §7). Owned by the CLI and
 * bumped only when a field's name or meaning changes — numbers computed by
 * unchanged core symbols do not bump it.
 */
export const CONTRACT_VERSION = 1;

/** Raised for every could-not-run fault: the input never became a report. */
export class SchemaInspectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaInspectError";
  }
}

/**
 * Options of `inspectSchema`. At the skeleton ticket the command surface has no
 * flags yet; the threshold options of the design (`--max-depth`,
 * `--max-piece-chars`, design §1) arrive with the flags ticket and land here.
 * `Record<string, never>` — no options exist today, and none may be passed.
 */
export type SchemaInspectOptions = Record<string, never>;

/** The versioned report the skeleton command emits (design §7). */
export interface SchemaInspectReport {
  /** The version of this JSON contract itself (see `CONTRACT_VERSION`). */
  contractVersion: typeof CONTRACT_VERSION;
  /** The `@azx/ribo-cli` version that produced the numbers. */
  cliVersion: string;
  /** The `@azx/ribo-core` version the measures were computed with. */
  coreVersion: string;
  /** Supported leaves the schema carries, per `walkLeafInventory`. */
  leafCount: number;
}

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

function convertDocument(document: unknown): z.ZodObject {
  assertJsonSchemaDocument(document);
  let schema: z.ZodType;
  try {
    schema = z.fromJSONSchema(document, { defaultTarget: "openapi-3.0" });
  } catch (error) {
    throw new SchemaInspectError(
      `the document could not be converted from OpenAPI 3.0 form: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!(schema instanceof z.ZodObject)) {
    throw new SchemaInspectError(
      "expected an object schema at the document root — the leaf inventory only walks objects",
    );
  }
  return schema;
}

/**
 * Inspect a JSON Schema document in OpenAPI 3.0 form and return the versioned
 * report: the bundle-time versions and one schema-derived measure, `leafCount`,
 * computed by `walkLeafInventory` from `@azx/ribo-core` — the same symbol the
 * real extraction path reads, never a CLI-side re-derivation (design §3).
 *
 * Invalid, non-schema or unconvertible documents raise `SchemaInspectError`,
 * which the bin maps to the could-not-run class (exit 2, stderr only).
 */
export function inspectSchema(
  document: unknown,
  // Reserved for the threshold flags of design §1; nothing to carry yet.
  _options: SchemaInspectOptions = {},
): SchemaInspectReport {
  const schema = convertDocument(document);
  return {
    contractVersion: CONTRACT_VERSION,
    cliVersion,
    coreVersion,
    leafCount: walkLeafInventory(schema).length,
  };
}
