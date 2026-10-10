import { assertObjectKeyPath } from "../extraction/shape/shape-mapping.js";
import { parseFieldPath } from "../provenance/field-path.js";
import type { FieldPath } from "../provenance/field-path.js";
import type {
  ReviewCollectionNode,
  ReviewLeafNode,
  ReviewNode,
  ReviewObjectNode,
  ReviewPlan,
} from "./review.js";

/**
 * @file Laying a review tree out by a shape plan — the pass behind
 * `BuildReviewRequestOptions.reviewPlan`.
 *
 * It runs after the schema walk, over the tree alone: it re-parents the nodes the walk built
 * and rebuilds no leaf, so a leaf inside a section is the same object `fields` holds at its
 * unchanged patch path, and `fields`, every `FieldPath` and `resolveReview` are untouched.
 *
 * `partitions` sections a top-level group's direct leaves; `mapping` moves leaves whose
 * extraction path differs from their patch path. The derivation refuses a partition and a
 * regroup on one group, so the two never meet in one container. A move never crosses a
 * collection boundary, so moves inside a collection are laid out per instance, relative to
 * the element. The extraction schema's declaration order is not in the plan, so the mapping's
 * enumeration order breaks every tie.
 */

/** The partition record's reserved part: the group's fields no part named. */
const REMAINDER_PART = "remainder";

/**
 * The catch-all section: the `remainder` part, a part the plan itself labels "Other", leaves
 * no mapping entry names, and nested subtrees. A section's label is a host's only handle on
 * it, so a part labelled "Other" folds in here rather than making a second one.
 */
const OTHER_LABEL = "Other";

/**
 * A review leaf's plan path: its object-key segments joined with dots. Plan records are
 * schema-time (`hvac.seer`, never `hvac[k1].seer`), so dropping instance segments is what lets
 * every instance of a collection read the same entries.
 */
const planPathOf = (path: FieldPath): string =>
  parseFieldPath(path)
    .flatMap((segment) => (segment.kind === "objectKey" ? [segment.key] : []))
    .join(".");

/**
 * Sections one group's — or one collection instance's — direct children by its partition
 * record: one section per part in the record's enumeration order, each part's leaves in its
 * field-list order, then "Other" for the no-topic parts' entries and every child nothing above
 * placed, in schema order. Only sections holding at least one child are emitted. A part entry
 * no derivation could produce (an unknown field, a non-leaf, a leaf another part claimed)
 * places nothing; the child falls through, so nothing is dropped or duplicated.
 */
const sectionGroupChildren = (
  children: readonly ReviewNode[],
  partition: Readonly<Record<string, readonly string[]>>,
  mappedSources: ReadonlySet<string>,
): ReviewNode[] => {
  const childAt = new Map<string, ReviewNode>();
  for (const child of children) {
    if (child.kind !== "section") childAt.set(child.key, child);
  }

  const placed = new Set<ReviewNode>();
  const sections: ReviewNode[] = [];
  for (const [label, fieldNames] of Object.entries(partition)) {
    if (label === REMAINDER_PART || label === OTHER_LABEL) continue;
    const sectionChildren: ReviewNode[] = [];
    for (const fieldName of fieldNames) {
      const child = childAt.get(fieldName);
      if (
        child === undefined ||
        placed.has(child) ||
        child.kind !== "leaf" ||
        !mappedSources.has(planPathOf(child.path))
      ) {
        continue;
      }
      placed.add(child);
      sectionChildren.push(child);
    }
    if (sectionChildren.length > 0) {
      sections.push({ kind: "section", label, children: sectionChildren });
    }
  }

  const otherChildren: ReviewNode[] = [];
  for (const [label, fieldNames] of Object.entries(partition)) {
    if (label !== REMAINDER_PART && label !== OTHER_LABEL) continue;
    for (const fieldName of fieldNames) {
      const child = childAt.get(fieldName);
      if (child === undefined || placed.has(child)) continue;
      placed.add(child);
      otherChildren.push(child);
    }
  }
  for (const child of children) {
    if (!placed.has(child)) otherChildren.push(child);
  }
  if (otherChildren.length > 0) {
    sections.push({ kind: "section", label: OTHER_LABEL, children: otherChildren });
  }
  return sections;
};

/**
 * The partition half: a partition names a top-level group, so only the top level is examined.
 * Every instance of a partitioned collection gets the same sections; unpartitioned groups pass
 * through untouched.
 */
const layOutByPartitions = (
  tree: readonly ReviewNode[],
  plan: ReviewPlan,
  mappedSources: ReadonlySet<string>,
): readonly ReviewNode[] =>
  tree.map((node) => {
    // The walk builds no sections, and a section has no key to look a partition up by.
    if (node.kind === "leaf" || node.kind === "section") return node;
    const partition = plan.partitions[node.key];
    if (partition === undefined) return node;
    if (node.kind === "object") {
      return { ...node, children: sectionGroupChildren(node.children, partition, mappedSources) };
    }
    return {
      ...node,
      instances: node.instances.map((instance) => ({
        ...instance,
        children: sectionGroupChildren(instance.children, partition, mappedSources),
      })),
    };
  });

/**
 * A section under construction. Placement grows these in place in mapping enumeration order;
 * {@link materializeDrafts} turns them into section nodes. The brand keeps a draft apart from a
 * finished node in a shared list.
 */
interface SectionDraft {
  readonly kind: "draft-section";
  readonly label: string;
  readonly children: (ReviewNode | SectionDraft)[];
}

/**
 * Where a moved leaf is being placed: a position in the patch structure (the scope's top or a
 * patch object node the chain joined), or an extraction-only section. Only a patch site can
 * join existing structure; below a section the patch declares nothing.
 */
type PlacementSite =
  | {
      readonly kind: "patch";
      readonly children: readonly ReviewNode[];
      readonly appended: (ReviewNode | SectionDraft)[];
    }
  | { readonly kind: "section"; readonly draft: SectionDraft };

/** A moved mapping entry: its extraction path and its patch source, both plan paths. */
type MovedEntry = readonly [extractionPath: string, source: string];

/**
 * Lift the leaves the plan moves out of their patch positions, collecting them by source.
 * Object nodes are rebuilt only along paths that lost a leaf; one left with no children is
 * recorded in `emptied`, so it can be dropped unless a placement joins it. Collections are
 * not entered: their moves are laid out per instance.
 */
const pruneMovedLeaves = (
  nodes: readonly ReviewNode[],
  movedSources: ReadonlySet<string>,
  prunedBySource: Map<string, ReviewLeafNode[]>,
  emptied: Set<ReviewObjectNode>,
): { readonly children: ReviewNode[]; readonly changed: boolean } => {
  const surviving: ReviewNode[] = [];
  let changed = false;
  for (const child of nodes) {
    if (child.kind === "leaf") {
      const source = planPathOf(child.path);
      if (movedSources.has(source)) {
        const pruned = prunedBySource.get(source);
        if (pruned === undefined) prunedBySource.set(source, [child]);
        else pruned.push(child);
        changed = true;
      } else {
        surviving.push(child);
      }
      continue;
    }
    if (child.kind === "object") {
      const inner = pruneMovedLeaves(child.children, movedSources, prunedBySource, emptied);
      if (!inner.changed) {
        surviving.push(child);
        continue;
      }
      const rebuilt: ReviewObjectNode = { ...child, children: inner.children };
      if (inner.children.length === 0) emptied.add(rebuilt);
      surviving.push(rebuilt);
      changed = true;
      continue;
    }
    surviving.push(child);
  }
  return { children: surviving, changed };
};

const sectionDraftNamed = (
  list: readonly (ReviewNode | SectionDraft)[],
  label: string,
): SectionDraft | undefined => {
  for (const node of list) {
    if (node.kind === "draft-section" && node.label === label) return node;
  }
  return undefined;
};

/**
 * One step along a moved leaf's placement chain. At a patch site, an object the patch already
 * declares under that name is joined; otherwise (and always below a section) a section draft
 * is found or created after the container's surviving children.
 */
const descendPlacement = (
  site: PlacementSite,
  name: string,
  appendedByNode: Map<ReviewObjectNode, (ReviewNode | SectionDraft)[]>,
): PlacementSite => {
  if (site.kind === "patch") {
    const objectChild = site.children.find(
      (child): child is ReviewObjectNode => child.kind === "object" && child.key === name,
    );
    if (objectChild !== undefined) {
      let appended = appendedByNode.get(objectChild);
      if (appended === undefined) {
        appended = [];
        appendedByNode.set(objectChild, appended);
      }
      return { kind: "patch", children: objectChild.children, appended };
    }
  }
  const list = site.kind === "patch" ? site.appended : site.draft.children;
  let draft = sectionDraftNamed(list, name);
  if (draft === undefined) {
    draft = { kind: "draft-section", label: name, children: [] };
    list.push(draft);
  }
  return { kind: "section", draft };
};

const materializeDrafts = (nodes: readonly (ReviewNode | SectionDraft)[]): ReviewNode[] =>
  nodes.map((node) =>
    node.kind === "draft-section"
      ? { kind: "section", label: node.label, children: materializeDrafts(node.children) }
      : node,
  );

/**
 * Splice placed children into a list of nodes: an object that received any is rebuilt with
 * them after its surviving children, an emptied object nothing joined is dropped, and
 * everything else passes through by identity.
 */
const withPlacedChildren = (
  nodes: readonly ReviewNode[],
  appendedByNode: ReadonlyMap<ReviewObjectNode, readonly (ReviewNode | SectionDraft)[]>,
  emptied: ReadonlySet<ReviewObjectNode>,
): ReviewNode[] =>
  nodes.flatMap((node): ReviewNode[] => {
    if (node.kind !== "object" && node.kind !== "section") return [node];
    const appended = node.kind === "object" ? appendedByNode.get(node) : undefined;
    if (node.kind === "object" && appended === undefined && emptied.has(node)) return [];
    const finished = withPlacedChildren(node.children, appendedByNode, emptied);
    if (
      appended === undefined &&
      finished.length === node.children.length &&
      finished.every((child, i) => child === node.children[i])
    ) {
      return [node];
    }
    return [{ ...node, children: [...finished, ...materializeDrafts(appended ?? [])] }];
  });

/**
 * Lay out the moves that belong to one scope — the tree's top level, or one collection
 * instance's children, where `prefix` is the collection's plan path. Placement chains are
 * read relative to the scope. `between` runs over the pruned nodes before placement (the
 * partition half, at the top level). Collections inside the result are then laid out per
 * instance.
 */
const layOutMoves = (
  nodes: readonly ReviewNode[],
  moved: readonly MovedEntry[],
  prefix: readonly string[],
  between: (nodes: readonly ReviewNode[]) => readonly ReviewNode[] = (n) => n,
): readonly ReviewNode[] => {
  const prefixText = prefix.length === 0 ? "" : `${prefix.join(".")}.`;
  const scoped = moved.filter(
    ([extractionPath, source]) =>
      extractionPath.startsWith(prefixText) && source.startsWith(prefixText),
  );
  if (scoped.length === 0) return between(nodes);

  const prunedBySource = new Map<string, ReviewLeafNode[]>();
  const emptied = new Set<ReviewObjectNode>();
  const movedSources = new Set(scoped.map(([, source]) => source));
  const pruned = between(pruneMovedLeaves(nodes, movedSources, prunedBySource, emptied).children);

  const appendedByNode = new Map<ReviewObjectNode, (ReviewNode | SectionDraft)[]>();
  const rootAppended: (ReviewNode | SectionDraft)[] = [];
  const placed = new Set<ReviewLeafNode>();
  for (const [extractionPath, source] of scoped) {
    // A source this scope cannot resolve is stale, or belongs to a collection below.
    const lifted = prunedBySource.get(source);
    if (lifted === undefined) continue;
    // The leaf keeps its own key, so the path's last segment positions nothing.
    const chain = parseFieldPath(extractionPath)
      .map((segment) => segment.key)
      .slice(prefix.length, -1);
    for (const node of lifted) {
      // Two entries naming one patch leaf: the first in enumeration order claims it.
      if (placed.has(node)) continue;
      placed.add(node);
      let site: PlacementSite = { kind: "patch", children: pruned, appended: rootAppended };
      for (const name of chain) site = descendPlacement(site, name, appendedByNode);
      if (site.kind === "patch") site.appended.push(node);
      else site.draft.children.push(node);
    }
  }

  const laidOut = [
    ...withPlacedChildren(pruned, appendedByNode, emptied),
    ...materializeDrafts(rootAppended),
  ];
  return laidOut.map((node) => layOutCollectionMoves(node, scoped));
};

/** Lay out each collection's per-instance moves, wherever the collection sits. */
const layOutCollectionMoves = (node: ReviewNode, moved: readonly MovedEntry[]): ReviewNode => {
  if (node.kind === "leaf") return node;
  if (node.kind === "object" || node.kind === "section") {
    const children = node.children.map((child) => layOutCollectionMoves(child, moved));
    return children.every((child, i) => child === node.children[i]) ? node : { ...node, children };
  }
  const prefix = planPathOf(node.path).split(".");
  const instances = node.instances.map((instance) => {
    const children = layOutMoves(instance.children, moved, prefix);
    return children === instance.children ? instance : { ...instance, children };
  });
  return instances.every((instance, i) => instance === node.instances[i])
    ? node
    : ({ ...node, instances } satisfies ReviewCollectionNode);
};

/**
 * Lay a walked tree out by a plan. Every mapping path is checked first: a path that is not
 * schema-time (empty, or carrying an instance segment) is not plan data any derivation
 * produces, so it throws rather than degrading. Entries naming nothing in the walked schema
 * are ignored.
 */
export const layOutTreeByPlan = (
  tree: readonly ReviewNode[],
  plan: ReviewPlan,
): readonly ReviewNode[] => {
  for (const [extractionPath, entry] of Object.entries(plan.mapping.leaves)) {
    assertObjectKeyPath(extractionPath, "extraction");
    assertObjectKeyPath(entry.source, "patch");
  }
  const mappedSources = new Set(Object.values(plan.mapping.leaves).map((entry) => entry.source));
  const moved: MovedEntry[] = Object.entries(plan.mapping.leaves)
    .filter(([extractionPath, entry]) => extractionPath !== entry.source)
    .map(([extractionPath, entry]) => [extractionPath, entry.source]);
  return layOutMoves(tree, moved, [], (nodes) => layOutByPartitions(nodes, plan, mappedSources));
};
