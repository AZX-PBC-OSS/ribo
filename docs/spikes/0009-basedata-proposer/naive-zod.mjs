/**
 * @file Naive zod-schema construction from Snugg Pro's `definitions.basedata`.
 *
 * The mechanical translation a `ts-to-zod`-style tool would produce, no
 * judgement. The schema uses:
 *
 *   - `type: "string"` + `enum: [<strings>]` → `z.enum(...)` with member list
 *     concatenated into the description so the proposer sees what it can pick.
 *   - `type: "string"` + `enum: false` (Swagger 2.0's "open string" marker) →
 *     `z.string()`.
 *   - `type: "number"|"integer"` → `z.number()`.
 *   - `type: "array"` of object items → `z.array(z.object({...}))` resolved
 *     through `$ref` so `enveloped()` accepts it.
 *   - `description` carried verbatim as `.describe(...)` text.
 *
 * Every leaf is `.nullable().optional()` — the patch shape the proposer's
 * applier asked for. Each `.describe(...)` carries vendor text first, then the
 * enum members verbatim if the leaf is an enum: a model that has to pick a
 * member sees the list, including spaces, slashes, percent signs, parenthesised
 * ranges, and an explicit "Don't Know" / "Not Tested" escape hatch.
 *
 * **The enum-in-description decision.** Including every enum member in the leaf
 * description is the choice that makes the model-grounded proposal *possible*
 * — without it the model sees `kind: enum` without a member list and has no way
 * to choose one — but it is the most expensive option too. Cost is reported in
 * the run.
 */

import { createRequire } from "node:module";

const require_ = createRequire(
  new URL("../../packages/ribo-extractor-openai/dist/index.js", import.meta.url),
);
const zodPath = require_.resolve("zod");
const zodImport = zodPath.endsWith(".cjs") ? zodPath.replace(/\.cjs$/, ".js") : zodPath;
const { z } = await import(zodImport);

/**
 * Resolve a Swagger 2.0 `$ref` like "#/definitions/customField" against the
 * top-level `definitions` map.
 */
const resolveRef = (ref, definitions) => {
  if (typeof ref !== "string") return undefined;
  if (!ref.startsWith("#/definitions/")) return undefined;
  const defName = ref.slice("#/definitions/".length);
  return definitions[defName];
};

/**
 * Compose the leaf description the model reads:
 *   - the vendor's description, first (it orients the model);
 *   - the enum members verbatim, after, so a model that has to pick one has the
 *     list without a second pass;
 *   - the wire type, on its own line at the bottom, so a model knows whether
 *     the wire value is a string, an integer, or a real number.
 */
function composeDescription(vendor, options) {
  const parts = [];
  if (vendor) parts.push(vendor);
  if (options.enumMembers) {
    parts.push(`\n\nAllowed values (verbatim wire strings): ${options.enumMembers.join(" | ")}`);
  }
  if (options.wireType) parts.push(`\n\nWire type: ${options.wireType}`);
  return parts.join("");
}

function describeLeaf(base, property) {
  const members = Array.isArray(property.enum) ? property.enum : undefined;
  const description = composeDescription(property.description, {
    enumMembers: members,
    wireType: property.type,
  });
  if (description.length > 0) {
    const described = base.describe(description);
    return described;
  }
  return base;
}

/**
 * Build the leaf schema for one Swagger property.
 *
 * The spec's `enum: false` is a non-standard marker marking an open string form
 * input with constraints (minimum/maximum) but no value list. We treat those as
 * `z.string()`.
 */
function buildLeaf(property, definitions) {
  const wireType = property.type || "string";
  let base;
  if (wireType === "string") {
    if (Array.isArray(property.enum)) {
      base = z.enum(property.enum);
    } else {
      base = z.string();
    }
  } else if (wireType === "number" || wireType === "integer") {
    base = z.number();
  } else if (wireType === "array") {
    const items = property.items ?? {};
    const itemRef = resolveRef(items.$ref, definitions);
    if (itemRef?.type === "object") {
      const childShape = buildObjectShape(itemRef, definitions);
      base = z.array(z.object(childShape).strict());
    } else {
      base = z.array(z.unknown());
    }
  } else if (wireType === "boolean") {
    base = z.boolean();
  } else if (wireType === "object") {
    base = z.object(buildObjectShape(property, definitions)).strict();
  } else {
    base = z.unknown();
  }

  return describeLeaf(base, property).nullable().optional();
}

/**
 * Build a child object shape for an inline `type: object` property, eating
 * nested `$ref`s and descriptions the same way `buildLeaf` does.
 */
function buildObjectShape(property, definitions) {
  const shape = {};
  for (const [name, child] of Object.entries(property.properties ?? {})) {
    shape[name] = buildLeaf(child, definitions);
  }
  return shape;
}

/**
 * Build the full naive schema from one Swagger 2.0 `definition`. The shape is
 * a single top-level zod OBJECT — basedata is one flat endpoint, not nested —
 * matching the spec's `definitions.basedata.properties` being a single object
 * map. The applier walks `walkLeafInventory` against this and groups leaves by
 * their first dot-segment, which is `basedata` for every property.
 */
export function buildNaiveSchema(definition, definitions) {
  const shape = {};
  for (const [name, property] of Object.entries(definition.properties)) {
    shape[name] = buildLeaf(property, definitions);
  }
  return z.object(shape).strict();
}
