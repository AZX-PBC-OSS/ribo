import { isExtractedLeaf, type LeafPath } from "./extracted-leaves.js";
import type { Enveloped, NoProvenance } from "./enveloped.js";
import type { InstanceEvidence, InstanceMatcher } from "./instance-identity.js";
import type { Extracted } from "./provenance.js";
import { firstCommitted, type MergePolicy } from "./merge-policy.js";

/**
 * @file `mergeChunkResults` — walk the per-chunk extraction results together and put
 * the pieces back together without inventing anything (`sp3-parity-and-scale-design.md`
 * §4.3 as corrected by §10's F2).
 *
 * Three node kinds, and the array case is the whole point:
 *
 * 1. **Leaves** → collect the envelopes from every chunk that has one, hand them to the
 *    policy, take the named index. A chunk missing the path contributes no sample.
 * 2. **Arrays** → **concatenate in chunk order. Never pair by index.** `rooms[0]` in
 *    chunk 0 and `rooms[0]` in chunk 5 are different rooms — a positional merge splices
 *    different entities into one, with two verbatim citations from different parts of
 *    the document, and every downstream check passes (F2's finding). With
 *    `alignInstances` supplied, an incoming instance is compared against instances
 *    accepted from **earlier chunks only** and merges into the first one the matcher
 *    calls `"same"`, which keeps its position; `"different"` and `"unknown"` both
 *    append. Instances from the *same* chunk are never compared with each other — the
 *    model saw both in one region and distinguished them, and that judgement beats ours.
 * 3. **Objects** → recurse over the union of keys present across chunks.
 *
 * **The walk needs no schema.** The objection — that a data walk could omit a
 * schema-required leaf no chunk produced — cannot happen: `provenance.ts` states the
 * anti-hallucination rule ("every key is required and nullable, none is `.optional()`")
 * and `enveloped()` rebuilds every object closed and fully required, so each chunk's
 * parsed result already carries every leaf, `null` where nothing was found. Every chunk
 * has the identical object shape; only array lengths differ. Passing the schema in would
 * add a parameter that changes nothing. (This holds because the inner extractor parses
 * at the trust boundary. An extractor returning a partial `fields` is violating its own
 * contract, the same class of bug as handing envelopes to a matcher, and is not defended
 * against here.)
 *
 * **No shipped matcher can exercise the align path, and that is structural rather than a
 * gap.** `contradictionMatcher` — the only matcher core ships — never returns `"same"` by
 * design. And core could not ship one that did: with chunks an exact partition, two
 * chunks can never quote the same span, so the one piece of positive evidence core could
 * read does not exist across disjoint regions. Sameness here is host knowledge, always —
 * the concat path is the one every shipped default takes.
 *
 * **Greedy returns on the FIRST anchor that answers `"same"`** and stops comparing; a
 * later anchor that would also match is left alone. Greedy rather than transitive
 * clustering because one wrong `"same"` under union-find collapses three instances into
 * one and makes the outcome depend on comparison order; greedy is deterministic and its
 * worst case is a duplicate, which review can see and remove.
 *
 * **Order is safe by construction.** Chunks arrive in document order, anchors keep
 * first-accepted position, and new instances append — so the output is global
 * first-mention order, which is what `buildInstancePositions` establishes and what
 * `LinkTargets` aligns to index-wise. A merge that reordered instances would silently
 * attach a human's link decision to a different physical record.
 */

/** Options for {@link mergeChunkResults}. */
export interface MergeChunkOptions {
  /**
   * Which chunk's envelope wins for a scalar leaf. Defaults to
   * {@link firstCommitted} — earlier text is usually the primary description.
   */
  readonly merge?: MergePolicy;
  /**
   * Optional cross-chunk instance alignment. Absent, collections simply concatenate;
   * supplied, an incoming instance merges into the first earlier-chunk instance the
   * matcher calls `"same"`, keeping that anchor's position.
   */
  readonly alignInstances?: InstanceMatcher;
}

/**
 * Walk the chunk results together and return the merged fields.
 *
 * `perChunk` is one entry per chunk, in document order — the `fields` of each chunk's
 * extraction result, already parsed to the enveloped shape at the trust boundary. The
 * walk is structure-preserving over objects, concatenating over arrays and
 * envelope-for-envelope over leaves, so the rebuilt tree is still `Enveloped<V, P>`.
 */
export const mergeChunkResults = <V extends Record<string, unknown>, P = NoProvenance>(
  perChunk: readonly Enveloped<V, P>[],
  options: MergeChunkOptions = {},
): Enveloped<V, P> => {
  if (perChunk.length === 0) {
    throw new Error(
      "mergeChunkResults: no chunk results to merge — there is nothing to return. " +
        "chunkedExtractor runs the inner extractor once on an empty transcript rather " +
        "than merging zero chunks.",
    );
  }
  const merge = options.merge ?? firstCommitted;
  const alignInstances = options.alignInstances;
  return mergeNode(perChunk, [], merge, alignInstances) as Enveloped<V, P>;
};

/** The walk: one node position, `nodes` being every chunk's value there (`undefined` when absent). */
const mergeNode = (
  nodes: readonly unknown[],
  path: LeafPath,
  merge: MergePolicy,
  alignInstances: InstanceMatcher | undefined,
): unknown => {
  const present = nodes.filter((node) => node !== undefined);
  if (present.length === 0) return undefined;

  // Leaves first: an envelope's own keys are fixed (provenance.ts), so the check is
  // safe to run on data of any shape. Every chunk has the identical object shape, so
  // the leaves at a path are either all envelopes or none.
  const samples = present.filter(isExtractedLeaf);
  if (samples.length > 0) return chooseLeaf(samples, path, merge);

  const first = present[0]!;
  if (Array.isArray(first)) {
    return concatArrays(present.filter(Array.isArray), path, alignInstances, merge);
  }
  if (isPlainObject(first)) {
    const objects = present.filter(isPlainObject) as readonly Record<string, unknown>[];
    const merged: Record<string, unknown> = {};
    for (const key of unionKeys(objects)) {
      const next = mergeNode(
        objects.map((object) => object[key]),
        [...path, key],
        merge,
        alignInstances,
      );
      if (next !== undefined) merged[key] = next;
    }
    return merged;
  }
  // Enveloped data has no primitives outside leaves; pass anything else through.
  return first;
};

/**
 * One leaf across the chunks: the policy names the winning sample's index, and the
 * walk returns that envelope BY IDENTITY — a policy cannot fabricate a value, a
 * confidence or a citation, only point at evidence it was given (ADR 0001). An
 * out-of-range index throws rather than clamping: silently accepting sample 0 would
 * hide the policy bug forever.
 */
const chooseLeaf = (
  samples: readonly Extracted<unknown>[],
  path: LeafPath,
  merge: MergePolicy,
): Extracted<unknown> => {
  const named = merge({ path, samples });
  const chosen = samples[named];
  if (chosen === undefined) {
    throw new Error(
      `mergeChunkResults: the merge policy named index ${named} at path ` +
        `"${formatLeafPath(path)}", which is outside the ${samples.length} samples it was ` +
        "handed — a policy bug, not a data problem. Thrown rather than clamped: silently " +
        "accepting sample 0 would hide the bug forever.",
    );
  }
  return chosen;
};

/**
 * Concatenate the chunks' arrays in chunk order — never pairing by index — with optional
 * cross-chunk instance alignment. An incoming instance is compared against instances
 * accepted from earlier chunks only, and merges into the first the matcher calls
 * `"same"`, keeping that anchor's position; `"different"` and `"unknown"` both append.
 */
const concatArrays = (
  arrays: readonly unknown[],
  path: LeafPath,
  alignInstances: InstanceMatcher | undefined,
  merge: MergePolicy,
): unknown[] => {
  const accepted: unknown[] = [];
  // Which chunk each accepted element came from — the "earlier chunks only" rule needs
  // it, because same-chunk instances are never compared with each other.
  const sourceChunk: number[] = [];
  for (const [chunkIndex, array] of arrays.entries()) {
    for (const element of array as readonly unknown[]) {
      if (alignInstances !== undefined && isInstanceElement(element)) {
        const anchor = findAnchor(accepted, sourceChunk, chunkIndex, element, path, alignInstances);
        if (anchor !== undefined) {
          accepted[anchor] = absorbInstance(accepted[anchor], element, path, merge);
          continue;
        }
      }
      accepted.push(element);
      sourceChunk.push(chunkIndex);
    }
  }
  return accepted;
};

/**
 * The first earlier-chunk instance the matcher calls `"same"`, greedy — comparing stops
 * at the first affirmative, so a later anchor that would also match is left standing.
 * The anchor (earlier chunk) is `a` and the incoming (later chunk) is `b`.
 */
const findAnchor = (
  accepted: readonly unknown[],
  sourceChunk: readonly number[],
  chunkIndex: number,
  incoming: unknown,
  path: LeafPath,
  matcher: InstanceMatcher,
): number | undefined => {
  const incomingFacts = toInstanceFacts(incoming, path);
  for (let index = 0; index < accepted.length; index++) {
    // Parallel to `accepted` by construction — pushed together in `concatArrays`.
    if (sourceChunk[index]! >= chunkIndex) continue;
    if (matcher(toInstanceFacts(accepted[index], path), incomingFacts) === "same") return index;
  }
  return undefined;
};

/**
 * Merge an incoming instance into an anchor that the matcher judged the same real-world
 * thing.
 *
 * **Leaves go through the caller's {@link MergePolicy}, exactly as leaves outside a
 * collection do.** The first implementation hard-coded first-mention-wins here, which is
 * `firstCommitted`'s rule under another name — so a caller who passed `lastCommitted` got
 * it for every scalar in the schema and silently did not get it inside a merged instance.
 * A policy that applies to some leaves and not others is the kind of inconsistency nobody
 * finds until their data is wrong. The anchor is sample 0 and the incoming is sample 1,
 * so `firstCommitted` still reproduces the original behaviour.
 *
 * Everything else is structural and not the policy's business: nested arrays concatenate
 * in chunk order with no per-nested-group matcher (pairing them by index once their
 * parents matched would reintroduce exactly the splice this walk exists to prevent), and
 * nested objects recurse.
 */
const absorbInstance = (
  anchor: unknown,
  incoming: unknown,
  path: LeafPath,
  merge: MergePolicy,
): unknown => {
  const a = anchor as Record<string, unknown>;
  const b = incoming as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...a };
  for (const [key, incomingValue] of Object.entries(b)) {
    const anchorValue = a[key];
    if (anchorValue === undefined) {
      merged[key] = incomingValue;
      continue;
    }
    if (isExtractedLeaf(anchorValue) && isExtractedLeaf(incomingValue)) {
      merged[key] = chooseLeaf([anchorValue, incomingValue], [...path, key], merge);
      continue;
    }
    if (Array.isArray(anchorValue) && Array.isArray(incomingValue)) {
      // `Array.isArray` narrows to `any[]`; retype before spreading so the elements
      // stay `unknown` rather than `any`.
      const anchorItems: readonly unknown[] = anchorValue;
      const incomingItems: readonly unknown[] = incomingValue;
      merged[key] = [...anchorItems, ...incomingItems];
      continue;
    }
    if (isPlainObject(anchorValue) && isPlainObject(incomingValue)) {
      merged[key] = absorbInstance(anchorValue, incomingValue, [...path, key], merge);
    }
  }
  return merged;
};

/**
 * The instance as the matcher sees it — leaves flattened to bare values. A matcher
 * handed an envelope hits `contradictionMatcher`'s throw naming the field, which is the
 * check that keeps the flattening contract honest. The group is the path's first object
 * key: the collection group the instance belongs to.
 */
const toInstanceFacts = (instance: unknown, path: LeafPath): InstanceFactsShape => {
  const leaves: Record<string, InstanceEvidence> = {};
  for (const [key, value] of Object.entries(instance as Record<string, unknown>)) {
    if (isExtractedLeaf(value)) leaves[key] = { value: value.value, sourceSpan: value.sourceSpan };
  }
  return { group: typeof path[0] === "string" ? path[0] : "", leaves };
};

interface InstanceFactsShape {
  readonly group: string;
  readonly leaves: Record<string, InstanceEvidence>;
}

/** An instance is a plain object — not a leaf envelope, not an array. */
const isInstanceElement = (element: unknown): boolean =>
  isPlainObject(element) && !isExtractedLeaf(element);

const isPlainObject = (node: unknown): node is Record<string, unknown> =>
  typeof node === "object" && node !== null && !Array.isArray(node);

const unionKeys = (objects: readonly Record<string, unknown>[]): string[] => {
  const keys = new Set<string>();
  for (const object of objects) {
    for (const key of Object.keys(object)) keys.add(key);
  }
  return [...keys];
};

/** The leaf path as a log-friendly dotted string — for an error line, not an address. */
const formatLeafPath = (path: LeafPath): string => path.map(String).join(".");
