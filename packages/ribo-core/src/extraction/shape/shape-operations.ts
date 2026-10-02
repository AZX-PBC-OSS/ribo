/**
 * @file The derivation entry points: `deriveExtractionShapePartially` — the
 * collecting applier — and `deriveExtractionShape`, a thin wrapper over it
 * that throws the canonically-first refusal.
 *
 * The operation set itself — the vocabulary and the composition rule it is
 * validated against — is documented in `shape-operation.ts`; the plain node
 * tree the operations run over, and the zod rebuild, live in `shape-tree.ts`;
 * the refusal record and its canonical order live in `shape-refusal.ts`; the
 * regroup/nest validators and the tree mutations live in `shape-moves.ts`.
 * This module owns the applier's state machine: a fixed sequence of
 * COLLECTING passes — bucket, drops, retypes, partitions, regroups, nests,
 * declarations, build — each validating declaratively and recording refusals
 * rather than throwing at the first one, so a repair turn sees every refusal
 * in one pass and the surviving operations still produce an artifact.
 *
 * The pass order is load-bearing. Drops are final before anything else
 * validates: declaration and provenance conflicts refuse the DROP (the
 * declaration is the caller's invariant, the operation the revisable input),
 * then the emptiness filter and the nesting walk — so a consequential refusal
 * always names a cause that actually applied, and a drop refused for
 * emptiness or for a declaration revives the retype or move under it. Nests
 * alone need a bounded iteration: a nest group may take a name another nest
 * frees, so a refused nest can un-free a sibling's name — the nest set is
 * re-validated until it stabilizes, which is monotone and bounded by the
 * nest count, not a fixpoint over batches.
 *
 * The hard boundary stays hard: defects of the SCHEMA (scalar arrays, unions,
 * records, a pre-existing empty object) and declaration defects no applied
 * operation explains still abort the derivation outright — no operation
 * subset repairs them, so no partial artifact can exist.
 */

import { z } from "zod";

import { enveloped } from "../../provenance/enveloped.js";
import { stripOptionalNullable } from "../../provenance/field-path.js";
import type { ProvenanceGranularity } from "../../provenance/enveloped.js";

import type { DerivedExtractionShape } from "./derived-shape.js";
import type { ShapeOperation } from "./shape-operation.js";
import type {
  PartiallyDerivedShape,
  ShapeRefusal,
  ShapeRefusalCause,
  ShapeRefusalClass,
} from "./shape-refusal.js";
import { compareShapeRefusals } from "./shape-refusal.js";
import {
  buildObjectNode,
  cloneObjectNode,
  collectLeafPaths,
  emptyObjectMessage,
  findEmptyObjects,
  isPrefixOf,
  resolveContainer,
  resolveNode,
  treeToZod,
} from "./shape-tree.js";
import {
  applyNestOperations,
  applyRegroupOrRefuse,
  coveringDrop,
  tryOpSegments,
  validateNest,
} from "./shape-moves.js";
import type { AppliedDrop, MoveFailure } from "./shape-moves.js";
import { assertShapeMapping } from "./shape-mapping.js";
import type { Retype, ShapeMapping } from "./shape-mapping.js";

/** Options for {@link deriveExtractionShape} and {@link deriveExtractionShapePartially}. */
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

type DropOperation = Extract<ShapeOperation, { op: "drop" }>;
type RetypeOperation = Extract<ShapeOperation, { op: "retype" }>;
type RegroupOperation = Extract<ShapeOperation, { op: "regroup" }>;
type NestOperation = Extract<ShapeOperation, { op: "nest" }>;
type PartitionOperation = Extract<ShapeOperation, { op: "partition" }>;

/** One operation tracked through the passes, with its position in the caller's array. */
interface Candidate<O extends ShapeOperation> {
  readonly operation: O;
  readonly index: number;
}

type DropCandidate = Candidate<DropOperation> & { readonly segments: readonly string[] };

/** "twice" for the pinned two-occurrence messages, a numeral past that. */
const timesText = (count: number): string => (count === 2 ? "twice" : `${count} times`);

const bump = (map: Map<string, number>, key: string): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
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
 * Derive the extraction shape from the caller's schema, applying the
 * operations that survive and reporting every refusal found in one pass.
 *
 * Synchronous and model-free: the operations are explicit data. The result
 * carries both halves — `shape`, a full {@link DerivedExtractionShape} built
 * from the surviving operations, and `refusals`, the sorted refusal list —
 * and the two partition the input exactly: every operation is applied or
 * refused, never silently dropped. `refusals` is empty if and only if the
 * artifact is exactly what `deriveExtractionShape` would return; the two are
 * the same code path, so equivalence is by construction. The applier never
 * silently produces a smaller shape.
 *
 * What still throws: the hard boundary a refusal list cannot repair — schema
 * defects (scalar arrays, unions, records, a pre-existing empty object) and
 * caller declarations no applied operation explains. An error at derivation,
 * where the schema author is present, beats the same failure at extraction.
 */
export function deriveExtractionShapePartially(
  schema: z.ZodObject,
  options: DeriveExtractionShapeOptions = {},
): PartiallyDerivedShape {
  const operations = options.operations ?? [];
  const provenance = options.provenance ?? {};
  const requiredOnCreate = options.requiredOnCreate ?? {};
  const identifyingFields = options.identifyingFields ?? {};

  const refusals: ShapeRefusal[] = [];
  const refuse = (
    operation: ShapeOperation,
    index: number,
    refusalClass: ShapeRefusalClass,
    reason: string,
    cause?: ShapeRefusalCause,
  ): void => {
    refusals.push(
      cause === undefined
        ? { operation, index, class: refusalClass, reason }
        : { operation, index, class: refusalClass, reason, cause },
    );
  };

  // 1 — Normalize the caller's schema into patch form, refusing what the
  // pipeline cannot serve (scalar arrays, unions, records) at the path — and
  // a pre-existing empty object. Schema defects are the hard boundary: no
  // operation subset repairs them, so the derivation aborts.
  const patchTree = buildObjectNode(schema, "");
  refuseEmptyObjectsHard(patchTree);

  // 2 — Bucket the operations. Every path is parsed once; duplicates are
  // refused set-wise (a duplicated drop or retype is redundancy — one instance
  // applies — while duplicate regroups or nests carry two move sets and are
  // not mergeable, so all of them are refused). Every operation leaves this
  // pass either a candidate or carrying a refusal.
  const dropCount = new Map<string, number>();
  const retypeCount = new Map<string, number>();
  const regroupCount = new Map<string, number>();
  const nestCount = new Map<string, number>();
  const partitionCount = new Map<string, number>();
  for (const operation of operations) {
    if (operation.op === "drop") bump(dropCount, operation.path);
    else if (operation.op === "retype") bump(retypeCount, operation.path);
    else if (operation.op === "regroup") bump(regroupCount, operation.group);
    else if (operation.op === "partition") bump(partitionCount, operation.group);
    else bump(nestCount, operation.group);
  }

  const dropCandidates: DropCandidate[] = [];
  const retypeCandidates: Candidate<RetypeOperation>[] = [];
  let regroupCandidates: Candidate<RegroupOperation>[] = [];
  let nestCandidates: Candidate<NestOperation>[] = [];
  let partitionCandidates: Candidate<PartitionOperation>[] = [];
  const dropSeen = new Set<string>();
  const retypeSeen = new Set<string>();
  for (const [index, operation] of operations.entries()) {
    if (operation.op === "drop") {
      const count = dropCount.get(operation.path)!;
      if (count > 1) {
        if (dropSeen.has(operation.path)) {
          refuse(
            operation,
            index,
            "set",
            `deriveExtractionShape(): drop names "${operation.path}" ${timesText(count)}.`,
          );
          continue;
        }
        dropSeen.add(operation.path);
      }
      const parsed = tryOpSegments(operation.path, "drop");
      if (!parsed.ok) {
        refuse(operation, index, "local", parsed.reason);
        continue;
      }
      dropCandidates.push({ operation, index, segments: parsed.segments });
    } else if (operation.op === "retype") {
      const count = retypeCount.get(operation.path)!;
      if (count > 1) {
        if (retypeSeen.has(operation.path)) {
          refuse(
            operation,
            index,
            "set",
            `deriveExtractionShape(): retype names "${operation.path}" ${timesText(count)}.`,
          );
          continue;
        }
        retypeSeen.add(operation.path);
      }
      if (operation.to !== "number") {
        // Unreachable for a TS caller (`to` is the literal "number"); a JS
        // caller passing anything else gets the construction-time refusal.
        refuse(
          operation,
          index,
          "local",
          `deriveExtractionShape(): retype to "${String(operation.to)}" at "${operation.path}" ` +
            'is outside the closed set — the only member is string→number ("to": "number").',
        );
        continue;
      }
      retypeCandidates.push({ operation, index });
    } else if (operation.op === "regroup") {
      const count = regroupCount.get(operation.group)!;
      if (count > 1) {
        refuse(
          operation,
          index,
          "set",
          `deriveExtractionShape(): regroup names group "${operation.group}" ${timesText(count)} — ` +
            "merge the moves into one operation.",
        );
        continue;
      }
      regroupCandidates.push({ operation, index });
    } else if (operation.op === "partition") {
      const count = partitionCount.get(operation.group)!;
      if (count > 1) {
        refuse(
          operation,
          index,
          "set",
          `deriveExtractionShape(): partition names group "${operation.group}" ${timesText(count)} — ` +
            "merge the parts into one operation.",
        );
        continue;
      }
      partitionCandidates.push({ operation, index });
    } else {
      const count = nestCount.get(operation.group)!;
      if (count > 1) {
        refuse(
          operation,
          index,
          "set",
          `deriveExtractionShape(): nest names group "${operation.group}" ${timesText(count)} — ` +
            "merge the moves into one operation.",
        );
        continue;
      }
      if (Object.keys(operation.moves).length === 0) {
        // A regroup with no moves is a no-op; a nest cannot be — it CREATES
        // its group, so an empty move set would leave the refusal to the
        // emptiness check, which names the wrong thing.
        refuse(
          operation,
          index,
          "local",
          `deriveExtractionShape(): nest names group "${operation.group}" with an empty ` +
            "moves record — a nest creates its target, so name at least one top-level " +
            "leaf to move into it.",
        );
        continue;
      }
      nestCandidates.push({ operation, index });
    }
  }

  // A top-level leaf may be moved by at most one nest. The conflict belongs to
  // the claiming set, not to either nest — every claimant is refused, the
  // group pair named in canonical order so the message does not depend on
  // input order.
  const nestClaimants = new Map<string, Candidate<NestOperation>[]>();
  for (const candidate of nestCandidates) {
    for (const from of Object.keys(candidate.operation.moves)) {
      const claimants = nestClaimants.get(from);
      if (claimants === undefined) nestClaimants.set(from, [candidate]);
      else claimants.push(candidate);
    }
  }
  const contestedSources = new Set<string>();
  for (const [from, claimants] of nestClaimants) {
    if (claimants.length > 1) contestedSources.add(from);
  }
  if (contestedSources.size > 0) {
    const surviving: Candidate<NestOperation>[] = [];
    for (const candidate of nestCandidates) {
      const contested = Object.keys(candidate.operation.moves).find((from) =>
        contestedSources.has(from),
      );
      if (contested === undefined) {
        surviving.push(candidate);
        continue;
      }
      const groups = nestClaimants
        .get(contested)!
        .map((claimant) => claimant.operation.group)
        .sort();
      refuse(
        candidate.operation,
        candidate.index,
        "set",
        groups.length === 2
          ? `deriveExtractionShape(): nests "${groups[0]}" and "${groups[1]}" both move ` +
              `"${contested}" — a source may be moved by at most one nest.`
          : `deriveExtractionShape(): nests ${groups.map((name) => `"${name}"`).join(", ")} ` +
              `all move "${contested}" — a source may be moved by at most one nest.`,
      );
    }
    nestCandidates = surviving;
  }

  // 3 — Drops, declaratively: a drop is applied iff its path exists in the
  // schema, it covers no caller declaration, it empties no object together
  // with the other applied drops, and no applied drop's path properly
  // contains it. Computed set-wise against the pristine tree, so the split
  // does not depend on input order (a sequential mutating walk applied both
  // of `drop "a.b"` + `drop "a"` in one order and threw not-found in the
  // other — a live violation of the set contract).
  //
  // Existence — against the pristine tree.
  let dropsAlive: DropCandidate[] = [];
  for (const candidate of dropCandidates) {
    const resolved = resolveContainer(patchTree, candidate.segments);
    if (resolved === undefined || !resolved.container.children.has(resolved.key)) {
      refuse(
        candidate.operation,
        candidate.index,
        "local",
        `deriveExtractionShape(): drop names "${candidate.operation.path}", which is not a ` +
          "path of the schema.",
      );
    } else {
      dropsAlive.push(candidate);
    }
  }

  // Declaration and provenance coverage — the throwing surface's check order:
  // provenance first, then requiredOnCreate, then identifyingFields. The
  // declaration is the caller's invariant; the drop is the revisable input,
  // so the drop takes the refusal and the leaf is restored.
  //
  // The provenance message names the shaped schema's top-level keys; computed
  // from the blamed drop's perspective (the keys a set WITH the surviving
  // drops would have), which is what the throwing surface's message reflects.
  const shapedTopsPreview = [...patchTree.children.keys()].filter(
    (key) => !dropsAlive.some((drop) => drop.segments.length === 1 && drop.operation.path === key),
  );
  const coveringDeclaration = (
    drop: DropCandidate,
  ): { reason: string; cause: ShapeRefusalCause } | undefined => {
    for (const key of Object.keys(provenance)) {
      if (drop.operation.path === key) {
        return {
          reason:
            `deriveExtractionShape(): provenance names group "${key}", which is not a ` +
            `top-level property of the shaped schema (its groups are: ${shapedTopsPreview.join(", ")}) — ` +
            "the group may have been dropped, or moved into a nest group.",
          cause: { kind: "declaration", declaration: "provenance", group: key },
        };
      }
    }
    const declarations: [
      "requiredOnCreate" | "identifyingFields",
      Readonly<Record<string, readonly string[]>>,
    ][] = [
      ["requiredOnCreate", requiredOnCreate],
      ["identifyingFields", identifyingFields],
    ];
    for (const [what, declaration] of declarations) {
      for (const [group, leafNames] of Object.entries(declaration)) {
        if (drop.operation.path === group) {
          return {
            reason:
              `deriveExtractionShape(): ${what} names group "${group}", which is not a group of ` +
              "the derived patch — it may name a dropped group, or nothing at all.",
            cause: { kind: "declaration", declaration: what, group },
          };
        }
        const groupNode = resolveNode(patchTree, [group]);
        for (const leafName of leafNames) {
          // A collection group's declarations name leaves of its element; a
          // top-level leaf group's declaration names the group key itself.
          const leafPath =
            groupNode?.kind === "leaf" && leafName === group ? group : `${group}.${leafName}`;
          const leafSegments = tryOpSegments(leafPath, `${what} leaf`);
          if (!leafSegments.ok) continue;
          if (isPrefixOf(drop.segments, leafSegments.segments)) {
            return {
              reason:
                `deriveExtractionShape(): ${what} names leaf "${leafName}" under group "${group}", ` +
                "which the derived patch does not carry — it may name a dropped leaf.",
              cause: { kind: "declaration", declaration: what, group, leaf: leafName },
            };
          }
        }
      }
    }
    return undefined;
  };
  {
    const surviving: DropCandidate[] = [];
    for (const candidate of dropsAlive) {
      const conflict = coveringDeclaration(candidate);
      if (conflict !== undefined) {
        refuse(
          candidate.operation,
          candidate.index,
          "consequential",
          conflict.reason,
          conflict.cause,
        );
      } else {
        surviving.push(candidate);
      }
    }
    dropsAlive = surviving;
  }

  // Emptiness — computed set-wise on a scratch tree: apply every surviving
  // drop, find every object that would empty, and refuse every drop
  // at-or-under one. No single one of them is at fault, and picking a
  // survivor would silently reorder the model's intent; symmetric blame over
  // maximality, deliberately. With the conspiring drops refused, the parent's
  // leaves are restored.
  {
    const scratch = cloneObjectNode(patchTree);
    for (const candidate of dropsAlive) {
      const resolved = resolveContainer(scratch, candidate.segments);
      // A nested drop is subsumed by its covering drop in the scratch — the
      // union of the deletions is what emptiness is computed over.
      if (resolved === undefined || !resolved.container.children.has(resolved.key)) continue;
      resolved.container.children.delete(resolved.key);
    }
    const emptied: string[] = [];
    findEmptyObjects(scratch, "", emptied);
    if (emptied.length > 0) {
      const emptiedSegments = emptied.map((path) => (path === "" ? [] : path.split(".")));
      const surviving: DropCandidate[] = [];
      for (const candidate of dropsAlive) {
        const culprit = emptiedSegments.find((segments) =>
          isPrefixOf(segments, candidate.segments),
        );
        if (culprit !== undefined) {
          refuse(
            candidate.operation,
            candidate.index,
            "set",
            emptyObjectMessage(culprit.join(".")),
          );
        } else {
          surviving.push(candidate);
        }
      }
      dropsAlive = surviving;
    }
  }

  // Nesting — outermost-first (fewest segments, then lexicographic), so a
  // drop nested under an applied drop is a consequential refusal naming the
  // covering drop: the same not-found rule the composition rule states, now
  // order-independent.
  const appliedDrops: AppliedDrop[] = [];
  const outermostFirst = [...dropsAlive].sort(
    (a, b) =>
      a.segments.length - b.segments.length || a.operation.path.localeCompare(b.operation.path),
  );
  for (const candidate of outermostFirst) {
    const cover = appliedDrops.find(
      (applied) =>
        applied.segments.length < candidate.segments.length &&
        isPrefixOf(applied.segments, candidate.segments),
    );
    if (cover !== undefined) {
      refuse(
        candidate.operation,
        candidate.index,
        "consequential",
        `deriveExtractionShape(): drop names "${candidate.operation.path}", which is not a ` +
          "path of the schema.",
        { kind: "operation", operation: cover.operation, index: cover.index },
      );
    } else {
      appliedDrops.push({
        path: candidate.operation.path,
        segments: candidate.segments,
        operation: candidate.operation,
        index: candidate.index,
      });
    }
  }
  for (const drop of appliedDrops) {
    // Existence was validated against the pristine tree, and a drop whose
    // container was itself dropped is a consequential refusal above — the
    // container cannot vanish here.
    const resolved = resolveContainer(patchTree, drop.segments)!;
    resolved.container.children.delete(resolved.key);
  }

  // 4 — Clone for the shaped tree, then retypes against the final drop set.
  // (The clone shares leaf NODES, so a retype REPLACES the node in its
  // container rather than mutating it — the patch tree keeps the kind the
  // caller declared.)
  const shapedTree = cloneObjectNode(patchTree);
  const appliedRetypes = new Map<string, "number">();
  for (const candidate of retypeCandidates) {
    const path = candidate.operation.path;
    const parsed = tryOpSegments(path, "retype");
    if (!parsed.ok) {
      refuse(candidate.operation, candidate.index, "local", parsed.reason);
      continue;
    }
    const resolved = resolveContainer(shapedTree, parsed.segments);
    const node = resolved?.container.children.get(resolved.key);
    if (resolved === undefined || node === undefined || node.kind !== "leaf") {
      const cover = coveringDrop(appliedDrops, parsed.segments);
      refuse(
        candidate.operation,
        candidate.index,
        cover === undefined ? "local" : "consequential",
        `deriveExtractionShape(): retype names "${path}", which is not a leaf of the schema ` +
          "(it may name a dropped path, a group, a leaf a nest will create — retype names " +
          "PATCH paths, which a nest never renames — or nothing at all).",
        cover === undefined
          ? undefined
          : { kind: "operation", operation: cover.operation, index: cover.index },
      );
      continue;
    }
    const inner = stripOptionalNullable(node.leaf);
    if (!(inner instanceof z.ZodString)) {
      refuse(
        candidate.operation,
        candidate.index,
        "local",
        `deriveExtractionShape(): retype at "${path}" needs a string patch leaf — the closed ` +
          `set is string→number only, and this leaf's kind is ${inner.constructor.name}. ` +
          "A retype whose source kind is outside the closed set has no canonical inverse.",
      );
      continue;
    }
    const description = inner.description;
    const number_ = description === undefined ? z.number() : z.number().describe(description);
    resolved.container.children.set(resolved.key, {
      kind: "leaf",
      leaf: number_.nullable().optional(),
    });
    appliedRetypes.set(path, "number");
  }

  // 5 — Partitions meet regroups before either pass runs: a shared group is a
  // set conflict (both refused), and the regroup must not apply — it would
  // restructure the very tree the partition's validation reads, and a refused
  // operation may not leave its effect behind.
  {
    const partitionGroups = new Set(partitionCandidates.map((c) => c.operation.group));
    const conflictedRegroups = regroupCandidates.filter((c) =>
      partitionGroups.has(c.operation.group),
    );
    if (conflictedRegroups.length > 0) {
      const conflictGroups = new Set(conflictedRegroups.map((c) => c.operation.group));
      const conflictedPartitions = partitionCandidates.filter((c) =>
        conflictGroups.has(c.operation.group),
      );
      regroupCandidates = regroupCandidates.filter((c) => !conflictGroups.has(c.operation.group));
      partitionCandidates = partitionCandidates.filter(
        (c) => !conflictGroups.has(c.operation.group),
      );
      const reason = (group: string): string =>
        `deriveExtractionShape(): partition and regroup both name group "${group}" — ` +
        "the group's paths would mean two things; partition a group no regroup restructures.";
      for (const candidate of conflictedRegroups) {
        refuse(candidate.operation, candidate.index, "set", reason(candidate.operation.group));
      }
      for (const candidate of conflictedPartitions) {
        refuse(candidate.operation, candidate.index, "set", reason(candidate.operation.group));
      }
    }
  }

  // 6 — Regroups, one refusal unit per operation, never per move within it.
  // Disjoint groups are disjoint subtrees, so the order between groups cannot
  // change the result; input order is kept.
  const appliedRegroups = new Map<string, Map<string, string>>();
  for (const candidate of regroupCandidates) {
    const failure = applyRegroupOrRefuse(shapedTree, appliedDrops, candidate.operation);
    if (failure !== undefined) {
      refuse(candidate.operation, candidate.index, failure.class, failure.reason, failure.cause);
    } else {
      appliedRegroups.set(
        candidate.operation.group,
        new Map(Object.entries(candidate.operation.moves)),
      );
    }
  }

  // 7 — Nests: the one pass that iterates. A nest group may take a name
  // another nest frees, so a nest that fails un-frees a sibling's name —
  // re-validate until the candidate set stabilizes. Removal only shrinks the
  // freed-name set, so failures grow monotonically and the loop settles in at
  // most one round per nest; the greatest fixed point does not depend on
  // evaluation order.
  for (;;) {
    const freedBy = new Set<string>();
    for (const candidate of nestCandidates) {
      for (const from of Object.keys(candidate.operation.moves)) freedBy.add(from);
    }
    const round = new Map<Candidate<NestOperation>, MoveFailure>();
    for (const candidate of nestCandidates) {
      const failure = validateNest(candidate.operation, {
        shapedTree,
        drops: appliedDrops,
        freedBy,
        nestGroups: nestCandidates.map((c) => c.operation.group),
        provenance,
      });
      if (failure !== undefined) round.set(candidate, failure);
    }
    if (round.size === 0) break;
    for (const [candidate, failure] of round) {
      refuse(candidate.operation, candidate.index, failure.class, failure.reason, failure.cause);
    }
    nestCandidates = nestCandidates.filter((candidate) => !round.has(candidate));
  }
  const appliedNests = new Map<string, Map<string, string>>();
  const appliedNestBySource = new Map<string, { group: string; destination: string }>();
  for (const candidate of nestCandidates) {
    appliedNests.set(candidate.operation.group, new Map(Object.entries(candidate.operation.moves)));
    for (const [from, destination] of Object.entries(candidate.operation.moves)) {
      appliedNestBySource.set(from, { group: candidate.operation.group, destination });
    }
  }
  applyNestOperations(
    shapedTree,
    nestCandidates.map((candidate) => candidate.operation),
  );

  // 8 — Partitions, validated against the settled shaped tree. The group must
  // be the caller's own — present, an object group or collection, never a
  // nest's creation — at a granularity whose span one call can carry, and its
  // parts must name the group's direct leaves without overlap. A partition is
  // atomic: the first defect refuses the whole operation, as a regroup's does.
  // A survivor writes its group's record — the caller's parts, plus a
  // "remainder" part holding the group's unnamed direct properties in
  // declaration order, so nothing goes unextracted — and nothing else changes:
  // the schemas and the mapping are the partition-free derivation's.
  const partitions: Record<string, Record<string, readonly string[]>> = {};
  const validatePartition = (operation: PartitionOperation): MoveFailure | undefined => {
    const group = operation.group;
    if (appliedNests.has(group)) {
      return {
        class: "local",
        reason:
          `deriveExtractionShape(): partition names group "${group}", which a nest creates — ` +
          "partition addresses the caller's own groups; a nest group's layout is the " +
          "nest's to choose.",
      };
    }
    const groupNode = shapedTree.children.get(group);
    if (groupNode === undefined) {
      // A dropped group is the drop's doing — name it, as a dropped field does.
      const cover = coveringDrop(appliedDrops, [group]);
      return {
        class: cover === undefined ? "local" : "consequential",
        reason:
          `deriveExtractionShape(): partition names group "${group}", which is not a top-level ` +
          "property of the schema — it may name a dropped group, or nothing at all.",
        ...(cover === undefined
          ? {}
          : {
              cause: {
                kind: "operation",
                operation: cover.operation,
                index: cover.index,
              } as ShapeRefusalCause,
            }),
      };
    }
    if (groupNode.kind === "leaf") {
      return {
        class: "local",
        reason:
          `deriveExtractionShape(): partition names group "${group}", which is a top-level leaf — ` +
          "a partition cuts an object group's or a collection's fields, and a leaf would " +
          "ride the split's loose portion, silently ignored.",
      };
    }
    const element = groupNode.kind === "array" ? groupNode.element : groupNode;
    const granularity = provenance[group];
    if (granularity === "row" || granularity === "none") {
      return {
        class: "consequential",
        reason:
          `deriveExtractionShape(): partition names group "${group}", whose provenance is ` +
          `"${granularity}" — a "${granularity}" group's span cannot be shared across the ` +
          "parts' calls.",
        cause: { kind: "declaration", declaration: "provenance", group },
      };
    }
    const parts = Object.entries(operation.parts);
    if (parts.length === 0) {
      return {
        class: "local",
        reason:
          `deriveExtractionShape(): partition names group "${group}" with an empty parts ` +
          "record — name at least one part, or drop the operation.",
      };
    }
    const seenLabels = new Set<string>();
    const seenFields = new Map<string, string>();
    for (const [label, fields] of parts) {
      if (label === "") {
        return {
          class: "local",
          reason:
            `deriveExtractionShape(): partition on group "${group}" has an empty part label — ` +
            "name each part, so its calls can say what they cover.",
        };
      }
      if (label === "remainder") {
        return {
          class: "local",
          reason:
            `deriveExtractionShape(): partition on group "${group}" uses the reserved label ` +
            `"remainder" — the group's unnamed fields take it automatically; pick another label.`,
        };
      }
      // Unreachable through a record — an object cannot carry a key twice —
      // but the rule is the record's contract, so the applier states it.
      if (seenLabels.has(label)) {
        return {
          class: "local",
          reason:
            `deriveExtractionShape(): partition on group "${group}" names part "${label}" ` +
            "twice — labels are unique within a group.",
        };
      }
      seenLabels.add(label);
      if (fields.length === 0) {
        return {
          class: "local",
          reason:
            `deriveExtractionShape(): partition on group "${group}" has part "${label}" with ` +
            "no fields — a part without fields extracts nothing; drop the part or name its fields.",
        };
      }
      let fieldDefect: MoveFailure | undefined;
      for (const field of fields) {
        const firstPart = seenFields.get(field);
        if (firstPart !== undefined) {
          fieldDefect = {
            class: "local",
            reason:
              `deriveExtractionShape(): partition on group "${group}" names field "${field}" ` +
              `in parts "${firstPart}" and "${label}" — a field is extracted in at most one part.`,
          };
          break;
        }
        seenFields.set(field, label);
        const parsed = tryOpSegments(field, "partition field");
        if (!parsed.ok) {
          fieldDefect = { class: "local", reason: parsed.reason };
          break;
        }
        if (parsed.segments.length !== 1) {
          fieldDefect = {
            class: "local",
            reason:
              `deriveExtractionShape(): partition on group "${group}" names field "${field}" — ` +
              "a partition field is one segment naming a direct property of the group (its " +
              "element's, for a collection); the split cuts a group's properties, not inside them.",
          };
          break;
        }
        const child = element.children.get(parsed.segments[0]!);
        if (child === undefined) {
          const cover = coveringDrop(appliedDrops, [group, parsed.segments[0]!]);
          fieldDefect = {
            class: cover === undefined ? "local" : "consequential",
            reason:
              `deriveExtractionShape(): partition on group "${group}" names field "${field}", ` +
              "which is not a direct property of the group (it may name a dropped field, or " +
              "nothing at all).",
            ...(cover === undefined
              ? {}
              : {
                  cause: {
                    kind: "operation",
                    operation: cover.operation,
                    index: cover.index,
                  } as ShapeRefusalCause,
                }),
          };
          break;
        }
        if (child.kind !== "leaf") {
          fieldDefect = {
            class: "local",
            reason:
              `deriveExtractionShape(): partition on group "${group}" names field "${field}", ` +
              `which is a ${child.kind === "array" ? "collection" : "group"}, not a leaf — ` +
              "a partition names the group's direct leaf fields.",
          };
          break;
        }
      }
      if (fieldDefect !== undefined) return fieldDefect;
    }
    return undefined;
  };
  for (const candidate of partitionCandidates) {
    const failure = validatePartition(candidate.operation);
    if (failure !== undefined) {
      refuse(candidate.operation, candidate.index, failure.class, failure.reason, failure.cause);
      continue;
    }
    const groupNode = shapedTree.children.get(candidate.operation.group);
    if (groupNode === undefined || groupNode.kind === "leaf") {
      throw new Error(
        "deriveExtractionShape(): internal — a surviving partition's group vanished.",
      );
    }
    const element = groupNode.kind === "array" ? groupNode.element : groupNode;
    const named = new Set(
      Object.values(candidate.operation.parts).flatMap((fields) => [...fields]),
    );
    const unnamed = [...element.children.keys()].filter((key) => !named.has(key));
    partitions[candidate.operation.group] =
      unnamed.length > 0
        ? { ...candidate.operation.parts, remainder: unnamed }
        : { ...candidate.operation.parts };
  }

  // 9 — No pass above leaves an empty object behind: drops are filtered
  // set-wise, each regroup simulates its own effect before committing, and a
  // nest's sources always land under its new group. Assert rather than
  // re-refuse.
  {
    const emptied: string[] = [];
    findEmptyObjects(patchTree, "", emptied);
    findEmptyObjects(shapedTree, "", emptied);
    if (emptied.length > 0) {
      throw new Error(
        `deriveExtractionShape(): internal — "${emptied[0]}" is empty after the refusal filters.`,
      );
    }
  }

  // 10 — Rebuild the schemas. The patch is the derived patch (surviving drops
  // removed, kinds original); the extraction schema is the shaped tree
  // enveloped.
  const patchSchema = treeToZod(patchTree);
  const shapedSchema = treeToZod(shapedTree);

  // The provenance names top-level groups of the SHAPED schema — and every key
  // must ALSO be a top-level key of the patch, because `mapping.provenance` is
  // applied to both schemas (here, and at the combinator's construction over
  // the patch). A granularity naming an APPLIED nest's group is refused: the
  // group exists in the extraction schema only, and no operation's retraction
  // repairs the declaration — the hard boundary. A key nothing explains (never
  // declared, and no surviving drop or nest accounts for it) aborts the same
  // way.
  const shapeKeys = Object.keys(shapedSchema.shape);
  for (const key of Object.keys(provenance)) {
    if (appliedNests.has(key)) {
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

  // 11 — Derive the mapping: every surviving patch leaf, moved through its
  // group's regroup or the nest that claims it and carrying its retype, keyed
  // by where it lands in the extraction space. A nested leaf — a top-level
  // patch leaf by construction — keys its entry at `<nest group>.<destination>`.
  const patchLeaves: string[] = [];
  collectLeafPaths(patchTree, "", patchLeaves);
  const leaves: Record<string, { source: string; retype?: Retype }> = {};
  for (const patchPath of patchLeaves) {
    const nested = appliedNestBySource.get(patchPath);
    if (nested !== undefined) {
      leaves[`${nested.group}.${nested.destination}`] = {
        source: patchPath,
        ...(appliedRetypes.has(patchPath)
          ? { retype: { extraction: "number", patch: "string" } }
          : {}),
      };
      continue;
    }
    const segments = patchPath.split(".");
    const top = segments[0]!;
    const moves = appliedRegroups.get(top);
    const extractionRest =
      moves === undefined ? segments.slice(1) : remapThroughMoves(segments.slice(1), moves);
    leaves[[top, ...extractionRest].join(".")] = {
      source: patchPath,
      ...(appliedRetypes.has(patchPath)
        ? { retype: { extraction: "number", patch: "string" } }
        : {}),
    };
  }
  const mapping: ShapeMapping = { leaves, provenance };

  // 12 — The declarations review and write need, validated against the
  // derived patch: every named group present, every named leaf survived the
  // operations. Coverage conflicts were already refused onto the drops, so
  // what fires here is what no operation explains — the hard boundary.
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
  validateDeclaration(requiredOnCreate, "requiredOnCreate");
  validateDeclaration(identifyingFields, "identifyingFields");

  // 13 — Post-condition: the artifact relates its two schemas faithfully. The
  // applier builds the mapping from one walk, so this holds by construction —
  // which is exactly why it is worth asserting: a future edit that breaks the
  // invariant fails here instead of at review. A partially-applied artifact
  // passes it too — no refusal path skips the post-condition.
  assertShapeMapping(mapping, extractionSchema, patchSchema);

  const shape: DerivedExtractionShape = {
    extractionSchema,
    patchSchema,
    mapping,
    provenance,
    requiredOnCreate,
    identifyingFields,
    partitions,
  };
  return { shape, refusals: [...refusals].sort(compareShapeRefusals) };
}

/** The pristine-tree schema-defect refusal: a pre-existing empty object. */
const refuseEmptyObjectsHard = (patchTree: ReturnType<typeof buildObjectNode>): void => {
  const emptied: string[] = [];
  findEmptyObjects(patchTree, "", emptied);
  if (emptied.length > 0) throw new Error(emptyObjectMessage(emptied[0]!));
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
 *
 * This is the throwing surface over {@link deriveExtractionShapePartially}: if
 * any operation was refused, it throws the canonically-first refusal's
 * message. Every set with a single refusal — the shape of a hand-authored
 * mistake — throws a byte-identical message to what the collecting passes
 * record; a multi-refusal set may name a different refusal than input order
 * used to reach first, because the canonical order (not discovery order)
 * decides. A caller that wants the surviving operations' artifact instead of
 * the throw calls the partial surface directly.
 */
export function deriveExtractionShape(
  schema: z.ZodObject,
  options: DeriveExtractionShapeOptions = {},
): DerivedExtractionShape {
  const { shape, refusals } = deriveExtractionShapePartially(schema, options);
  const first = refusals[0];
  if (first !== undefined) throw new Error(first.reason);
  return shape;
}
