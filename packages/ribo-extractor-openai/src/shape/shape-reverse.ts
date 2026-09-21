/**
 * @file Reversal: walk the model's parsed output (the EXTRACTION shape's
 * enveloped data) back into the derived patch's enveloped space, following the
 * mapping — as data, with no schema in hand.
 *
 * The algorithm is entry-driven, and that is what makes regrouping work: each
 * mapping entry pairs the leaf's EXTRACTION path (where to READ, walked against
 * the data, arrays distributing per element) with its PATCH path (where to
 * WRITE, built with the array indices the read crossed). The two sides are
 * walked independently — a regroup changes relative depth, so a paired descent
 * that sliced both paths in lockstep would break the moment a leaf moved
 * deeper or shallower than it started.
 *
 * Three things reversal owes, and each is a silent failure if dropped:
 *
 *   - **Envelopes travel whole.** Under `"leaf"` provenance the value is
 *     retyped but `confidence` and `sourceSpan` are copied verbatim — an
 *     implementation that rebuilds the envelope around the value alone passes a
 *     naive round-trip and collapses every review card to a sentinel
 *     (`review.ts`'s `readEnvelope` turns a non-envelope at a leaf path into
 *     `{ value: null, confidence: 0 }` silently).
 *   - **Row spans land back on the patch's rows.** Under `"row"` provenance the
 *     leaves are plain and the citation sits on the row unit — the group object
 *     for a singleton, every element for a collection, and every element of any
 *     array nested inside one, the exact rule `enveloped()`'s walk applies when
 *     it puts the span on. Reversal copies the span at each of those units.
 *   - **Empty collections still exist.** The extraction schema requires the
 *     key, so `hvac: []` is a valid model answer and the reversed patch must
 *     carry the empty array — review distinguishes "there are none" from
 *     "never mentioned", and the output parse would refuse a missing key.
 *
 * Pure and total over the extraction space: every value the extraction schema
 * admits reverses to a value the derived patch parses. That totality is what
 * the value-side property asserts, and it is why the retype set is closed.
 */

import { ROW_SOURCE_SPAN_KEY, SchemaParseError } from "@azx/ribo-core";
import type { ProvenanceGranularity } from "@azx/ribo-core";

import { retypeToPatchValue } from "./shape-mapping.js";
import type { ShapeMapping, Retype } from "./shape-mapping.js";

/** The child at `key`, or `undefined` when there is no object there to read. */
const readChild = (node: unknown, key: string): unknown =>
  typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined;

const isPlainObject = (node: unknown): node is Record<string, unknown> =>
  typeof node === "object" && node !== null && !Array.isArray(node);

/** The row's own citation, or `null` when the row carries no usable span. */
const readRowSpan = (node: unknown): string | null => {
  const span = readChild(node, ROW_SOURCE_SPAN_KEY);
  return typeof span === "string" ? span : null;
};

/** One mapping entry, pre-split into the segments reversal walks. */
interface IndexedLeaf {
  /** Extraction-path segments below the top-level key; empty for a top-level leaf. */
  readonly rest: readonly string[];
  /** Patch-path segments below the top-level key — where the value is written. */
  readonly sourceRest: readonly string[];
  readonly retype?: Retype;
}

/**
 * Reverse one leaf's value out of the extraction space and into the patch's.
 *
 * Under `"leaf"` provenance the extraction data carries the whole envelope, and
 * the envelope travels: the value is retyped when the leaf says so, the
 * confidence and span are copied verbatim. Under `"row"`/`"none"` the data
 * carries a bare value and reversal writes a bare value — the citation, where
 * one exists, is the row's, and the row's is copied at the row.
 *
 * `extractionPath` is the leaf's instance path in the extraction data, for the
 * structural-failure message: a `SchemaParseError` an extractor ladder can
 * recognise, naming where the data stopped matching the schema.
 */
const reverseLeafValue = (
  child: unknown,
  entry: IndexedLeaf,
  granularity: ProvenanceGranularity,
  extractionPath: string,
): unknown => {
  if (granularity === "leaf") {
    if (!isPlainObject(child)) {
      throw new SchemaParseError(
        `shape reversal: expected a leaf envelope under "leaf" provenance at ` +
          `"${extractionPath}" — the extraction data does not match the schema the mapping ` +
          "was built against.",
      );
    }
    return {
      value:
        entry.retype === undefined
          ? child.value
          : // The construction-time kind check pinned a retyped leaf's
            // extraction kind to "number", so the parsed value is a number or
            // the null that passes through untouched.
            retypeToPatchValue(child.value as number | null),
      confidence: child.confidence,
      sourceSpan: child.sourceSpan,
    };
  }
  if (entry.retype === undefined) return child;
  return retypeToPatchValue(child as number | null);
};

/** One concrete write into the patch output: an absolute path and its value. */
interface PatchWrite {
  readonly segments: readonly (string | number)[];
  readonly value: unknown;
}

/**
 * Read the leaf one entry names — walking the extraction data along `rest`,
 * arrays distributing per element — and record its reversed value at the patch
 * path the same walk builds.
 *
 * `patchPrefix` carries the absolute patch path built so far; crossing an array
 * appends the array's patch key AND the element index, and — under `"row"`
 * provenance — records the element's citation, plus an empty-array seed so a
 * collection the model emptied still exists in the output.
 */
const collectWrites = (
  node: unknown,
  rest: readonly string[],
  sourceRest: readonly string[],
  entry: IndexedLeaf,
  granularity: ProvenanceGranularity,
  patchPrefix: readonly (string | number)[],
  writes: PatchWrite[],
  extractionPath: string,
): void => {
  if (rest.length === 0) {
    // The extraction leaf is here; the patch path is whatever remains of the
    // source path — a regroup may have left it deeper or shallower.
    writes.push({
      segments: [...patchPrefix, ...sourceRest],
      value: reverseLeafValue(node, entry, granularity, extractionPath),
    });
    return;
  }
  const segment = rest[0]!;
  const child = readChild(node, segment);
  // The patch side is walked independently: a regroup can leave the leaf
  // deeper or shallower than it started, so the source segments may run out
  // while the extraction side still has structure to cross — from there the
  // descent adds nothing to the patch path.
  const patchKey = sourceRest[0];
  const patchTail = patchKey === undefined ? sourceRest : sourceRest.slice(1);
  if (Array.isArray(child)) {
    if (patchKey === undefined) {
      throw new SchemaParseError(
        `shape reversal: the extraction data crosses a collection at "${extractionPath}.${segment}" ` +
          "the patch path has already passed — the mapping does not preserve collection-ness.",
      );
    }
    // The seed first, so a collection the model emptied still exists; writes
    // into it merge element-wise below.
    writes.push({ segments: [...patchPrefix, patchKey], value: [] });
    child.forEach((element, index) => {
      if (granularity === "row") {
        writes.push({
          segments: [...patchPrefix, patchKey, index, ROW_SOURCE_SPAN_KEY],
          value: readRowSpan(element),
        });
      }
      collectWrites(
        element,
        rest.slice(1),
        patchTail,
        entry,
        granularity,
        [...patchPrefix, patchKey, index],
        writes,
        `${extractionPath}.${segment}[${index}]`,
      );
    });
    return;
  }
  collectWrites(
    child,
    rest.slice(1),
    patchTail,
    entry,
    granularity,
    patchKey === undefined ? patchPrefix : [...patchPrefix, patchKey],
    writes,
    `${extractionPath}.${segment}`,
  );
};

/**
 * Merge `piece` into `out` at `key`, where several entries can converge on one
 * patch parent (two moves into one new sub-object) or one patch array.
 *
 * Identical values are a no-op, not a collision — the row span is written once
 * per row unit, and several entries crossing the same array each record it.
 * Arrays seed empty and merge element-wise; anything else at the same position
 * is a double leaf write the bijection should have refused — thrown, never
 * overwritten. `path` is the absolute patch position of the write, instance
 * style, for the collision's message.
 */
const mergeWrite = (
  out: Record<string, unknown>,
  key: string,
  piece: unknown,
  path: string,
): void => {
  const existing = out[key];
  if (existing === undefined) {
    out[key] = piece;
    return;
  }
  if (existing === piece) return;
  if (isPlainObject(existing) && isPlainObject(piece)) {
    for (const [inner, value] of Object.entries(piece)) {
      mergeWrite(existing, inner, value, `${path}.${inner}`);
    }
    return;
  }
  if (Array.isArray(existing) && Array.isArray(piece)) {
    if (piece.length === 0) return;
    if (existing.length === 0) {
      out[key] = piece;
      return;
    }
    if (existing.length !== piece.length) {
      throw new SchemaParseError(
        `shape reversal: two mapping entries wrote different-length arrays to the same patch ` +
          `position "${path}" — the mapping does not preserve collection-ness.`,
      );
    }
    const target = existing as unknown as Record<string, unknown>;
    for (let i = 0; i < piece.length; i++) {
      mergeWrite(target, String(i), piece[i], `${path}[${i}]`);
    }
    return;
  }
  throw new SchemaParseError(
    `shape reversal: two mapping entries wrote a leaf to the same patch position "${path}" — ` +
      "the mapping is not bijective (assertShapeMapping should have refused it at construction).",
  );
};

/** Write one value at an absolute patch path, creating objects and arrays on the way. */
const writeAt = (
  out: Record<string, unknown>,
  segments: readonly (string | number)[],
  value: unknown,
): void => {
  let node: Record<string, unknown> = out;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    const nextIsIndex = typeof segments[i + 1] === "number";
    const existing = node[key];
    if (existing === undefined) {
      const created: Record<string, unknown> = nextIsIndex
        ? ([] as unknown as Record<string, unknown>)
        : {};
      node[key] = created;
      node = created;
    } else {
      node = existing as Record<string, unknown>;
    }
  }
  const last = segments[segments.length - 1]!;
  // The instance-style label of the position, for a collision's message.
  const path = segments
    .map((segment, i) =>
      typeof segment === "number" ? `[${segment}]` : `${i === 0 ? "" : "."}${segment}`,
    )
    .join("");
  mergeWrite(node, String(last), value, path);
};

/**
 * Reverse the model's parsed output into the derived patch's enveloped space.
 *
 * `fields` is the extraction shape's data — already parsed against the
 * extraction schema at the inner extractor's trust boundary. The return is
 * `Enveloped` over the derived patch at the same per-group provenance, ready
 * for `buildReviewRequest` (which walks the patch schema and reads each leaf at
 * its patch path) and, after review, for the write.
 */
export const reverseShapedFields = (
  fields: Record<string, unknown>,
  mapping: ShapeMapping,
): Record<string, unknown> => {
  const writes: PatchWrite[] = [];
  for (const [path, entry] of Object.entries(mapping.leaves)) {
    const segments = path.split(".");
    const top = segments[0]!;
    const rest = segments.slice(1);
    const granularity = mapping.provenance[top] ?? "leaf";
    const indexed: IndexedLeaf = {
      rest,
      sourceRest: entry.source.split(".").slice(1),
      ...(entry.retype === undefined ? {} : { retype: entry.retype }),
    };
    if (rest.length === 0) {
      // A top-level leaf: the value is the top-level key's data itself.
      writes.push({
        segments: entry.source.split("."),
        value: reverseLeafValue(fields[top], indexed, granularity, top),
      });
      continue;
    }
    const groupData = fields[top];
    if (Array.isArray(groupData)) {
      // A collection group: the seed first, then each element is a row of its
      // own — its citation travels — and the entries walk per element.
      writes.push({ segments: [top], value: [] });
      groupData.forEach((element, index) => {
        if (granularity === "row") {
          writes.push({
            segments: [top, index, ROW_SOURCE_SPAN_KEY],
            value: readRowSpan(element),
          });
        }
        collectWrites(
          element,
          rest,
          indexed.sourceRest,
          indexed,
          granularity,
          [top, index],
          writes,
          `${top}[${index}]`,
        );
      });
      continue;
    }
    if (granularity === "row") {
      // The singleton group object is itself a row — its citation travels.
      writes.push({
        segments: [top, ROW_SOURCE_SPAN_KEY],
        value: readRowSpan(groupData),
      });
    }
    collectWrites(groupData, rest, indexed.sourceRest, indexed, granularity, [top], writes, top);
  }

  const out: Record<string, unknown> = {};
  for (const write of writes) {
    writeAt(out, write.segments, write.value);
  }
  return out;
};
