/**
 * @file The operation set, and the applier that turns a caller's plain zod
 * schema plus an explicit list of those operations into the derived artifact —
 * an extraction schema, and the mapping back.
 *
 * The operation set is what a human did when they built the pilot adapter by
 * hand, made minimal and explicit: **drop** (the pilot's scoping — fields no
 * dictation ever fills), **retype** (the pilot's KNOWN DIVERGENCES — numeric
 * fields the vendor types as form-input strings, modelled as what they mean),
 * and **regroup within a top-level key** (re-nesting leaves for extraction).
 * Beside the three value-space operations, the artifact carries the four
 * declarations review and write need — required-on-create, identifying fields,
 * provenance granularity and the leaves' own descriptions — validated against
 * the derived patch rather than trusted.
 *
 * **`group()` may not cross a top-level boundary.** A row-provenance derived
 * group has one span with no data-determined place to land across two original
 * groups; `validateProvenance` and `statedEmptyGroups` are both keyed by the
 * top-level group. Regrouping *within* a top-level key is the supported move,
 * and the mapping's construction-time check refuses an entry whose source
 * names a different top-level key.
 *
 * **No `markCollection`.** Collection-ness is structural — a `ZodArray` of
 * objects is a collection to `enveloped()`, to the split and to review, none of
 * which takes a declaration — so there is no such operation, and a move may not
 * touch an array: its source and destination must both live below the group's
 * own element, never passing through or landing on an array, or one extraction
 * value would have to fill every element.
 *
 * **The composition rule.** The operations are a SET, not a sequence, and the
 * applier owns the state machine that makes ambiguity unreachable:
 *
 *   - `drop` composes with nothing — a dropped path is gone, and a `retype` or
 *     a move naming it is refused as not-found;
 *   - at most one `retype` per path and at most one `regroup` per group — a
 *     duplicate is refused, not silently overwritten;
 *   - `retype` and a move compose on the same leaf (retype the kind, move the
 *     position — orthogonal dimensions);
 *   - a move's destination must not exist after its group's sources are
 *     removed, no two destinations may prefix one another, and no destination
 *     may lie under a dropped path — so insert order cannot change the result.
 *
 * **The refusals the derivation owes.** A scalar array, a union or a record is
 * refused HERE, naming the path — review refuses a scalar array outright, and
 * `enveloped()`'s allowlist rejects unions and records — and an error at
 * derivation, where the schema author is present, beats the same failure at
 * extraction, where it surfaces as an opaque route error far from its cause.
 */

import { z } from "zod";

import { childPath, enveloped, parseFieldPath, stripOptionalNullable } from "@azx/ribo-core";
import type { ProvenanceGranularity } from "@azx/ribo-core";

import type { DerivedExtractionShape } from "./derived-shape.js";
import { assertShapeMapping } from "./shape-mapping.js";
import type { Retype, ShapeMapping } from "./shape-mapping.js";

/** `shape[key]` for a key that came from `Object.keys(shape)` — narrowed once, the `enveloped.ts` move. */
const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType => shape[key] as z.ZodType;

/**
 * One operation on the caller's schema. See the file header for the set, the
 * composition rule, and why there is no `markCollection`.
 */
export type ShapeOperation =
  | /** Remove the leaf (or whole subtree) at the dotted path from both the
     * derived patch and the extraction schema. The pilot's scoping. */
    {
      readonly op: "drop";
      /** Dotted path from the schema root; a whole group may be dropped. */
      readonly path: string;
    } /** Extract the leaf at the dotted path as a number. The closed set's only
     * member: the patch leaf must be a `string` (the pilot's form-input
     * divergence), and reversal applies the pinned `String` encoding. */
  | {
      readonly op: "retype";
      /** Dotted path of a patch LEAF. */
      readonly path: string;
      /** The extraction kind. The closed set has one member; widening it widens this union. */
      readonly to: "number";
    } /** Re-nest leaves within one top-level key: each key of `moves` is a
   * dotted path relative to the group, moved to the destination it names —
   * also relative. May deepen, flatten or rename, but never cross the
   * group's top-level boundary and never touch an array. */
  | {
      readonly op: "regroup";
      /** The top-level group key the moves live under. */
      readonly group: string;
      /** Group-relative source path → group-relative destination path. */
      readonly moves: Readonly<Record<string, string>>;
    };

/** Options for {@link deriveExtractionShape}. */
export interface DeriveExtractionShapeOptions {
  /** The shape operations to apply. Defaults to none — pure normalization. */
  readonly operations?: readonly ShapeOperation[];
  /**
   * Per-top-level-key provenance granularity, handed to `enveloped()` for the
   * extraction schema and carried on the artifact for review. Groups absent
   * from the map keep `"leaf"`.
   */
  readonly provenance?: Readonly<Record<string, ProvenanceGranularity>>;
  /**
   * Required-on-create declarations, in review's per-group shape, validated
   * against the derived patch and carried on the artifact.
   */
  readonly requiredOnCreate?: Readonly<Record<string, readonly string[]>>;
  /**
   * Identifying-fields declarations, validated the same way and carried on the
   * artifact.
   */
  readonly identifyingFields?: Readonly<Record<string, readonly string[]>>;
}

// --- The shape tree ----------------------------------------------------------
// The applier works on a plain tree of nodes and rebuilds zod schemas from it,
// because schema surgery on zod objects in place is how strictness and
// descriptions get lost silently. Leaves carry their (already patch-normalized)
// zod schema; objects carry the strictness their original declared.

type Strictness = "strip" | "strict" | "loose";

interface LeafNode {
  readonly kind: "leaf";
  readonly leaf: z.ZodType;
}

interface ObjectNode {
  readonly kind: "object";
  readonly children: Map<string, ShapeNode>;
  readonly strictness: Strictness;
}

interface ArrayNode {
  readonly kind: "array";
  readonly element: ObjectNode;
}

type ShapeNode = LeafNode | ObjectNode | ArrayNode;

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

const buildObjectNode = (obj: z.ZodObject, path: string): ObjectNode => {
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

const cloneObjectNode = (node: ObjectNode): ObjectNode => ({
  kind: "object",
  strictness: node.strictness,
  children: new Map([...node.children].map(([key, child]) => [key, cloneNode(child)])),
});

/** Resolve a path (arrays transparent, the schema-time convention) to its node. */
const resolveNode = (root: ObjectNode, segments: readonly string[]): ShapeNode | undefined => {
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

/** Resolve a path to the object that holds its last segment, arrays transparent. */
const resolveContainer = (
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
 */
const pathTouchesArray = (root: ObjectNode, segments: readonly string[]): boolean => {
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

const isPrefixOf = (a: readonly string[], b: readonly string[]): boolean =>
  a.length <= b.length && a.every((segment, i) => segment === b[i]);

/** Refuse any object the operations emptied — an empty object hangs nothing. */
const refuseEmptyObjects = (node: ObjectNode, path: string): void => {
  if (node.children.size === 0) {
    throw new Error(
      `deriveExtractionShape(): the object at "${path === "" ? "<root>" : path}" has no ` +
        "fields left. An empty object serves nothing — drop its parent key instead of its " +
        "last leaf, or keep a leaf in it.",
    );
  }
  for (const [key, child] of node.children) {
    const childPathText = childPath(path, key);
    if (child.kind === "object") refuseEmptyObjects(child, childPathText);
    if (child.kind === "array") refuseEmptyObjects(child.element, `${childPathText}[]`);
  }
};

const treeToZod = (node: ObjectNode, isRoot = true): z.ZodObject => {
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

/** Every leaf path of the tree, arrays transparent (element-relative). */
const collectLeafPaths = (node: ObjectNode, path: string, out: string[]): void => {
  for (const [key, child] of node.children) {
    const childPathText = childPath(path, key);
    if (child.kind === "leaf") out.push(childPathText);
    else if (child.kind === "object") collectLeafPaths(child, childPathText, out);
    else collectLeafPaths(child.element, childPathText, out);
  }
};

/**
 * Parse an operation's dotted path into object-key segments, refusing instance
 * keys: schema-time paths have no instances, so a bracketed path addresses
 * nothing any walk produced.
 */
const opSegments = (path: string, what: string): string[] => {
  const segments = parseFieldPath(path);
  if (segments.length === 0 || segments.some((segment) => segment.kind !== "objectKey")) {
    throw new Error(
      `deriveExtractionShape(): the ${what} path "${path}" is not a plain dotted object path — ` +
        "schema-time paths have no instance keys (brackets address data-time instances).",
    );
  }
  return segments.map((segment) => (segment.kind === "objectKey" ? segment.key : ""));
};

/**
 * Remap a group-relative leaf path through the group's moves: the shortest
 * matching source prefix is replaced by its destination. Sources never overlap
 * (validated below), so at most one move applies to any leaf.
 */
const remapThroughMoves = (
  rest: readonly string[],
  moves: ReadonlyMap<string, string>,
): string[] => {
  for (let i = 1; i <= rest.length; i++) {
    const to = moves.get(rest.slice(0, i).join("."));
    if (to !== undefined) return [...to.split("."), ...rest.slice(i)];
  }
  return [...rest];
};

/**
 * Derive the extraction shape from the caller's schema: normalize it into
 * patch form, apply the operations, run `enveloped()` over the shaped result,
 * and derive the mapping back — then verify the artifact against itself.
 *
 * Synchronous and model-free: the operations are explicit data. A model-driven
 * derivation composes this same applier over its own PROPOSAL of operations,
 * which keeps the model away from schema surgery entirely and gives its
 * proposal a validation surface that is already built.
 */
export function deriveExtractionShape(
  schema: z.ZodObject,
  options: DeriveExtractionShapeOptions = {},
): DerivedExtractionShape {
  const operations = options.operations ?? [];
  const provenance = options.provenance ?? {};

  // 1 — Normalize the caller's schema into patch form, refusing what the
  // pipeline cannot serve (scalar arrays, unions, records) at the path.
  const patchTree = buildObjectNode(schema, "");

  // 2 — Bucket the operations, refusing duplicates: the operations are a set,
  // and a silently-overwritten duplicate is exactly the ambiguity the applier
  // exists to make unreachable.
  const drops = new Map<string, string[]>();
  const retypes = new Map<string, "number">();
  const regroups = new Map<string, Map<string, string>>();
  for (const operation of operations) {
    if (operation.op === "drop") {
      if (drops.has(operation.path)) {
        throw new Error(`deriveExtractionShape(): drop names "${operation.path}" twice.`);
      }
      drops.set(operation.path, opSegments(operation.path, "drop"));
    } else if (operation.op === "retype") {
      if (retypes.has(operation.path)) {
        throw new Error(`deriveExtractionShape(): retype names "${operation.path}" twice.`);
      }
      if (operation.to !== "number") {
        // Unreachable for a TS caller (`to` is the literal "number"); a JS
        // caller passing anything else gets the construction-time refusal.
        throw new Error(
          `deriveExtractionShape(): retype to "${String(operation.to)}" at "${operation.path}" ` +
            'is outside the closed set — the only member is string→number ("to": "number").',
        );
      }
      retypes.set(operation.path, operation.to);
    } else {
      if (regroups.has(operation.group)) {
        throw new Error(
          `deriveExtractionShape(): regroup names group "${operation.group}" twice — ` +
            "merge the moves into one operation.",
        );
      }
      regroups.set(operation.group, new Map(Object.entries(operation.moves)));
    }
  }

  // 3 — Apply the drops to the patch tree. A drop must name something present;
  // a `retype` or move naming a dropped path is refused below as not-found.
  for (const [path, segments] of drops) {
    const resolved = resolveContainer(patchTree, segments);
    if (resolved === undefined || !resolved.container.children.has(resolved.key)) {
      throw new Error(
        `deriveExtractionShape(): drop names "${path}", which is not a path of the schema.`,
      );
    }
    resolved.container.children.delete(resolved.key);
  }

  // 4 — Clone for the shaped tree, apply the retypes, then the regroups.
  // (The clone shares leaf NODES, so a retype REPLACES the node in its
  // container rather than mutating it — the patch tree keeps the kind the
  // caller declared.)
  const shapedTree = cloneObjectNode(patchTree);
  for (const path of retypes.keys()) {
    const segments = opSegments(path, "retype");
    const resolved = resolveContainer(shapedTree, segments);
    const node = resolved?.container.children.get(resolved.key);
    if (resolved === undefined || node === undefined || node.kind !== "leaf") {
      throw new Error(
        `deriveExtractionShape(): retype names "${path}", which is not a leaf of the schema ` +
          "(it may name a dropped path, a group, or nothing at all).",
      );
    }
    const inner = stripOptionalNullable(node.leaf);
    if (!(inner instanceof z.ZodString)) {
      throw new Error(
        `deriveExtractionShape(): retype at "${path}" needs a string patch leaf — the closed ` +
          `set is string→number only, and this leaf's kind is ${inner.constructor.name}. ` +
          "A retype whose source kind is outside the closed set has no canonical inverse.",
      );
    }
    const description = inner.description;
    const number_ = description === undefined ? z.number() : z.number().describe(description);
    resolved.container.children.set(resolved.key, {
      kind: "leaf",
      leaf: number_.nullable().optional(),
    });
  }
  for (const [group, moves] of regroups) {
    applyRegroup(shapedTree, drops, group, moves);
  }

  // 5 — Refuse any object either tree emptied.
  refuseEmptyObjects(patchTree, "");
  refuseEmptyObjects(shapedTree, "");

  // 6 — Rebuild the schemas. The patch is the derived patch (drops removed,
  // kinds original); the extraction schema is the shaped tree enveloped.
  const patchSchema = treeToZod(patchTree);
  const shapedSchema = treeToZod(shapedTree);

  // The provenance names top-level groups of the SHAPED schema — the same keys
  // the patch has, since nothing crosses a top-level boundary. `enveloped()`
  // re-validates with its own message; this one names the derivation.
  const shapeKeys = Object.keys(shapedSchema.shape);
  for (const key of Object.keys(provenance)) {
    if (!shapeKeys.includes(key)) {
      throw new Error(
        `deriveExtractionShape(): provenance names group "${key}", which is not a top-level ` +
          `property of the shaped schema (its groups are: ${shapeKeys.join(", ")}) — the ` +
          "group may have been dropped.",
      );
    }
  }
  const extractionSchema = enveloped(shapedSchema, { provenance });

  // 7 — Derive the mapping: every surviving patch leaf, moved through its
  // group's regroup and carrying its retype, keyed by where it lands in the
  // extraction space.
  const patchLeaves: string[] = [];
  collectLeafPaths(patchTree, "", patchLeaves);
  const leaves: Record<string, { source: string; retype?: Retype }> = {};
  for (const patchPath of patchLeaves) {
    const segments = patchPath.split(".");
    const top = segments[0]!;
    const moves = regroups.get(top);
    const extractionRest =
      moves === undefined ? segments.slice(1) : remapThroughMoves(segments.slice(1), moves);
    leaves[[top, ...extractionRest].join(".")] = {
      source: patchPath,
      ...(retypes.has(patchPath) ? { retype: { extraction: "number", patch: "string" } } : {}),
    };
  }
  const mapping: ShapeMapping = { leaves, provenance };

  // 8 — The declarations review and write need, validated against the derived
  // patch: every named group present, every named leaf survived the operations.
  const validateDeclaration = (
    declaration: Readonly<Record<string, readonly string[]>>,
    what: string,
  ): void => {
    for (const [group, leafNames] of Object.entries(declaration)) {
      const groupNode = resolveNode(patchTree, [group]);
      // A collection group's declarations name leaves of its element; a
      // top-level leaf group's declaration names the group key itself (the
      // same rule `RequiredOnCreate`'s `GroupLeafKey` applies).
      if (groupNode?.kind === "leaf") {
        if (leafNames.some((leafName) => leafName !== group)) {
          throw new Error(
            `deriveExtractionShape(): ${what} names leaves under group "${group}", which is ` +
              "itself a leaf — the only leaf it can name is its own key.",
          );
        }
        continue;
      }
      const element =
        groupNode?.kind === "array"
          ? groupNode.element
          : groupNode?.kind === "object"
            ? groupNode
            : undefined;
      if (element === undefined) {
        throw new Error(
          `deriveExtractionShape(): ${what} names group "${group}", which is not a group of ` +
            "the derived patch — it may name a dropped group, or nothing at all.",
        );
      }
      for (const leafName of leafNames) {
        if (!element.children.has(leafName)) {
          throw new Error(
            `deriveExtractionShape(): ${what} names leaf "${leafName}" under group "${group}", ` +
              "which the derived patch does not carry — it may name a dropped leaf.",
          );
        }
      }
    }
  };
  const requiredOnCreate = options.requiredOnCreate ?? {};
  const identifyingFields = options.identifyingFields ?? {};
  validateDeclaration(requiredOnCreate, "requiredOnCreate");
  validateDeclaration(identifyingFields, "identifyingFields");

  // 9 — Post-condition: the artifact relates its two schemas faithfully. The
  // applier builds the mapping from one walk, so this holds by construction —
  // which is exactly why it is worth asserting: a future edit that breaks the
  // invariant fails here instead of at review.
  assertShapeMapping(mapping, extractionSchema, patchSchema);

  return {
    extractionSchema,
    patchSchema,
    mapping,
    provenance,
    requiredOnCreate,
    identifyingFields,
  };
}

/**
 * Apply one group's moves to the shaped tree: validate the set, remove the
 * sources, insert the destinations — in that order, so no insertion order can
 * change the result.
 */
function applyRegroup(
  shapedTree: ObjectNode,
  drops: ReadonlyMap<string, string[]>,
  group: string,
  moves: ReadonlyMap<string, string>,
): void {
  const groupNode = shapedTree.children.get(group);
  if (groupNode === undefined) {
    throw new Error(
      `deriveExtractionShape(): regroup names group "${group}", which is not a top-level ` +
        "property of the schema (it may name a dropped group).",
    );
  }
  if (groupNode.kind === "leaf") {
    throw new Error(
      `deriveExtractionShape(): regroup on "${group}" has nothing to move — the group is a ` +
        "leaf, not a group of leaves.",
    );
  }
  // Moves live inside the element of a collection group.
  const element: ObjectNode = groupNode.kind === "array" ? groupNode.element : groupNode;

  const sources = [...moves.keys()].map((from) => ({
    from,
    segments: opSegments(from, "regroup source"),
  }));
  const destinations = [...moves.entries()].map(([from, to]) => ({
    from,
    to,
    segments: opSegments(to, "regroup destination"),
  }));

  for (const source of sources) {
    if (source.segments.length === 0) {
      throw new Error(
        `deriveExtractionShape(): regroup on "${group}" moves the group itself — a move's ` +
          "source and destination live below the group, never at it.",
      );
    }
    if (pathTouchesArray(element, source.segments)) {
      throw new Error(
        `deriveExtractionShape(): regroup on "${group}" moves "${source.from}", which passes ` +
          "through or lands on an array — a move may not cross a collection boundary, or one " +
          "extraction value would have to fill every element.",
      );
    }
    if (resolveNode(element, source.segments) === undefined) {
      throw new Error(
        `deriveExtractionShape(): regroup on "${group}" moves "${source.from}", which is not ` +
          "a path of the group.",
      );
    }
  }
  for (const a of sources) {
    for (const b of sources) {
      if (a.from !== b.from && isPrefixOf(a.segments, b.segments)) {
        throw new Error(
          `deriveExtractionShape(): regroup on "${group}" moves "${a.from}" and "${b.from}", ` +
            "one under the other — sources must not overlap.",
        );
      }
    }
  }

  // Destinations are validated after the sources are removed, so a destination
  // that frees a name by the removal is legal, and no destination may prefix
  // another or lie under a dropped path.
  for (const destination of destinations) {
    if (destination.segments.length === 0) {
      throw new Error(
        `deriveExtractionShape(): regroup on "${group}" moves "${destination.from}" onto the ` +
          "group itself — a move's destination lives below the group.",
      );
    }
    if (pathTouchesArray(element, destination.segments)) {
      throw new Error(
        `deriveExtractionShape(): regroup on "${group}" moves "${destination.from}" to a ` +
          "destination that passes through or lands on an array — a move may not cross a " +
          "collection boundary.",
      );
    }
    for (const [droppedPath, droppedSegments] of drops) {
      if (droppedPath.split(".")[0] !== group) continue;
      const droppedRest = droppedSegments.slice(1);
      if (
        isPrefixOf(droppedRest, destination.segments) ||
        isPrefixOf(destination.segments, droppedRest)
      ) {
        throw new Error(
          `deriveExtractionShape(): regroup on "${group}" moves "${destination.from}" across ` +
            `the dropped path "${droppedPath}" — a move may not resurrect or rehang what a ` +
            "drop removed.",
        );
      }
    }
  }
  for (const a of destinations) {
    for (const b of destinations) {
      if (a.from !== b.from && isPrefixOf(a.segments, b.segments)) {
        throw new Error(
          `deriveExtractionShape(): regroup on "${group}" moves "${a.from}" and "${b.from}" ` +
            "to destinations, one under the other — the insert order would decide the shape.",
        );
      }
    }
  }

  const removed = new Map<string, ShapeNode>();
  for (const source of sources) {
    removed.set(source.from, removeSubtree(element, source.segments));
  }
  for (const destination of destinations) {
    const moved = removed.get(destination.from);
    if (moved === undefined) {
      throw new Error(
        "deriveExtractionShape(): internal — a validated move source was not detached.",
      );
    }
    insertAt(element, destination.segments, moved);
  }
}

/** Remove and return the subtree at `segments` from its container. */
function removeSubtree(root: ObjectNode, segments: readonly string[]): ShapeNode {
  const resolved = resolveContainer(root, segments);
  const node = resolved?.container.children.get(resolved.key);
  if (resolved === undefined || node === undefined) {
    throw new Error("deriveExtractionShape(): internal — a validated move source vanished.");
  }
  resolved.container.children.delete(resolved.key);
  return node;
}

/** Insert `node` at `segments`, creating intermediate objects as needed. */
function insertAt(root: ObjectNode, segments: readonly string[], node: ShapeNode): void {
  let current: ShapeNode = root;
  for (const segment of segments.slice(0, -1)) {
    if (current.kind === "array") current = current.element;
    if (current.kind !== "object") {
      throw new Error(
        "deriveExtractionShape(): internal — a validated move destination ran under a leaf.",
      );
    }
    const next = current.children.get(segment);
    if (next === undefined) {
      const created: ObjectNode = { kind: "object", children: new Map(), strictness: "strip" };
      current.children.set(segment, created);
      current = created;
    } else {
      if (next.kind === "leaf") {
        throw new Error(
          "deriveExtractionShape(): internal — a validated move destination ran under a leaf.",
        );
      }
      current = next;
    }
  }
  if (current.kind === "array") current = current.element;
  const key = segments[segments.length - 1]!;
  if (current.kind !== "object" || current.children.has(key)) {
    throw new Error(
      "deriveExtractionShape(): internal — a validated move destination was not free.",
    );
  }
  current.children.set(key, node);
}
