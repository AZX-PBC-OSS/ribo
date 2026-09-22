/**
 * @file The leaf inventory — the structured schema dump we hand the model when
 * asking it to propose shape operations.
 *
 * The proposer's prompt must hand the model enough of the schema to make
 * principled drops, retypes and regroups — leaf kinds, paths, descriptions,
 * and which leaves live under a collection. We render this as text because the
 * model reads it inline in the user message; the structured form is exported
 * so tests can assert on shape and on rendering separately.
 *
 * The walk is shallow on purpose: the same flattening every schema-time walk
 * in the shape package uses. Arrays are transparent (the supported kind is
 * arrays of objects, per `deriveExtractionShape`'s allowlist), so a leaf under
 * a collection is recorded once at its element-relative path. Unsupported
 * shapes — scalars inside arrays, unions, records — are walked the same way
 * the applier refuses them at derivation: they do not belong in the inventory
 * either, and an early refusal here means the proposing call surfaces the
 * same shape the derivation would.
 */

import { z } from "zod";
import { childPath, stripOptionalNullable } from "@azx/ribo-core";

/**
 * The leaf kinds the closed retype set and the mapping both name. Re-used
 * here verbatim — the inventory walks the same vocabulary the mapping validates
 * against, so a "number" the retype can target is also a "number" the inventory
 * can show the model.
 */
type LeafKind = "string" | "number" | "boolean" | "enum" | "literal";

/** A single leaf as the model sees it: its dot-path, kind, and any description. */
export interface LeafInventoryEntry {
  readonly path: string;
  readonly kind: LeafKind;
  /** The leaf's `.description()` text, verbatim — what review reads. */
  readonly description?: string;
  /** True iff the leaf lives below one or more `ZodArray` collections. */
  readonly inArray: boolean;
}

/**
 * Walk a zod object schema, returning its supported leaves as a flat list.
 *
 * The walk collects every leaf reachable from the root through full stop- and
 * array-transparent descent. Each leaf is its own entry — duplicate paths
 * across group keys cannot exist under one root schema, so each is unique.
 *
 * Unsupported shapes — a scalar under an array, unions, records — are refused
 * with the same path-named error a derivation would produce, naming those
 * shapes which the inventory only exists to feed the proposal of.
 */
export function walkLeafInventory(schema: z.ZodObject): LeafInventoryEntry[] {
  const out: LeafInventoryEntry[] = [];
  walkField(schema, "", false, out);
  return out;
}

const readLeafKind = (schema: z.ZodType): LeafKind => {
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodEnum) return "enum";
  if (schema instanceof z.ZodLiteral) return "literal";
  throw new Error(
    `walkLeafInventory(): unsupported leaf kind ` +
      `(${schema.constructor.name}) — the inventory only walks the kinds ` +
      "the mapping's closed set names: string, number, boolean, enum, literal.",
  );
};

const walkField = (
  field: z.ZodType,
  path: string,
  inArray: boolean,
  out: LeafInventoryEntry[],
): void => {
  const stripped = stripOptionalNullable(field);
  if (stripped instanceof z.ZodObject) {
    for (const key of Object.keys(stripped.shape)) {
      walkField(stripped.shape[key] as z.ZodType, childPath(path, key), inArray, out);
    }
    return;
  }
  if (stripped instanceof z.ZodArray) {
    const element = stripOptionalNullable(stripped.element as z.ZodType);
    if (element instanceof z.ZodObject) {
      for (const key of Object.keys(element.shape)) {
        walkField(element.shape[key] as z.ZodType, childPath(path, key), true, out);
      }
      return;
    }
    // The pipeline refuses a scalar array outright. Refusing here keeps the
    // inventory honest: the same path-named refusal the derivation gives.
    throw new Error(
      `walkLeafInventory(): the array at "${path || "<root>"}" has a ` +
        `${element.constructor.name} element — model the element as an object.`,
    );
  }
  out.push({
    path,
    kind: readLeafKind(stripped),
    description: stripped.description,
    inArray,
  });
};

/**
 * Render the inventory as text — what the model sees. One line per group
 * (a top-level object or array-of-object), followed by indented leaves with
 * their kind and description. Three intentional choices:
 *
 *   - **Group headers repeat the top-level path and an `object`/`array`
 *     label**, so the model can `regroup` against the right scope.
 *   - **`(no description)` for undescribed leaves** keeps the line parseable
 *     for a model that joins fields on structural tokens.
 *   - **No count summary or totals** — the proposal schema bounds the
 *     operation count, not the inventory. A model's reasoning lives in the
 *     leaves, not in how many there are.
 */
export function renderLeafInventory(entries: readonly LeafInventoryEntry[]): string {
  if (entries.length === 0) return "Schema has no leaves.";

  const grouped = new Map<string, LeafInventoryEntry[]>();
  for (const entry of entries) {
    const key = entry.path.split(".")[0]!;
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [entry]);
    else bucket.push(entry);
  }

  const lines: string[] = [];
  for (const [group, leaves] of grouped) {
    const sample = entries.find((entry) => entry.path === leaves[0]!.path)!;
    const shape = sample.inArray ? "array" : "object";
    lines.push(`- ${group} (${shape})`);
    for (const leaf of leaves) {
      const inside = leaf.path.slice(group.length + 1);
      const tail = leaf.description === undefined ? "" : ` — "${leaf.description}"`;
      lines.push(`    - ${inside} (${leaf.kind})${tail}`);
    }
  }
  return lines.join("\n");
}
