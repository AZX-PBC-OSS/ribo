/**
 * @file The model-owned declaration language. This is deliberately not JSON
 * Schema: code alone owns the OpenAPI rendering and its supported shapes.
 */
import { z } from "zod";

/** A quote and the one loaded sample in which it must occur. */
export interface SchemaInitEvidence {
  readonly source: string;
  readonly quote: string;
}

/** The scalar leaf kinds the extraction field inventory can walk. */
export type SchemaInitLeafKind = "string" | "number" | "boolean";

/** One evidenced member of a conservative string enum. */
export interface SchemaInitEnumMember {
  readonly value: string;
  readonly evidence: SchemaInitEvidence;
}

/** A scalar declaration; optionality and enums are declarations, not wire-schema syntax. */
export interface SchemaInitLeafDeclaration {
  readonly kind: SchemaInitLeafKind;
  readonly description: string;
  readonly optional?: boolean;
  readonly evidence: SchemaInitEvidence;
  readonly enum?: readonly SchemaInitEnumMember[];
}

/** A named property on an object declaration. */
export interface SchemaInitPropertyDeclaration {
  readonly name: string;
  readonly node: SchemaInitNodeDeclaration;
}

/** A fixed object node with an ordered, duplicate-checkable property list. */
export interface SchemaInitObjectDeclaration {
  readonly kind: "object";
  readonly description: string;
  readonly properties: readonly SchemaInitPropertyDeclaration[];
}

/** A collection whose element is always an object, never a scalar or union. */
export interface SchemaInitCollectionDeclaration {
  readonly kind: "collection";
  readonly description: string;
  readonly items: SchemaInitObjectDeclaration;
}

/** Every node the model may declare. */
export type SchemaInitNodeDeclaration =
  SchemaInitObjectDeclaration | SchemaInitCollectionDeclaration | SchemaInitLeafDeclaration;

/** The model's whole declaration reply; source coverage is deliberately not asserted. */
export interface SchemaInitProposal {
  readonly root: SchemaInitObjectDeclaration;
}

const nonEmpty = (label: string) =>
  z
    .string()
    .min(1, `${label} must not be empty`)
    .refine((value) => value.trim().length > 0, `${label} must not be whitespace only`);

const evidenceSchema = z.strictObject({
  source: nonEmpty("evidence source"),
  quote: nonEmpty("evidence quote"),
});

const propertyNameSchema = nonEmpty("property name").refine(
  (name) => !name.includes(".") && !name.includes("[") && !name.includes("]"),
  "property name must be one path segment without dots or brackets",
);

const leafDeclarationSchema = z.strictObject({
  kind: z.enum(["string", "number", "boolean"]),
  description: nonEmpty("description"),
  optional: z.boolean().optional(),
  evidence: evidenceSchema,
  enum: z
    .array(
      z.strictObject({
        value: nonEmpty("enum value"),
        evidence: evidenceSchema,
      }),
    )
    .min(1, "enum must have at least one evidenced member")
    .optional(),
});

const nodeDeclarationSchema: z.ZodType<SchemaInitNodeDeclaration> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    objectDeclarationSchema,
    collectionDeclarationSchema,
    leafDeclarationSchema,
  ]),
);

const objectDeclarationSchema = z.strictObject({
  kind: z.literal("object"),
  description: nonEmpty("description"),
  properties: z
    .array(
      z.strictObject({
        name: propertyNameSchema,
        node: nodeDeclarationSchema,
      }),
    )
    .min(1, "object must declare at least one property"),
});

const collectionDeclarationSchema = z.strictObject({
  kind: z.literal("collection"),
  description: nonEmpty("description"),
  items: objectDeclarationSchema,
});

/** The strict trust-boundary parser for one model proposal. */
export const schemaInitProposalSchema = z.strictObject({ root: objectDeclarationSchema });

/**
 * Strict structured output requires every property to be listed as required, so
 * the wire form lists them all and lets a member the parser treats as optional
 * arrive as null. {@link dropOptionalNulls} turns those nulls back into absence.
 *
 * Shared with the corpus proposal language (`corpus/propose-language.ts`), whose
 * reply schema gets the same strict-wire treatment: one copy of the transform,
 * so both languages' wire forms stay all-required and null-optional.
 */
export function strictWireSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictWireSchema);
  if (node === null || typeof node !== "object") return node;
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    // `properties` and `$defs` map names to schemas; every other member is a schema or a value.
    record[key] =
      (key === "properties" || key === "$defs") && value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([name, schema]) => [
              name,
              strictWireSchema(schema),
            ]),
          )
        : strictWireSchema(value);
  }
  const properties = record["properties"];
  if (properties === null || typeof properties !== "object") return record;
  const required = new Set((record["required"] as string[] | undefined) ?? []);
  record["properties"] = Object.fromEntries(
    Object.entries(properties as Record<string, unknown>).map(([name, schema]) => [
      name,
      required.has(name) ? schema : { anyOf: [schema, { type: "null" }] },
    ]),
  );
  record["required"] = Object.keys(properties);
  return record;
}

/** The matching structured-output contract sent to chat transports. */
export const schemaInitProposalJsonSchema = strictWireSchema(
  z.toJSONSchema(schemaInitProposalSchema, { target: "draft-2020-12" }),
) as Record<string, unknown>;

/** The members the parser treats as optional, which the strict wire form sends as null. */
const OPTIONAL_MEMBERS = new Set(["optional", "enum"]);

/**
 * Remove null members for the named keys, recursively — what a strict
 * transport sends for a member the parser treats as optional.
 */
export function dropNullMembers(value: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((member) => dropNullMembers(member, keys));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, member]) => !(member === null && keys.has(key)))
      .map(([key, member]) => [key, dropNullMembers(member, keys)]),
  );
}

/** Remove null optional members so the strict parser sees them as absent. */
export function dropOptionalNulls(value: unknown): unknown {
  return dropNullMembers(value, OPTIONAL_MEMBERS);
}
