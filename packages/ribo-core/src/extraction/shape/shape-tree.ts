/**
 * @file The shape tree — the plain node tree the derivation's operations run
 * over, and the zod rebuild.
 *
 * The applier (`shape-operations.ts`) works on a plain tree of nodes and
 * rebuilds zod schemas from it, because schema surgery on zod objects in place
 * is how strictness and descriptions get lost silently. Leaves carry their
 * (already patch-normalized) zod schema; objects carry the strictness their
 * original declared.
 *
 * Internal to the derivation — nothing here is exported from the barrel; the
 * applier is its only consumer.
 */

import { z } from "zod";

import { childPath, stripOptionalNullable } from "../../provenance/field-path.js";

/** `shape[key]` for a key that came from `Object.keys(shape)` — narrowed once, the `enveloped.ts` move. */
const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType => shape[key] as z.ZodType;

type Strictness = "strip" | "strict" | "loose";

interface LeafNode {
  readonly kind: "leaf";
  readonly leaf: z.ZodType;
}

/** @category Extraction */
export interface ObjectNode {
  readonly kind: "object";
  readonly children: Map<string, ShapeNode>;
  readonly strictness: Strictness;
}

interface ArrayNode {
  readonly kind: "array";
  readonly element: ObjectNode;
}

/** @category Extraction */
export type ShapeNode = LeafNode | ObjectNode | ArrayNode;

/** Is this a supported leaf kind — the kinds `enveloped()`'s allowlist wraps? */
const isSupportedLeaf = (schema: z.ZodType): boolean =>
  schema instanceof z.ZodEnum ||
  schema instanceof z.ZodLiteral ||
  schema instanceof z.ZodString ||
  schema instanceof z.ZodNumber ||
  schema instanceof z.ZodBoolean;

/**
 * Read an object's strictness back off its catchall: `z.object` declares none,
 * `z.strictObject` a never-catchall, `z.looseObject` an unknown-catchall. The
 * derived patch preserves it — the patch is published, and silently changing
 * how it parses at write would be a lie about the caller's own schema.
 */
const strictnessOf = (obj: z.ZodObject): Strictness => {
  const catchall = obj.def.catchall;
  if (catchall === undefined) return "strip";
  // A never-catchall is what `z.strictObject` declares; anything else that
  // declares one is `z.looseObject`'s unknown-catchall.
  return catchall instanceof z.ZodNever ? "strict" : "loose";
};

/** The patch form of a leaf: `.nullable().optional()`, description kept. */
const patchLeaf = (inner: z.ZodType): z.ZodType => inner.nullable().optional();

/** @category Extraction */
export const buildObjectNode = (obj: z.ZodObject, path: string): ObjectNode => {
  const children = new Map<string, ShapeNode>();
  for (const key of Object.keys(obj.shape)) {
    children.set(key, buildFieldNode(fieldAt(obj.shape, key), childPath(path, key)));
  }
  return { kind: "object", children, strictness: strictnessOf(obj) };
};

/**
 * Normalize one field of the caller's schema into a tree node — refusing, at
 * derivation, everything the extraction pipeline cannot serve.
 */
const buildFieldNode = (field: z.ZodType, path: string): ShapeNode => {
  const stripped = stripOptionalNullable(field);
  if (stripped instanceof z.ZodObject) return buildObjectNode(stripped, path);
  if (stripped instanceof z.ZodArray) {
    const element = stripOptionalNullable(stripped.element as z.ZodType);
    if (!(element instanceof z.ZodObject)) {
      throw new Error(
        `deriveExtractionShape(): the array at "${path}" has a ${element.constructor.name} ` +
          "element — a scalar array gives review no leaf fields to walk per instance, and " +
          "review refuses it outright. Model the element as an object.",
      );
    }
    return { kind: "array", element: buildObjectNode(element, path) };
  }
  if (isSupportedLeaf(stripped)) return { kind: "leaf", leaf: patchLeaf(stripped) };
  throw new Error(
    `deriveExtractionShape(): unsupported shape at "${path}" (${stripped.constructor.name}) — ` +
      "records and unions (including discriminated unions) cannot be enveloped, so the " +
      "derivation refuses them here, at the schema author's desk, rather than at extraction. " +
      "Narrow the schema, or drop this path and capture the value another way.",
  );
};

/** Deep-copy the tree structure; leaf zod schemas are immutable and shared. */
const cloneNode = (node: ShapeNode): ShapeNode => {
  if (node.kind === "leaf") return node;
  if (node.kind === "array") return { kind: "array", element: cloneObjectNode(node.element) };
  return cloneObjectNode(node);
};

/** @category Extraction */
export const cloneObjectNode = (node: ObjectNode): ObjectNode => ({
  kind: "object",
  strictness: node.strictness,
  children: new Map([...node.children].map(([key, child]) => [key, cloneNode(child)])),
});

/**
 * Resolve a path (arrays transparent, the schema-time convention) to its node.
 *
 * @category Extraction
 */
export const resolveNode = (
  root: ObjectNode,
  segments: readonly string[],
): ShapeNode | undefined => {
  let node: ShapeNode = root;
  for (const segment of segments) {
    if (node.kind === "array") node = node.element;
    if (node.kind !== "object") return undefined;
    const child = node.children.get(segment);
    if (child === undefined) return undefined;
    node = child;
  }
  return node;
};

/**
 * Resolve a path to the object that holds its last segment, arrays transparent.
 *
 * @category Extraction
 */
export const resolveContainer = (
  root: ObjectNode,
  segments: readonly string[],
): { container: ObjectNode; key: string } | undefined => {
  if (segments.length === 0) return undefined;
  const parentSegments = segments.slice(0, -1);
  const key = segments[segments.length - 1]!;
  const parent = resolveNode(root, parentSegments);
  if (parent === undefined) return undefined;
  // The container of a path under an array is the element object.
  const container = parent.kind === "array" ? parent.element : parent;
  if (container.kind !== "object") return undefined;
  return { container, key };
};

/**
 * Would walking this path pass through or land on an array (below the group's
 * own element, which the caller has already descended into)? A move that
 * touched an array would make one extraction value fill every element — not
 * data-determined, so refused rather than silently resolved.
 * @category Extraction
 */
export const pathTouchesArray = (root: ObjectNode, segments: readonly string[]): boolean => {
  let node: ShapeNode = root;
  for (const segment of segments) {
    if (node.kind === "array") return true;
    if (node.kind !== "object") return true;
    const child = node.children.get(segment);
    if (child === undefined) return false;
    node = child;
  }
  return node.kind === "array";
};

/** @category Extraction */
export const isPrefixOf = (a: readonly string[], b: readonly string[]): boolean =>
  a.length <= b.length && a.every((segment, i) => segment === b[i]);

/**
 * The message an emptied object is refused with, at either derivation surface.
 *
 * @category Extraction
 */
export const emptyObjectMessage = (path: string): string =>
  `deriveExtractionShape(): the object at "${path === "" ? "<root>" : path}" has no ` +
  "fields left. An empty object serves nothing — drop its parent key instead of its " +
  "last leaf, or keep a leaf in it.";

/**
 * Every object with no children, in the walk order {@link refuseEmptyObjects}
 * throws on them. The partial applier needs the whole set at once — refusing
 * one drop may restore leaves that resolve another.
 * @category Extraction
 */
export const findEmptyObjects = (node: ObjectNode, path: string, out: string[]): void => {
  if (node.children.size === 0) {
    out.push(path);
    return;
  }
  for (const [key, child] of node.children) {
    const childPathText = childPath(path, key);
    if (child.kind === "object") findEmptyObjects(child, childPathText, out);
    if (child.kind === "array") findEmptyObjects(child.element, `${childPathText}[]`, out);
  }
};

/**
 * Refuse any object the operations emptied — an empty object hangs nothing.
 *
 * @category Extraction
 */
export const refuseEmptyObjects = (node: ObjectNode, path: string): void => {
  const emptied: string[] = [];
  findEmptyObjects(node, path, emptied);
  if (emptied.length > 0) throw new Error(emptyObjectMessage(emptied[0]!));
};

/** @category Extraction */
export const treeToZod = (node: ObjectNode, isRoot = true): z.ZodObject => {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, child] of node.children) {
    const built =
      child.kind === "leaf"
        ? child.leaf
        : child.kind === "array"
          ? z.array(treeToZod(child.element, false))
          : treeToZod(child, false);
    // Top-level keys stay optional — a group whose every leaf was rejected is
    // absent from the reviewed patch, and the patch must parse without it.
    shape[key] = isRoot ? built.optional() : built;
  }
  return node.strictness === "strict"
    ? z.strictObject(shape)
    : node.strictness === "loose"
      ? z.looseObject(shape)
      : z.object(shape);
};

/**
 * Every leaf path of the tree, arrays transparent (element-relative).
 *
 * @category Extraction
 */
export const collectLeafPaths = (node: ObjectNode, path: string, out: string[]): void => {
  for (const [key, child] of node.children) {
    const childPathText = childPath(path, key);
    if (child.kind === "leaf") out.push(childPathText);
    else if (child.kind === "object") collectLeafPaths(child, childPathText, out);
    else collectLeafPaths(child.element, childPathText, out);
  }
};
