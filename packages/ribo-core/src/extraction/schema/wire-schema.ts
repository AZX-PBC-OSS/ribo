/**
 * @file The wire rendering of a response schema — where field descriptions leave
 * the schema for the prompt.
 *
 * Hosted structured-output routes cap the *schema*, not the messages: one
 * measured route rejects a schema past 32,768 serialized characters, and the
 * adapters' vendor descriptions are roughly half of that payload. A description
 * is prompt material sitting inside a schema budget — so the response-format
 * render strips it and the prompt builders carry the same text instead (see
 * `field-guidance.ts`). The two halves move together: stripping without the
 * prompt emission loses the vendor's guidance entirely (a measured accuracy
 * regression), while emitting without stripping pays twice and keeps the cap.
 *
 * **The strip is a walk over known schema positions, never a key-name filter.**
 * The naive version — recurse over the rendered JSON and delete every key named
 * `description` — also deletes a field genuinely *named* `description` (the key
 * inside a `properties` map), leaves it behind in `required`, and produces an
 * invalid schema whose 400 surfaces far from the cause. So the walk here only
 * treats `description` as a keyword at positions that ARE schemas: the root,
 * the values of `properties`/`$defs`/`patternProperties` (never their keys),
 * the arms of `anyOf`/`oneOf`/`allOf`/`prefixItems`, and the single-schema
 * positions (`items`, `additionalProperties`, `contains`, `not`, `if`/`then`/
 * `else`, `propertyNames`, `unevaluated*`). Data positions — `enum`, `const`,
 * `default`, `examples` — are never descended into, so an object-valued enum
 * member carrying a `description` key survives verbatim. `required` is never
 * touched, so the strip cannot unbalance it.
 *
 * Descriptions do not affect nesting depth (a description is a scalar beside
 * `type`), so nothing here changes `serializedNestingDepth`'s answer.
 */

import { z } from "zod";

/** Keywords whose value is a MAP of name → schema. Keys are property names, never keywords. */
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "$defs", "patternProperties"]);

/** Keywords whose value is an ARRAY of schemas. */
const SCHEMA_LIST_KEYWORDS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

/** Keywords whose value is a single schema (or, for `items`, an array of them — also schemas). */
const SCHEMA_POSITION_KEYWORDS = new Set([
  "items",
  "additionalProperties",
  "contains",
  "if",
  "then",
  "else",
  "not",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Remove every `description` keyword from a rendered JSON Schema, returning the
 * copy (the input is never mutated).
 *
 * Only schema positions are descended into — see the file header for why a
 * key-name filter over the whole tree is wrong.
 */
export function stripJsonSchemaDescriptions(node: unknown): unknown {
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "description") continue;
    if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [name, subSchema] of Object.entries(value)) {
        mapped[name] = stripJsonSchemaDescriptions(subSchema);
      }
      out[key] = mapped;
    } else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      out[key] = value.map((arm) => stripJsonSchemaDescriptions(arm));
    } else if (SCHEMA_POSITION_KEYWORDS.has(key)) {
      out[key] = stripJsonSchemaDescriptions(value);
    } else {
      // `type`, `enum`, `const`, `required`, `default`, `examples`, `minimum`, … —
      // either scalars or DATA. Never descended into, never modified.
      out[key] = value;
    }
  }
  return out;
}

/**
 * Render a zod schema the way a request's `response_format` carries it —
 * `z.toJSONSchema` (draft-2020-12) with the field descriptions stripped for the
 * prompt, unless `keepDescriptions` keeps them (the "schema" mode of the
 * `fieldDescriptions` option).
 *
 * The render sites that must agree with what the route's schema cap measures
 * all go through here: the single-shot extractor, the schema-retry extractor
 * and `prepareGroups`' per-piece fill schemas. The split's
 * `serializedCharCount` deliberately does NOT — it keeps measuring the FULL
 * rendering as a conservative upper bound of the wire size (the split is a
 * pinned, working mechanism this change does not touch), so a stripped wire
 * schema only ever lands further under the cap than the split measured.
 */
export function toJsonSchemaForWire(
  schema: z.ZodType,
  options?: { keepDescriptions?: boolean },
): Record<string, unknown> {
  const rendered = z.toJSONSchema(schema, { target: "draft-2020-12" });
  if (options?.keepDescriptions === true) return rendered;
  return stripJsonSchemaDescriptions(rendered) as Record<string, unknown>;
}
