/**
 * @file The move machinery for the collecting applier: `regroup` and `nest`
 * validation and the tree mutations that commit an accepted operation.
 *
 * Each validator returns the FIRST defect the throwing applier would have
 * thrown for that operation — the checks run in the throwing applier's order,
 * so a single-defect operation carries a byte-identical message — classified
 * `local` (defective against the schema alone) or `consequential` (defective
 * only alongside an applied drop, which `cause` names). A regroup is atomic:
 * one refusal covers the whole operation, never half its moves.
 *
 * The commit half mutates: `applyRegroupOrRefuse` applies a valid regroup to
 * the shaped tree and returns `undefined`; `applyNestOperations` applies the
 * surviving nest set detach-all-then-insert-all, so a group named after a
 * leaf some nest moves away finds its name free whatever the order.
 */

import { childPath, parseFieldPath } from "../../provenance/field-path.js";
import type { ProvenanceGranularity } from "../../provenance/enveloped.js";

import type { ShapeOperation } from "./shape-operation.js";
import type { ShapeRefusalCause, ShapeRefusalClass } from "./shape-refusal.js";
import {
  cloneObjectNode,
  emptyObjectMessage,
  findEmptyObjects,
  isPrefixOf,
  pathTouchesArray,
  resolveContainer,
  resolveNode,
} from "./shape-tree.js";
import type { ObjectNode, ShapeNode } from "./shape-tree.js";

type DropOperation = Extract<ShapeOperation, { op: "drop" }>;
type RegroupOperation = Extract<ShapeOperation, { op: "regroup" }>;
type NestOperation = Extract<ShapeOperation, { op: "nest" }>;

/** A drop that survived every filter and was applied to the trees. */
export interface AppliedDrop {
  readonly path: string;
  readonly segments: readonly string[];
  readonly operation: DropOperation;
  readonly index: number;
}

/** The first defect a move operation carries, classified, with its culprit when consequential. */
export interface MoveFailure {
  readonly class: ShapeRefusalClass;
  readonly reason: string;
  readonly cause?: ShapeRefusalCause;
}

const failure = (cls: ShapeRefusalClass, reason: string, cause?: ShapeRefusalCause): MoveFailure =>
  cause === undefined ? { class: cls, reason } : { class: cls, reason, cause };

const operationCause = (drop: AppliedDrop): ShapeRefusalCause => ({
  kind: "operation",
  operation: drop.operation,
  index: drop.index,
});

/**
 * The applied drop whose path covers `segments` (a prefix, or the path
 * itself), if one exists. Applied drops are never nested — a nested drop is a
 * consequential refusal — so at most one covers.
 */
export const coveringDrop = (
  drops: readonly AppliedDrop[],
  segments: readonly string[],
): AppliedDrop | undefined => drops.find((drop) => isPrefixOf(drop.segments, segments));

/**
 * Parse an operation's dotted path into object-key segments. The failure
 * carries the message the throwing applier would raise — either the
 * plain-object-path refusal or `parseFieldPath`'s own (a key the path grammar
 * itself rejects) — verbatim.
 */
export const tryOpSegments = (
  path: string,
  what: string,
):
  | { readonly ok: true; readonly segments: string[] }
  | { readonly ok: false; readonly reason: string } => {
  let parsed: ReturnType<typeof parseFieldPath>;
  try {
    parsed = parseFieldPath(path);
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
  if (parsed.length === 0 || parsed.some((segment) => segment.kind !== "objectKey")) {
    return {
      ok: false,
      reason:
        `deriveExtractionShape(): the ${what} path "${path}" is not a plain dotted object path — ` +
        "schema-time paths have no instance keys (brackets address data-time instances).",
    };
  }
  return {
    ok: true,
    segments: parsed.map((segment) => (segment.kind === "objectKey" ? segment.key : "")),
  };
};

/** Validate and, when valid, commit one regroup to the shaped tree. */
export const applyRegroupOrRefuse = (
  shapedTree: ObjectNode,
  drops: readonly AppliedDrop[],
  operation: RegroupOperation,
): MoveFailure | undefined => {
  const group = operation.group;
  const moves = new Map(Object.entries(operation.moves));
  const groupNode = shapedTree.children.get(group);
  if (groupNode === undefined) {
    const cover = coveringDrop(drops, [group]);
    return failure(
      cover === undefined ? "local" : "consequential",
      `deriveExtractionShape(): regroup names group "${group}", which is not a top-level ` +
        "property of the schema — it may name a dropped group, or a group a nest creates " +
        "(regroups apply before nests, so a nest group does not exist yet).",
      cover === undefined ? undefined : operationCause(cover),
    );
  }
  if (groupNode.kind === "leaf") {
    return failure(
      "local",
      `deriveExtractionShape(): regroup on "${group}" has nothing to move — the group is a ` +
        "leaf, not a group of leaves.",
    );
  }
  // Moves live inside the element of a collection group.
  const element: ObjectNode = groupNode.kind === "array" ? groupNode.element : groupNode;

  const sources: { from: string; segments: string[] }[] = [];
  for (const from of moves.keys()) {
    const parsed = tryOpSegments(from, "regroup source");
    if (!parsed.ok) return failure("local", parsed.reason);
    sources.push({ from, segments: parsed.segments });
  }
  const destinations: { from: string; to: string; segments: string[] }[] = [];
  for (const [from, to] of moves) {
    const parsed = tryOpSegments(to, "regroup destination");
    if (!parsed.ok) return failure("local", parsed.reason);
    destinations.push({ from, to, segments: parsed.segments });
  }

  for (const source of sources) {
    if (pathTouchesArray(element, source.segments)) {
      return failure(
        "local",
        `deriveExtractionShape(): regroup on "${group}" moves "${source.from}", which passes ` +
          "through or lands on an array — a move may not cross a collection boundary, or one " +
          "extraction value would have to fill every element.",
      );
    }
    if (resolveNode(element, source.segments) === undefined) {
      const cover = coveringDrop(drops, [group, ...source.segments]);
      return failure(
        cover === undefined ? "local" : "consequential",
        `deriveExtractionShape(): regroup on "${group}" moves "${source.from}", which is not ` +
          "a path of the group.",
        cover === undefined ? undefined : operationCause(cover),
      );
    }
  }
  for (const a of sources) {
    for (const b of sources) {
      if (a.from !== b.from && isPrefixOf(a.segments, b.segments)) {
        return failure(
          "local",
          `deriveExtractionShape(): regroup on "${group}" moves "${a.from}" and "${b.from}", ` +
            "one under the other — sources must not overlap.",
        );
      }
    }
  }

  // Destinations are validated against the tree with the sources removed, so a
  // destination that frees a name by the removal is legal, and no destination
  // may prefix another or lie under a dropped path.
  for (const destination of destinations) {
    if (pathTouchesArray(element, destination.segments)) {
      return failure(
        "local",
        `deriveExtractionShape(): regroup on "${group}" moves "${destination.from}" to a ` +
          "destination that passes through or lands on an array — a move may not cross a " +
          "collection boundary.",
      );
    }
    for (const drop of drops) {
      if (drop.segments[0] !== group) continue;
      const droppedRest = drop.segments.slice(1);
      if (
        isPrefixOf(droppedRest, destination.segments) ||
        isPrefixOf(destination.segments, droppedRest)
      ) {
        return failure(
          "consequential",
          `deriveExtractionShape(): regroup on "${group}" moves "${destination.from}" across ` +
            `the dropped path "${drop.path}" — a move may not resurrect or rehang what a ` +
            "drop removed.",
          operationCause(drop),
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
        return failure(
          "local",
          `deriveExtractionShape(): regroup on "${group}" moves "${a.from}" and "${b.from}" ` +
            "to the same destination — one move's source would overwrite the other's, " +
            "and there is no insert order that keeps both.",
        );
      }
      if (isPrefixOf(a.segments, b.segments)) {
        return failure(
          "local",
          `deriveExtractionShape(): regroup on "${group}" moves "${a.from}" and "${b.from}" ` +
            "to destinations, one under the other — the insert order would decide the shape.",
        );
      }
    }
  }

  // The whole set is valid; simulate it on a clone to catch what the pairwise
  // checks cannot see — a sub-object the moves (possibly with the applied
  // drops' help) empty. A regroup is one operation: the refusal covers it all.
  const simulated = cloneObjectNode(element);
  const removed = new Map<string, ShapeNode>();
  for (const source of sources) {
    removed.set(source.from, removeSubtree(simulated, source.segments));
  }
  for (const destination of destinations) {
    const moved = removed.get(destination.from);
    if (moved === undefined) {
      throw new Error(
        "deriveExtractionShape(): internal — a validated move source was not detached.",
      );
    }
    insertAt(simulated, destination.segments, moved);
  }
  const emptiedHere: string[] = [];
  findEmptyObjects(simulated, groupNode.kind === "array" ? `${group}[]` : group, emptiedHere);
  const emptied = emptiedHere[0];
  if (emptied !== undefined) {
    // Moves cannot touch an array's interior, so the emptied path is always a
    // plain object path and drop segments compare against it directly.
    const emptiedSegments = emptied.split(".");
    const conspired = drops.some(
      (drop) =>
        drop.segments.length > emptiedSegments.length && isPrefixOf(emptiedSegments, drop.segments),
    );
    return failure(conspired ? "set" : "local", emptyObjectMessage(emptied));
  }

  // Commit: re-run the validated detach/insert on the real subtree (the
  // simulation proved it safe; `ObjectNode.children` is never reassigned).
  const committed = new Map<string, ShapeNode>();
  for (const source of sources) {
    committed.set(source.from, removeSubtree(element, source.segments));
  }
  for (const destination of destinations) {
    const moved = committed.get(destination.from);
    if (moved === undefined) {
      throw new Error(
        "deriveExtractionShape(): internal — a validated move source was not detached.",
      );
    }
    insertAt(element, destination.segments, moved);
  }
  return undefined;
};

/** The context a nest validates against — see the fixed point in the applier. */
export interface NestValidationContext {
  /** The shaped tree with drops, retypes and regroups applied; nests not yet. */
  readonly shapedTree: ObjectNode;
  readonly drops: readonly AppliedDrop[];
  /**
   * Top-level keys the CURRENT candidate nest set moves away. A nest group may
   * take one of these names (its own anchor leaf included); a name no
   * candidate frees stays occupied.
   */
  readonly freedBy: ReadonlySet<string>;
  /** The candidate group names in candidate order — for message previews. */
  readonly nestGroups: readonly string[];
  readonly provenance: Readonly<Record<string, ProvenanceGranularity>>;
}

/**
 * Validate one nest against the current candidate set. Writes nothing. The
 * checks run in the throwing applier's order; the group-name checks depend on
 * the candidate set, so the applier re-runs this as the set shrinks.
 */
export const validateNest = (
  operation: NestOperation,
  context: NestValidationContext,
): MoveFailure | undefined => {
  const { shapedTree, drops, freedBy, nestGroups, provenance } = context;
  const group = operation.group;
  const moves = new Map(Object.entries(operation.moves));

  // The group name becomes a top-level object key, under the same rules
  // `childPath` enforces on every path the review layer addresses.
  try {
    childPath("", group);
  } catch (cause) {
    return failure(
      "local",
      `deriveExtractionShape(): nest names group "${group}", which is not a usable ` +
        `top-level object key — ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  // A nest group may take a top-level name that some SURVIVING nest moves
  // away — its own anchor leaf, or another's. What it may not do is shadow a
  // key that stays: that would be two things at one path. Asked of the
  // candidate set, so the answer tracks which nests will actually apply.
  if (shapedTree.children.has(group) && !freedBy.has(group)) {
    return failure(
      "local",
      `deriveExtractionShape(): nest names group "${group}", which is already a top-level ` +
        "key of the schema and stays one — a nest may reuse a name only when some nest " +
        "moves that leaf away, freeing it.",
    );
  }
  const droppedName = drops.find((drop) => drop.segments.length === 1 && drop.path === group);
  if (droppedName !== undefined) {
    return failure(
      "consequential",
      `deriveExtractionShape(): nest names group "${group}", which a drop removed — a ` +
        "name the caller deliberately removed reappearing as a synthetic group is " +
        "confusing at review. Pick a new name.",
      operationCause(droppedName),
    );
  }

  const sources: { from: string; segments: string[] }[] = [];
  for (const from of moves.keys()) {
    const parsed = tryOpSegments(from, "nest source");
    if (!parsed.ok) return failure("local", parsed.reason);
    sources.push({ from, segments: parsed.segments });
  }
  const destinations: { from: string; to: string; segments: string[] }[] = [];
  for (const [from, to] of moves) {
    // The empty destination gets its own refusal below, naming the nest —
    // the path parser would blame brackets, which is not what is wrong.
    if (to === "") {
      destinations.push({ from, to, segments: [] });
      continue;
    }
    const parsed = tryOpSegments(to, "nest destination");
    if (!parsed.ok) return failure("local", parsed.reason);
    destinations.push({ from, to, segments: parsed.segments });
  }

  for (const source of sources) {
    if (source.segments.length !== 1) {
      return failure(
        "local",
        `deriveExtractionShape(): nest on "${group}" moves "${source.from}" — a nest source ` +
          "is one segment naming a top-level leaf of the schema; a nested path is regroup's " +
          "domain, not nest's.",
      );
    }
    const node = shapedTree.children.get(source.from);
    if (node === undefined) {
      const cover = coveringDrop(drops, [source.from]);
      return failure(
        cover === undefined ? "local" : "consequential",
        `deriveExtractionShape(): nest on "${group}" moves "${source.from}", which is not a ` +
          "top-level leaf of the schema (it may name a dropped path, or nothing at all).",
        cover === undefined ? undefined : operationCause(cover),
      );
    }
    if (node.kind !== "leaf") {
      return failure(
        "local",
        `deriveExtractionShape(): nest on "${group}" moves "${source.from}", which is a ` +
          `${node.kind === "array" ? "collection" : "group"}, not a top-level leaf — a nest ` +
          'moves leaves; nesting a whole group is a different operation (its "row" span ' +
          "would have nowhere to land under the new top-level key).",
      );
    }
  }

  for (const destination of destinations) {
    if (destination.to === "") {
      return failure(
        "local",
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
        return failure(
          "local",
          `deriveExtractionShape(): nest on "${group}" moves "${a.from}" and "${b.from}" ` +
            "to the same destination — one move's source would overwrite the other's, " +
            "and there is no insert order that keeps both.",
        );
      }
      if (isPrefixOf(a.segments, b.segments)) {
        return failure(
          "local",
          `deriveExtractionShape(): nest on "${group}" moves "${a.from}" and "${b.from}" ` +
            "to destinations, one under the other — the insert order would decide the shape.",
        );
      }
    }
  }

  // A declaration is the caller's invariant; the nest is the revisable input.
  // A granularity naming a moved leaf names nothing at the shaped top level,
  // so the nest takes the refusal — with the name freed again, "none" on the
  // leaf is legal.
  for (const from of moves.keys()) {
    if (Object.hasOwn(provenance, from)) {
      const shapeKeys = [...shapedTree.children.keys()]
        .filter((key) => !freedBy.has(key))
        .concat(nestGroups);
      return failure(
        "consequential",
        `deriveExtractionShape(): provenance names group "${from}", which is not a top-level ` +
          `property of the shaped schema (its groups are: ${shapeKeys.join(", ")}) — the ` +
          "group may have been dropped, or moved into a nest group.",
        { kind: "declaration", declaration: "provenance", group: from },
      );
    }
  }

  return undefined;
};

/**
 * Commit the surviving nest set: detach EVERY source from the root, then
 * create every group and insert. One nest at a time the result would depend
 * on order — a nest group may take a name another nest frees — so the applier
 * owns the ordering and no caller can observe it. Pre-validated; a parse
 * failure here is an internal invariant breach.
 */
export const applyNestOperations = (
  shapedTree: ObjectNode,
  nests: readonly NestOperation[],
): void => {
  const plans: { group: string; from: string; segments: string[] }[] = [];
  for (const operation of nests) {
    for (const [from, to] of Object.entries(operation.moves)) {
      const parsed = tryOpSegments(to, "nest destination");
      if (!parsed.ok) {
        throw new Error(
          "deriveExtractionShape(): internal — a validated nest destination failed to parse.",
        );
      }
      plans.push({ group: operation.group, from, segments: parsed.segments });
    }
  }
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
};

/** Remove and return the subtree at `segments` from its container. */
export const removeSubtree = (root: ObjectNode, segments: readonly string[]): ShapeNode => {
  const resolved = resolveContainer(root, segments);
  const node = resolved?.container.children.get(resolved.key);
  if (resolved === undefined || node === undefined) {
    throw new Error("deriveExtractionShape(): internal — a validated move source vanished.");
  }
  resolved.container.children.delete(resolved.key);
  return node;
};

/** Insert `node` at `segments`, creating intermediate objects as needed. */
export const insertAt = (root: ObjectNode, segments: readonly string[], node: ShapeNode): void => {
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
};
