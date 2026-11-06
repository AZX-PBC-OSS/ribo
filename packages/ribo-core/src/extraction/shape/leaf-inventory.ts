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
import { childPath, stripOptionalNullable } from "../../provenance/field-path.js";

import type { DerivedExtractionShape } from "./derived-shape.js";
import type { DeriveExtractionShapeOptions } from "./shape-operations.js";

/**
 * The caller's declarations the inventory tags — the derive options minus the operations.
 *
 * @category Extraction
 */
export type InventoryDeclarations = Omit<DeriveExtractionShapeOptions, "operations">;

/**
 * The leaf kinds the closed retype set and the mapping both name. Re-used
 * here verbatim — the inventory walks the same vocabulary the mapping validates
 * against, so a "number" the retype can target is also a "number" the inventory
 * can show the model.
 */
type LeafKind = "string" | "number" | "boolean" | "enum" | "literal";

/**
 * A member of an enum or literal leaf — whatever zod lets either declare.
 *
 * @category Extraction
 */
export type LeafValue = string | number | bigint | boolean | null | undefined;

/**
 * A single leaf as the model sees it: its dot-path, kind, and any description.
 *
 * @category Extraction
 */
export interface LeafInventoryEntry {
  readonly path: string;
  readonly kind: LeafKind;
  /** The leaf's `.description()` text, verbatim — what review reads. */
  readonly description?: string;
  /** An enum's or literal's members, as declared; absent for every other kind. */
  readonly values?: readonly LeafValue[];
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
 * @category Extraction
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
    values: readLeafValues(stripped),
    inArray,
  });
};

const readLeafValues = (schema: z.ZodType): readonly LeafValue[] | undefined => {
  if (schema instanceof z.ZodEnum) return schema.options;
  if (schema instanceof z.ZodLiteral) return [...schema.values];
  return undefined;
};

/**
 * What the committed operations did to each original leaf, keyed by the
 * leaf's path in the caller's schema — the tags a resume turn's field list
 * renders. Read off the derived artifact's mapping alone, never by
 * re-applying operations: the mapping already says where every extraction
 * leaf came from, so a dropped leaf is an original leaf that is no entry's
 * `source`, a retype is an entry with a `retype`, and a move is an entry
 * whose extraction path differs from its source. A committed partition tags
 * its fields `[part: <label>]`, read from the shape's `partitions` record —
 * partition and regroup cannot share a group, so a part's extraction-space
 * paths are the caller's own.
 * @category Extraction
 */
export function appliedTags(
  schema: z.ZodObject,
  shape: DerivedExtractionShape,
): ReadonlyMap<string, readonly string[]> {
  const extractionPathBySource = new Map<string, string>();
  for (const [extractionPath, entry] of Object.entries(shape.mapping.leaves)) {
    extractionPathBySource.set(entry.source, extractionPath);
  }
  const partTags = new Map<string, string>();
  for (const [group, parts] of Object.entries(shape.partitions)) {
    for (const [label, fields] of Object.entries(parts)) {
      for (const field of fields) partTags.set(`${group}.${field}`, `[part: ${label}]`);
    }
  }
  const tags = new Map<string, readonly string[]>();
  for (const { path } of walkLeafInventory(schema)) {
    const extractionPath = extractionPathBySource.get(path);
    if (extractionPath === undefined) {
      tags.set(path, ["[dropped]"]);
      continue;
    }
    const leaf: string[] = [];
    const entry = shape.mapping.leaves[extractionPath]!;
    if (entry.retype !== undefined) leaf.push(`[retyped → ${entry.retype.extraction}]`);
    if (extractionPath !== path) leaf.push(`[moved → ${extractionPath}]`);
    const part = partTags.get(path);
    if (part !== undefined) leaf.push(part);
    if (leaf.length > 0) tags.set(path, leaf);
  }
  return tags;
}

/**
 * Render the inventory as text — what the model sees. One line per group
 * (a top-level object or array-of-object), followed by indented leaves with
 * their kind and description. Intentional choices:
 *
 *   - **Group headers repeat the top-level path and an `object`/`array`
 *     label**, so the model can `regroup` against the right scope.
 *   - **An enum or literal lists its members** beside the kind.
 *   - **Declarations render as bracketed tags** after the kind, so the model
 *     sees what a drop would strand before the applier refuses it.
 *   - **Applied operations render as bracketed tags** after the declaration
 *     tags, so a resume turn shows what is already applied and locked.
 *   - **No count summary or totals** — the proposal schema bounds the
 *     operation count, not the inventory. A model's reasoning lives in the
 *     leaves, not in how many there are.
 *
 * **Ground leaves render flat, not under a phantom header.** A leaf whose
 * path has no dot — i.e. one that lives at the schema's root rather than
 * under a nested object — is the inventory's basic case, not a group. The
 * header carries "this is a group you can address" (it shapes what
 * `regroup` can move), and a top-level field is not a group — it is what
 * `nest` moves, and the flat rendering is exactly what lets the model see it
 * as a nest source: rendering `- <leaf> (object)\n    -  (kind)` would have
 * asserted the leaf is an object and produced a nameless leaf line, neither
 * of which is true. Such leaves appear at the inventory's top level alongside
 * their kind and description.
 * @category Extraction
 */
export function renderLeafInventory(
  entries: readonly LeafInventoryEntry[],
  declarations: InventoryDeclarations = {},
  applied?: ReadonlyMap<string, readonly string[]>,
): string {
  if (entries.length === 0) return "Schema has no leaves.";

  // Bucket the entries: a leaf with no dot in its path is "ground" (it lives
  // at the schema root) and renders flat; the rest still groups by its
  // top-level segment as before, since a nested object is the kind of
  // structural scope `regroup` addresses.
  const ground: LeafInventoryEntry[] = [];
  const grouped = new Map<string, LeafInventoryEntry[]>();
  for (const entry of entries) {
    if (!entry.path.includes(".")) {
      ground.push(entry);
      continue;
    }
    const key = entry.path.split(".")[0]!;
    const bucket = grouped.get(key);
    if (bucket === undefined) grouped.set(key, [entry]);
    else bucket.push(entry);
  }

  const lines: string[] = [];
  for (const leaf of ground) {
    const tail = leaf.description === undefined ? "" : ` — "${leaf.description}"`;
    const tags = [
      ...groupTags(leaf.path, declarations),
      ...leafTags(leaf.path, leaf.path, declarations),
      ...(applied?.get(leaf.path) ?? []),
    ];
    lines.push(`- ${leaf.path} (${renderKind(leaf)})${renderTags(tags)}${tail}`);
  }
  for (const [group, leaves] of grouped) {
    const sample = entries.find((entry) => entry.path === leaves[0]!.path)!;
    const shape = sample.inArray ? "array" : "object";
    lines.push(`- ${group} (${shape})${renderTags(groupTags(group, declarations))}`);
    for (const leaf of leaves) {
      const inside = leaf.path.slice(group.length + 1);
      const tail = leaf.description === undefined ? "" : ` — "${leaf.description}"`;
      const tags = renderTags([
        ...leafTags(group, inside, declarations),
        ...(applied?.get(leaf.path) ?? []),
      ]);
      lines.push(`    - ${inside} (${renderKind(leaf)})${tags}${tail}`);
    }
  }
  return lines.join("\n");
}

/**
 * The kind, plus an enum's or literal's members: a hint or a drop decision
 * on an enum needs its vocabulary, not just the word. Strings are quoted so
 * `"1"` and `1` stay distinguishable.
 */
const renderKind = (leaf: LeafInventoryEntry): string =>
  leaf.values === undefined
    ? leaf.kind
    : `${leaf.kind}: ${leaf.values.map((value) => (typeof value === "string" ? JSON.stringify(value) : String(value))).join(" | ")}`;

/** A top-level key's tags: its provenance granularity, when declared. */
const groupTags = (key: string, declarations: InventoryDeclarations): string[] => {
  const granularity = declarations.provenance?.[key];
  return granularity === undefined ? [] : [`[provenance: ${granularity}]`];
};

/**
 * A leaf's tags, looked up the way the declarations name it: by its
 * group-relative path, or a top-level leaf by its own key.
 */
const leafTags = (group: string, leaf: string, declarations: InventoryDeclarations): string[] => {
  const tags: string[] = [];
  if (declarations.requiredOnCreate?.[group]?.includes(leaf)) tags.push("[required on create]");
  if (declarations.identifyingFields?.[group]?.includes(leaf)) tags.push("[identifying]");
  return tags;
};

const renderTags = (tags: readonly string[]): string => tags.map((tag) => ` ${tag}`).join("");
