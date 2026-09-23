/**
 * @file The derivation entry point: `deriveExtractionShape`, its options, and
 * the operation-application helpers (`opSegments`, `remapThroughMoves`,
 * `applyRegroup` with `removeSubtree` and `insertAt`).
 *
 * The operation set itself — the vocabulary and the composition rule it is
 * validated against — is documented in `shape-operation.ts`; the plain node
 * tree the operations run over, and the zod rebuild, live in `shape-tree.ts`.
 * This module owns the applier's state machine: bucket the operations, apply
 * them to the tree, derive the mapping back, and verify the artifact against
 * itself.
 */

import { z } from "zod";

import { enveloped, childPath, parseFieldPath, stripOptionalNullable } from "@azx/ribo-core";
import type { ProvenanceGranularity } from "@azx/ribo-core";

import type { DerivedExtractionShape } from "./derived-shape.js";
import type { ShapeOperation } from "./shape-operation.js";
import {
  buildObjectNode,
  cloneObjectNode,
  collectLeafPaths,
  isPrefixOf,
  pathTouchesArray,
  refuseEmptyObjects,
  resolveContainer,
  resolveNode,
  treeToZod,
} from "./shape-tree.js";
import type { ObjectNode, ShapeNode } from "./shape-tree.js";
import { assertShapeMapping } from "./shape-mapping.js";
import type { Retype, ShapeMapping } from "./shape-mapping.js";

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
  const nests = new Map<string, Map<string, string>>();
  // Inverted index of every nest's moves, for the mapping derivation — and
  // for refusing a source two nests both claim.
  const nestBySource = new Map<string, { group: string; destination: string }>();
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
    } else if (operation.op === "nest") {
      if (nests.has(operation.group)) {
        throw new Error(
          `deriveExtractionShape(): nest names group "${operation.group}" twice — ` +
            "merge the moves into one operation.",
        );
      }
      const moves = new Map(Object.entries(operation.moves));
      if (moves.size === 0) {
        // A regroup with no moves is a no-op; a nest cannot be — it CREATES
        // its group, so an empty move set would leave the refusal to
        // `refuseEmptyObjects`, which names the wrong thing.
        throw new Error(
          `deriveExtractionShape(): nest names group "${operation.group}" with an empty ` +
            "moves record — a nest creates its target, so name at least one top-level " +
            "leaf to move into it.",
        );
      }
      nests.set(operation.group, moves);
      for (const [from, destination] of moves) {
        const claimed = nestBySource.get(from);
        if (claimed !== undefined) {
          throw new Error(
            `deriveExtractionShape(): nests "${claimed.group}" and "${operation.group}" both ` +
              `move "${from}" — a source may be moved by at most one nest.`,
          );
        }
        nestBySource.set(from, { group: operation.group, destination });
      }
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
          "(it may name a dropped path, a group, a leaf a nest will create — retype names " +
          "PATCH paths, which a nest never renames — or nothing at all).",
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
  // Nests apply after the regroups. A nest source is a top-level leaf, which
  // no regroup can produce or consume, so the two operations' domains are
  // disjoint and the order is immaterial.
  applyNests(shapedTree, drops, nests, nestBySource);

  // 5 — Refuse any object either tree emptied.
  refuseEmptyObjects(patchTree, "");
  refuseEmptyObjects(shapedTree, "");

  // 6 — Rebuild the schemas. The patch is the derived patch (drops removed,
  // kinds original); the extraction schema is the shaped tree enveloped.
  const patchSchema = treeToZod(patchTree);
  const shapedSchema = treeToZod(shapedTree);

  // The provenance names top-level groups of the SHAPED schema — and every key
  // must ALSO be a top-level key of the patch, because `mapping.provenance` is
  // applied to both schemas (here, and at the combinator's construction over
  // the patch). A nest group exists in the extraction schema only, so a
  // granularity naming one is refused: without this, "row"/"none" would fail
  // late and mis-blamed at the post-condition (a boundary message that never
  // mentions the nest), and an explicit "leaf" would fail a layer away from
  // the author, inside `enveloped(patchSchema, …)` at the combinator's
  // construction. The refusal buys an earlier failure with the right blame.
  const shapeKeys = Object.keys(shapedSchema.shape);
  for (const key of Object.keys(provenance)) {
    if (nests.has(key)) {
      throw new Error(
        `deriveExtractionShape(): provenance names group "${key}", which a nest creates — ` +
          "the group exists in the extraction schema only, while `mapping.provenance` is " +
          'applied to both schemas. A nest group is "leaf"-granular, always.',
      );
    }
    if (!shapeKeys.includes(key)) {
      throw new Error(
        `deriveExtractionShape(): provenance names group "${key}", which is not a top-level ` +
          `property of the shaped schema (its groups are: ${shapeKeys.join(", ")}) — the ` +
          "group may have been dropped, or moved into a nest group.",
      );
    }
  }
  const extractionSchema = enveloped(shapedSchema, { provenance });

  // 7 — Derive the mapping: every surviving patch leaf, moved through its
  // group's regroup or the nest that claims it and carrying its retype, keyed
  // by where it lands in the extraction space. A nested leaf — a top-level
  // patch leaf by construction — keys its entry at `<nest group>.<destination>`.
  const patchLeaves: string[] = [];
  collectLeafPaths(patchTree, "", patchLeaves);
  const leaves: Record<string, { source: string; retype?: Retype }> = {};
  for (const patchPath of patchLeaves) {
    const nested = nestBySource.get(patchPath);
    if (nested !== undefined) {
      leaves[`${nested.group}.${nested.destination}`] = {
        source: patchPath,
        ...(retypes.has(patchPath) ? { retype: { extraction: "number", patch: "string" } } : {}),
      };
      continue;
    }
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
        "property of the schema — it may name a dropped group, or a group a nest creates " +
        "(regroups apply before nests, so a nest group does not exist yet).",
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
      if (a.from === b.from) continue;
      if (
        a.segments.length === b.segments.length &&
        a.segments.every((segment, i) => segment === b.segments[i])
      ) {
        throw new Error(
          `deriveExtractionShape(): regroup on "${group}" moves "${a.from}" and "${b.from}" ` +
            "to the same destination — one move's source would overwrite the other's, " +
            "and there is no insert order that keeps both.",
        );
      }
      if (isPrefixOf(a.segments, b.segments)) {
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

/**
 * Apply EVERY nest, in three passes over the whole set: validate, then detach
 * every source from the root, then create every group and insert.
 *
 * One pass per nest would make the result depend on iteration order, because a
 * nest group may take a name that a nest move frees: whether that name is still
 * occupied when a given nest runs would decide between success and a collision.
 * The operations are a SET, so the applier owns the ordering and no caller can
 * observe it.
 *
 * A group may take a freed name because `regroup` already works that way — its
 * destinations are validated after its sources are removed, "so a destination
 * that frees a name by the removal is legal". A live proposer run made the case
 * concrete: asked to shape a flat vendor schema, the model named each group
 * after the leaf that anchors it (`pool`, holding `pool`, `poolSize`,
 * `poolPumpType` …). That is the natural naming, and it was the only one of
 * fourteen proposed nests the applier refused.
 *
 * The moved nodes are detached from the shaped tree's ROOT and re-hung under a
 * brand-new object; the patch tree is never touched — a nest exists only in the
 * extraction space.
 */
function applyNests(
  shapedTree: ObjectNode,
  drops: ReadonlyMap<string, string[]>,
  nests: ReadonlyMap<string, ReadonlyMap<string, string>>,
  nestBySource: ReadonlyMap<string, { group: string; destination: string }>,
): void {
  const plans: { group: string; from: string; segments: string[] }[] = [];
  for (const [group, moves] of nests) {
    plans.push(...planOneNest(shapedTree, drops, nestBySource, group, moves));
  }
  // Every source is detached before any group is created, so a group named
  // after a leaf some nest moves away finds its name free whatever the order.
  const removed = new Map<string, ShapeNode>();
  for (const plan of plans) {
    removed.set(plan.from, removeSubtree(shapedTree, [plan.from]));
  }
  for (const plan of plans) {
    const moved = removed.get(plan.from);
    if (moved === undefined) {
      throw new Error(
        "deriveExtractionShape(): internal — a validated move source was not detached.",
      );
    }
    insertAt(shapedTree, [plan.group, ...plan.segments], moved);
  }
}

/** Validate one nest and return its moves as insert plans. Writes nothing. */
function planOneNest(
  shapedTree: ObjectNode,
  drops: ReadonlyMap<string, string[]>,
  nestBySource: ReadonlyMap<string, { group: string; destination: string }>,
  group: string,
  moves: ReadonlyMap<string, string>,
): { group: string; from: string; segments: string[] }[] {
  // The group name becomes a top-level object key, under the same rules
  // `childPath` enforces on every path the review layer addresses. Checked
  // here, attributed to the nest: left to `enveloped()`, the same bad name
  // would throw from inside the envelope walk with the operation invisible.
  try {
    childPath("", group);
  } catch (cause) {
    throw new Error(
      `deriveExtractionShape(): nest names group "${group}", which is not a usable ` +
        `top-level object key — ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  // A nest group may take a top-level name that SOME nest moves away — its own
  // (`pool` holding `pool`, `poolSize`, …) or another's. What it may not do is
  // shadow a key that survives to the extraction schema, which would be two
  // things at one path. Asked of `nestBySource` rather than of the tree, so the
  // answer does not depend on how many nests have run yet.
  if (shapedTree.children.has(group) && !nestBySource.has(group)) {
    throw new Error(
      `deriveExtractionShape(): nest names group "${group}", which is already a top-level ` +
        "key of the schema and stays one — a nest may reuse a name only when some nest " +
        "moves that leaf away, freeing it.",
    );
  }
  for (const [droppedPath, droppedSegments] of drops) {
    if (droppedSegments.length === 1 && droppedPath === group) {
      throw new Error(
        `deriveExtractionShape(): nest names group "${group}", which a drop removed — a ` +
          "name the caller deliberately removed reappearing as a synthetic group is " +
          "confusing at review. Pick a new name.",
      );
    }
  }

  const sources = [...moves.keys()].map((from) => ({
    from,
    segments: opSegments(from, "nest source"),
  }));
  const destinations = [...moves.entries()].map(([from, to]) => ({
    from,
    to,
    // The empty destination gets its own refusal below, naming the nest —
    // `opSegments("")` would blame brackets, which is not what is wrong.
    segments: to === "" ? [] : opSegments(to, "nest destination"),
  }));

  for (const source of sources) {
    if (source.segments.length !== 1) {
      throw new Error(
        `deriveExtractionShape(): nest on "${group}" moves "${source.from}" — a nest source ` +
          "is one segment naming a top-level leaf of the schema; a nested path is regroup's " +
          "domain, not nest's.",
      );
    }
    const node = shapedTree.children.get(source.from);
    if (node === undefined) {
      throw new Error(
        `deriveExtractionShape(): nest on "${group}" moves "${source.from}", which is not a ` +
          "top-level leaf of the schema (it may name a dropped path, or nothing at all).",
      );
    }
    if (node.kind !== "leaf") {
      throw new Error(
        `deriveExtractionShape(): nest on "${group}" moves "${source.from}", which is a ` +
          `${node.kind === "array" ? "collection" : "group"}, not a top-level leaf — a nest ` +
          'moves leaves; nesting a whole group is a different operation (its "row" span ' +
          "would have nowhere to land under the new top-level key).",
      );
    }
  }

  for (const destination of destinations) {
    if (destination.to === "") {
      throw new Error(
        `deriveExtractionShape(): nest on "${group}" moves "${destination.from}" to an empty ` +
          "destination — the destination is the leaf's path below the new group.",
      );
    }
  }
  for (const a of destinations) {
    for (const b of destinations) {
      if (a.from === b.from) continue;
      if (
        a.segments.length === b.segments.length &&
        a.segments.every((segment, i) => segment === b.segments[i])
      ) {
        throw new Error(
          `deriveExtractionShape(): nest on "${group}" moves "${a.from}" and "${b.from}" ` +
            "to the same destination — one move's source would overwrite the other's, " +
            "and there is no insert order that keeps both.",
        );
      }
      if (isPrefixOf(a.segments, b.segments)) {
        throw new Error(
          `deriveExtractionShape(): nest on "${group}" moves "${a.from}" and "${b.from}" ` +
            "to destinations, one under the other — the insert order would decide the shape.",
        );
      }
    }
  }

  // Nothing here can collide: the group's interior starts empty and the
  // destinations were just pairwise validated. The caller detaches and inserts.
  return destinations.map((destination) => ({
    group,
    from: destination.from,
    segments: destination.segments,
  }));
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
