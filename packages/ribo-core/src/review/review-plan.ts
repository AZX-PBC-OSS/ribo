import { parseFieldPath } from "../provenance/field-path.js";
import type { FieldPath } from "../provenance/field-path.js";
import type { ReviewLeafNode, ReviewNode, ReviewObjectNode, ReviewPlan } from "./review.js";

/**
 * @file Laying a review tree out by a shape plan — the pass behind
 * `BuildReviewRequestOptions.reviewPlan`.
 *
 * The walk in `review.ts` presents leaves in schema-declaration order, and that
 * order is a contract (`ReviewFields`). A plan asks for a different
 * *presentation* of the same leaves, so this pass runs after the walk, over the
 * tree alone: it re-parents the nodes the walk built and rebuilds no leaf, so a
 * leaf inside a section is the same object `fields` holds at its unchanged patch
 * path — the tree stays "a second view, never a second source". `fields`, every
 * `FieldPath` and `resolveReview` are untouched by construction.
 *
 * The plan's two records each drive one half of the layout:
 *
 * - **`partitions`** sections a group's direct leaves — one labelled section per
 *   part, "Other" last ({@link layOutByPartitions}).
 * - **`mapping`** positions every leaf in extraction space. An entry whose two
 *   sides disagree is a move: the leaf is lifted out of its patch position and
 *   placed where its extraction path puts it — descending the path's
 *   intermediate groups, joining the patch's own object nodes where they exist
 *   and getting a labelled section where they do not (a regroup's
 *   extraction-only intermediates); a new top-level group rendering as a
 *   top-level section (a nest). Partition sections and regroup placements never
 *   meet in one container because the derivation refuses a partition and a
 *   regroup naming the same group; the layout relies on that rather than
 *   re-checking it. Regroup placements arise only in singleton groups for the
 *   same reason the derivation guarantees it — no move crosses a collection
 *   boundary — so this pass treats collections as opaque.
 *
 * Order comes only from the plan's records and the walked schema: the
 * extraction schema's own declaration order is unrecoverable from the plan, so
 * the mapping's enumeration order breaks every tie. Moved leaves are placed in
 * enumeration order; sections and moved-in leaves append after the surviving
 * patch children of their container; several top-level sections follow it.
 *
 * The plan is read as plain public data, the way every other consumer reads it —
 * no validation pass runs here, and none can: asserting the mapping's MEANING
 * needs the extraction schema, which the plan type deliberately does not carry.
 * The one thing asserted is the one thing the paths' own text decides — their
 * shape ({@link assertSchemaTimePath}): a plan path that is not schema-time
 * data is not producible, and fails loudly before anything reads an entry. A
 * plan entry naming a group or field the walked schema lacks — a well-formed
 * name that resolves to nothing — is ignored, no throw, no report — and the
 * exactly-once invariant is kept by construction: a moved leaf is pruned before
 * it is placed, so it lands exactly once wherever the plan puts it, and a leaf
 * no entry resolves to keeps its patch position. A section's label is the only
 * handle a host has on it, so the outline never repeats one: a part the plan
 * itself labels "Other" folds into the fixed catch-all section of that name.
 */

/** The partition record's reserved part: the group's fields no part named. */
const REMAINDER_PART = "remainder";

/**
 * The fixed label of the catch-all section — the plan's `remainder` part, any
 * part the plan itself labels "Other", every leaf the plan left unmapped, and
 * whole unnamed subtrees collect under it. To a reviewer these are all simply
 * fields with no topic. Minted here and nowhere else — which is why a part
 * labeled "Other" folds into this section rather than emitting one of its own:
 * two sections under one label would be indistinguishable to a host, whose only
 * handle on a section is its label.
 */
const OTHER_LABEL = "Other";

/**
 * A review leaf's plan path: its object-key segments joined with dots.
 *
 * The plan's records are schema-time data — `hvac.seer`, never `hvac[k1].seer` —
 * while a review path carries an instance segment per collection instance.
 * Stripping them over {@link parseFieldPath} is what makes every instance of a
 * collection read the same plan entries, and so get the same sections.
 */
const planPathOf = (path: FieldPath): string =>
  parseFieldPath(path)
    .flatMap((segment) => (segment.kind === "objectKey" ? [segment.key] : []))
    .join(".");

/**
 * Refuse a plan path that is not a plain dotted object-key path — on either
 * side of a mapping entry, before anything reads it.
 *
 * Both sides of an entry are schema-time paths: the derivation asserts exactly
 * this shape for every key and source at construction, and the layout may meet
 * the grammar only here, since a plan arrives as plain data with nothing
 * upstream to have validated it. So the layout re-asserts the shape before
 * interpreting any of it — UNCONDITIONALLY about the path's shape, ahead of
 * every rule that reads an entry's meaning: a data-time path (`hvac[k1].seer`)
 * or an empty one is not plan data the derivation can produce, whatever its
 * source resolves to, and the loud failure is what that input deserves — never
 * a quiet degrade that lets a corrupt plan pass as a presentational mismatch.
 * `parseFieldPath`'s own refusals (a doubled dot, an unclosed bracket) are the
 * grammar's and propagate untouched; this adds the two the shared grammar
 * cannot carry — the same parser also reads review paths, which legally hold
 * instance segments, and it reads `""` as no segments at all.
 */
const assertSchemaTimePath = (path: string, side: "extraction" | "patch"): void => {
  const segments = parseFieldPath(path);
  if (segments.length === 0 || segments.some((segment) => segment.kind !== "objectKey")) {
    throw new Error(
      `review plan: the ${side} path "${path}" is not a plain dotted object path — ` +
        "schema-time paths are non-empty object keys joined with dots; brackets hold " +
        "data-time instance keys, which a plan's paths never carry.",
    );
  }
};

/**
 * Sections one group's — or one collection instance's — direct children by that
 * group's partition record, re-parenting the given nodes.
 *
 * Order is the plan's, read as enumeration order: one section per part, in the
 * partition record's label enumeration order — integer-like labels enumerate
 * first, ascending, which is specified ECMAScript property order, not an engine
 * quirk to work around — and each section's leaves in that part's field-list
 * order. The parts that declare no topic — the reserved `remainder` part and a
 * part the plan itself labeled "Other" — get no section of their own: their
 * entries join the "Other" section, read in the record's enumeration order and
 * each list's own order, followed by every child nothing above placed, in
 * schema-declaration order — the only order left, since an unplaced child has no
 * plan entry to take an order from. A section is emitted only when it would hold
 * at least one child.
 *
 * What lands in "Other": those two parts' entries; a leaf no mapping entry's
 * `source` names (the plan left it without a topic); and every non-leaf child —
 * a nested object or collection the walked schema declares under the group — as
 * a whole subtree, patch structure preserved. A part entry naming a field the
 * walked group lacks, a part naming a non-leaf, and two parts naming one leaf
 * are each an object no derivation can produce; every one of them degrades by
 * placing nothing — the child they name falls through to the rules above — never
 * by dropping or duplicating a child.
 */
const sectionGroupChildren = (
  children: readonly ReviewNode[],
  partition: Readonly<Record<string, readonly string[]>>,
  mappedSources: ReadonlySet<string>,
): ReviewNode[] => {
  const childAt = new Map<string, ReviewNode>();
  for (const child of children) {
    // A walked tree holds no section nodes — this pass is what creates them —
    // and a section has no key to look up besides.
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
 * The partition half of the layout: a partition names a TOP-LEVEL group, so only
 * the tree's top level is examined. A partitioned object group's children, and
 * every instance of a partitioned collection's children, are replaced by
 * {@link sectionGroupChildren}'s sections — every instance of a collection
 * getting the same sections, the plan carrying nothing instance-specific. Nodes
 * the plan does not partition pass through untouched — a group with no partition
 * shows its fields unsectioned, exactly as without a plan.
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
 * A section still under construction — the placement pass grows these in place,
 * in the plan's mapping enumeration order, and the materialize pass turns each
 * into a real {@link ReviewSectionNode}. The `kind` is a brand no `ReviewNode`
 * carries, so a draft is distinguishable from a finished node wherever the two
 * share a list.
 */
interface SectionDraft {
  readonly kind: "draft-section";
  readonly label: string;
  readonly children: (ReviewNode | SectionDraft)[];
}

/**
 * Where a moved leaf is being placed: either a position in the patch structure —
 * the tree's top level, or a patch object node the placement chain joined — or
 * an extraction-only section draft. A patch site is the only kind that can JOIN
 * existing structure: below a section is extraction space, where the patch
 * declares nothing.
 */
interface PatchSite {
  readonly kind: "patch";
  readonly children: readonly ReviewNode[];
  readonly appended: (ReviewNode | SectionDraft)[];
}

interface SectionSite {
  readonly kind: "section";
  readonly draft: SectionDraft;
}

type PlacementSite = PatchSite | SectionSite;

/**
 * Lift every leaf the plan moves out of its patch position, collecting the
 * lifted nodes by the mapping `source` that names them.
 *
 * Only leaves moved BY THE PLAN are lifted: a leaf is lifted when some moved
 * entry's `source` is its plan path, and the two sides of that entry disagree —
 * `movedSources` is exactly the set of such sources. Object nodes are rebuilt
 * (as spreads of themselves) only along paths that lost a leaf, so a group the
 * plan does not move anything out of keeps the walk's own node; collections are
 * opaque — a move may not cross a collection boundary, so an entry whose source
 * is element-relative is stale data whose leaves keep their per-instance patch
 * positions and resolve to nothing to place.
 */
const pruneMovedLeaves = (
  nodes: readonly ReviewNode[],
  movedSources: ReadonlySet<string>,
  prunedBySource: Map<string, ReviewLeafNode[]>,
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
      const inner = pruneMovedLeaves(child.children, movedSources, prunedBySource);
      surviving.push(inner.changed ? { ...child, children: inner.children } : child);
      changed = changed || inner.changed;
      continue;
    }
    surviving.push(child);
  }
  return { children: surviving, changed };
};

/**
 * A moved entry's placement chain: the object-key segments of its extraction
 * path minus the leaf's own name — the intermediate groups the extraction space
 * wraps that leaf in. The leaf node keeps its patch key, so the extraction
 * path's last segment positions nothing; one segment total means the extraction
 * space puts the leaf directly at the top level, and the chain is empty.
 *
 * The driver has asserted every mapping path's shape before the placement runs
 * ({@link assertSchemaTimePath}), so this parse cannot fail and the projection
 * below is total over the keys it meets.
 */
const placementChain = (extractionPath: string): readonly string[] =>
  parseFieldPath(extractionPath)
    .map((segment) => segment.key)
    .slice(0, -1);

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
 * One step along a moved leaf's placement chain, from the current container to
 * the one the chain's next intermediate names.
 *
 * At a patch site the plan's intermediate can be REAL structure: when the patch
 * schema already declares an object at this position, the leaf joins that object
 * node and no section is created for it. Otherwise — and always below a section,
 * which is extraction space the patch declares nothing in — the step finds or
 * creates a section draft, appended after the container's surviving patch
 * children.
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

/**
 * Turn the placement pass's drafts into real section nodes. A draft's children
 * mix finished nodes (leaves placed into it) and nested drafts, so the
 * conversion recurses; everything else is already what the tree holds.
 */
const materializeDrafts = (nodes: readonly (ReviewNode | SectionDraft)[]): ReviewNode[] =>
  nodes.map((node) =>
    node.kind === "draft-section"
      ? { kind: "section", label: node.label, children: materializeDrafts(node.children) }
      : node,
  );

/**
 * Splice the placement pass's appended children into the tree, returning the
 * nodes that changed and passing through — by identity — those that did not.
 *
 * A patch object node that received a moved-in leaf (or a section under it)
 * rebuilds as a spread of itself with the appended children materialized AFTER
 * its surviving patch children; the same for the tree's top level, which the
 * caller completes with the root's own appended children — the top-level
 * sections, after the patch's own top-level nodes. Collections pass through:
 * placements join object nodes only, so no appended list can hang on an
 * instance, and a collection's interior never held a moved leaf to begin with.
 */
const withPlacedChildren = (
  node: ReviewNode,
  appendedByNode: ReadonlyMap<ReviewObjectNode, readonly (ReviewNode | SectionDraft)[]>,
): ReviewNode => {
  if (node.kind !== "object" && node.kind !== "section") return node;
  const appended = node.kind === "object" ? appendedByNode.get(node) : undefined;
  const finished = node.children.map((child) => withPlacedChildren(child, appendedByNode));
  if (appended === undefined && finished.every((child, i) => child === node.children[i])) {
    return node;
  }
  return {
    ...node,
    children: [...finished, ...materializeDrafts(appended ?? [])],
  };
};

/**
 * Lay a walked tree out by a plan: the step `buildReviewRequest` runs between
 * the schema walk and the returned request whenever a plan was passed.
 *
 * The partition half ({@link layOutByPartitions}) runs alone when no mapping
 * entry moves a leaf — a plan whose `mapping` only ever names each leaf at
 * home. Otherwise the pass runs in three steps over the mapping's moved
 * entries, in its enumeration order: the moved leaves are lifted from their
 * patch positions ({@link pruneMovedLeaves}), the partition half runs over what
 * survives, and each lifted leaf is placed at the position its extraction path
 * names — descending the path's intermediate groups from the top level, joining
 * the patch's own object nodes where they exist and creating labelled sections
 * where they do not. A collection node's state, empty quote, skip flag and
 * per-instance structure survive wherever sections appear around or inside it.
 * Retypes never act — the reviewer edits the real value through the patch
 * schema's type.
 */
export const layOutTreeByPlan = (
  tree: readonly ReviewNode[],
  plan: ReviewPlan,
): readonly ReviewNode[] => {
  const mappedSources = new Set(Object.values(plan.mapping.leaves).map((entry) => entry.source));

  // The grammar rule runs FIRST, over both sides of every entry, before
  // anything reads an entry's meaning — before a source resolves to a leaf for
  // the placement's stale rule to consider, and before the moved filter below
  // decides what this pass walks at all (a partition-only plan takes the early
  // return, and the rule governs there too). A path's shape is not a
  // presentation question: a bracketed or empty path is not plan data the
  // derivation can produce, and the loud failure is the only honest answer to
  // it.
  for (const [extractionPath, entry] of Object.entries(plan.mapping.leaves)) {
    assertSchemaTimePath(extractionPath, "extraction");
    assertSchemaTimePath(entry.source, "patch");
  }

  // The leaves the plan MOVES: mapping entries whose two sides disagree, read
  // in enumeration order — the only order the plan carries, and so the order
  // every placement, section and top-level section below takes.
  const movedEntries = Object.entries(plan.mapping.leaves).filter(
    ([extractionPath, entry]) => extractionPath !== entry.source,
  );
  if (movedEntries.length === 0) return layOutByPartitions(tree, plan, mappedSources);

  const movedSources = new Set(movedEntries.map(([, entry]) => entry.source));
  const prunedBySource = new Map<string, ReviewLeafNode[]>();
  const pruned = pruneMovedLeaves(tree, movedSources, prunedBySource).children;
  const partitioned = layOutByPartitions(pruned, plan, mappedSources);

  const appendedByNode = new Map<ReviewObjectNode, (ReviewNode | SectionDraft)[]>();
  const rootAppended: (ReviewNode | SectionDraft)[] = [];
  const placed = new Set<ReviewLeafNode>();
  for (const [extractionPath, entry] of movedEntries) {
    const lifted = prunedBySource.get(entry.source);
    // A source the walked schema cannot resolve is stale plan data: the entry
    // places nothing and no section is created for it.
    if (lifted === undefined) continue;
    const chain = placementChain(extractionPath);
    for (const node of lifted) {
      // Two moved entries naming one patch leaf is a broken bijection — plan
      // data no derivation produces. First in enumeration order claims it.
      if (placed.has(node)) continue;
      placed.add(node);
      let site: PlacementSite = { kind: "patch", children: partitioned, appended: rootAppended };
      for (const name of chain) site = descendPlacement(site, name, appendedByNode);
      if (site.kind === "patch") site.appended.push(node);
      else site.draft.children.push(node);
    }
  }

  return [
    ...partitioned.map((node) => withPlacedChildren(node, appendedByNode)),
    ...materializeDrafts(rootAppended),
  ];
};
