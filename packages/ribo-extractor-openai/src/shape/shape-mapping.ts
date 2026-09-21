/**
 * @file The mapping back from an extraction shape to the derived patch, as DATA.
 *
 * A derived extraction shape does not have to be the data shape — it has to
 * extract well and **map back**. The mapping is the second half of that pair: a
 * path map plus transforms from a closed, invertible set, between two ENVELOPED
 * spaces. Nothing plain flows through this library — `enveloped()` wraps every
 * leaf as `{ value, confidence, sourceSpan }` and adds a row span key for row
 * groups — so the mapping's domain and codomain are both enveloped, and reversal
 * must carry `confidence` and `sourceSpan` through every regroup and retype. An
 * implementation that drops them passes a naive round-trip and collapses every
 * review card to a sentinel (`review.ts`'s `readEnvelope` turns a non-envelope
 * at a leaf path into `{ value: null, confidence: 0 }` silently).
 *
 * **Data, not closures.** The mapping is a runtime value a host may cache,
 * persist or diff. Its transforms come from a closed set — see {@link Retype} —
 * so reversal is total by construction and the whole mapping survives a JSON
 * round-trip.
 *
 * **One entry per extraction leaf; one entry per patch leaf.** The mapping and
 * the two schemas it relates are validated together at construction by
 * {@link assertShapeMapping}: every leaf of the extraction schema has an entry,
 * every entry's `source` names a leaf of the derived patch, and the two
 * correspondences are bijective. A dropped caller leaf is in neither schema and
 * so in neither side of the bijection — drops are expressible only by the
 * schemas, never by a hole in the map.
 *
 * **What construction cannot validate: the pairing itself.** The checks are of
 * existence and bijectivity — never of what each entry MEANS. Whether an entry
 * pairs the two leaves that mean the same field is intent, and the mapping is
 * the only place that intent lives: a hand-written mapping that swaps two
 * same-kind leaves of one array element passes every construction check,
 * reverses faithfully, and parses — a confident, grounded envelope on the wrong
 * leaf, with no signal anything is off. No property over (generated, reversed,
 * mapping) catches it either, because faithful reversal satisfies such
 * properties for any bijective mapping, right or wrong. The pairing is
 * checkable only against the intent, which is what the value property in
 * `shape-properties.test.ts` does for a derived artifact — one exhaustive
 * assertion per mapping entry — and what a human must supply for a hand-written
 * one.
 */

import { z } from "zod";

import {
  ROW_SOURCE_SPAN_KEY,
  childPath,
  isExtractedSchema,
  parseFieldPath,
  stripOptionalNullable,
} from "@azx/ribo-core";
import type { ProvenanceGranularity } from "@azx/ribo-core";

/**
 * The kind of a leaf, as the closed retype set and the mapping's kind checks
 * name them. `enum` and `literal` are distinct from `"string"` on purpose: a
 * retype that widened an enum to a plain string would discard the vocabulary
 * that makes the leaf extractable, and no canonical inverse exists for it.
 */
export type LeafKind = "string" | "number" | "boolean" | "enum" | "literal";

/**
 * A retype's two sides — the closed, invertible set of kind conversions a
 * derived shape may use.
 *
 * The set has exactly one member: **the patch leaf is a `string`, the extraction
 * leaf is a `number`** (the pilot's divergence — numeric form fields the vendor
 * types as form-input strings, modelled as what they mean). Both directions are
 * pinned:
 *
 *   - Reversal (extraction → patch, the only direction the library runs) is
 *     `String(value)` — JavaScript's shortest round-trip form. `String(12.5)` is
 *     `"12.5"`, never `"12.50"`; `125` reverses to `"125"`, the canonical
 *     encoding of `Number("12.5e1")`. Total over the extraction space: every
 *     finite number the model can emit lands back in a string the patch accepts.
 *   - Forward (patch → extraction) is `Number(value)` — and it is NOT total: a
 *     patch string admits `"abc"`, which no number reverses from. That
 *     asymmetry is why the set has no member in the other direction — a retype
 *     whose extraction space is WIDER than what reverses would fail the
 *     reverse-direction round-trip by construction — and why a retype whose
 *     source kind is outside the closed set is refused at derivation, which sees
 *     schemas, not values.
 *
 * `boolean` is excluded on the same ground: no canonical string encoding exists
 * that both directions agree on (`"true"`/`"false"` versus `"yes"`/`"no"` is a
 * vocabulary choice, and a vocabulary choice is not invertible-in-canonical-form).
 */
export interface Retype {
  /** The extraction leaf's kind — what the model is constrained to emit. */
  readonly extraction: "number";
  /** The patch leaf's kind — what reversal must land back in. */
  readonly patch: "string";
}

/**
 * The pinned inverse for {@link Retype}: extraction number → patch string, in
 * the canonical encoding written down above. `null` passes through — a patch
 * leaf is `.nullable()`, and "not stated" reverses to "not stated", never to
 * the string `"null"`.
 */
export const retypeToPatchValue = (value: number | null): string | null =>
  value === null ? null : String(value);

/** Where one extraction leaf came from, and how to get back. */
export interface LeafMapping {
  /**
   * The leaf's dotted path in the derived patch — where reversal writes it.
   * A regrouped leaf's source differs from its extraction path; every other
   * leaf's source is its own path in the caller's schema.
   */
  readonly source: string;
  /** Present when the extraction leaf's kind differs from the patch leaf's. */
  readonly retype?: Retype;
}

/**
 * The mapping back from the extraction shape to the derived patch, as data.
 *
 * `leaves` is keyed by the leaf's dotted path in the EXTRACTION schema — the
 * paths the model's parsed output carries — and each entry names the patch path
 * it reverses to. `provenance` records the granularity each top-level key was
 * derived at, which is what tells reversal whether a leaf's value travels as an
 * envelope (`"leaf"`) or as a plain value beside its row's span (`"row"`,
 * `"none"`). The top-level keys are shared by both spaces — regrouping within a
 * top-level key is the supported move, and one that never crosses a group
 * boundary — so one map serves both.
 */
export interface ShapeMapping {
  /** Extraction leaf path → where it came from. Exhaustive over both schemas. */
  readonly leaves: Readonly<Record<string, LeafMapping>>;
  /** Top-level key → the provenance granularity both spaces were derived at. */
  readonly provenance: Readonly<Record<string, ProvenanceGranularity>>;
}

/**
 * `shape[key]` for a key that came from `Object.keys(shape)`.
 *
 * A bare `z.ZodObject`'s `.shape` indexes to `any`, so every call site otherwise
 * suppresses `no-unsafe-argument` and repeats the same justification. The key
 * came from the shape's own keys, so the value is a `ZodType` by construction —
 * narrowed once here, the same move `enveloped.ts`'s `fieldAt` makes.
 */
const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType => shape[key] as z.ZodType;

/** The leaf kind of a supported leaf schema, for the mapping's kind checks. */
const leafKindOf = (schema: z.ZodType): LeafKind => {
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodEnum) return "enum";
  if (schema instanceof z.ZodLiteral) return "literal";
  throw new Error(
    `shape mapping: unsupported leaf kind at this position (${schema.constructor.name}) — ` +
      "only enum, literal, string, number and boolean leaves can be mapped.",
  );
};

/**
 * The vocabulary of an enum or literal leaf, so the mapping's kind check can
 * tell two same-kinded enums apart (a mapping that swapped them would otherwise
 * pass a kind-only check and mis-write every value). Compared as strings on
 * both sides, so the comparison cannot drift from how the leaves were declared.
 */
const leafVocabularyOf = (schema: z.ZodType): readonly string[] | undefined => {
  if (schema instanceof z.ZodEnum) return schema.options.map((member) => String(member));
  if (schema instanceof z.ZodLiteral) return [...schema.values].map((value) => String(value));
  return undefined;
};

type WalkAccumulator = {
  leaves: Map<string, { kind: LeafKind; vocabulary?: readonly string[] }>;
  arrayPaths: Set<string>;
};

/**
 * The structural array pattern a leaf path runs under, expressed as the
 * depths-from-leaf at which an array ancestor appears. The leaf at
 * `g.arr.f1` has `[0]` — one array directly above; `g.outer.arr.f1`
 * has `[1]` — one array two segments above; `g.top` has `[]`.
 *
 * Length and depth, not names — so a regroup that re-hangs a subtree
 * beneath a new prefix keeps the same pattern on both sides, while a
 * mapping that crosses a collection boundary on one side (the construction
 * check we pin below) cannot possibly keep them equal.
 */
const arrayDepthsFromLeaf = (path: string, arrayPaths: ReadonlySet<string>): number[] => {
  const leafSegments = path.split(".").length;
  return [...arrayPaths]
    .filter(
      (arrayPath) =>
        arrayPath.split(".").length < leafSegments && path.startsWith(`${arrayPath}.`),
    )
    .map((arrayPath) => leafSegments - arrayPath.split(".").length - 1)
    .sort((a, b) => a - b);
};

/**
 * Walk the PATCH schema — the derived patch, pre-envelope — enumerating its
 * leaves. Arrays are transparent at schema time (indices do not exist until
 * data arrives), so a leaf inside a collection is recorded once, at its
 * element-relative path — the same convention every schema-time walk here uses.
 */
const walkPatchSchema = (schema: z.ZodObject, walk: WalkAccumulator): void => {
  for (const key of Object.keys(schema.shape)) {
    walkPatchField(fieldAt(schema.shape, key), key, walk);
  }
};

const walkPatchField = (field: z.ZodType, path: string, walk: WalkAccumulator): void => {
  const stripped = stripOptionalNullable(field);
  if (stripped instanceof z.ZodObject) {
    for (const key of Object.keys(stripped.shape)) {
      walkPatchField(fieldAt(stripped.shape, key), childPath(path, key), walk);
    }
    return;
  }
  if (stripped instanceof z.ZodArray) {
    walk.arrayPaths.add(path);
    // The element is walked at the ARRAY's path: schema-time leaves under a
    // collection are element-relative, and the array is transparent.
    walkPatchField(stripped.element as z.ZodType, path, walk);
    return;
  }
  walk.leaves.set(path, {
    kind: leafKindOf(stripped),
    vocabulary: leafVocabularyOf(stripped),
  });
};

/**
 * Walk the EXTRACTION schema — post-envelope — enumerating its leaves with the
 * same paths the model's parsed output carries. Which objects are leaf
 * envelopes and which are groups is read off the schema
 * (`isExtractedSchema`), except where the granularity decides: under `"row"`
 * a row unit's `sourceSpan` is the row's citation, not a leaf, and is skipped.
 */
const walkExtractionSchema = (
  schema: z.ZodObject,
  provenance: Readonly<Record<string, ProvenanceGranularity>>,
  walk: WalkAccumulator,
): void => {
  for (const key of Object.keys(schema.shape)) {
    walkExtractionField(
      fieldAt(schema.shape, key),
      key,
      provenance[key] ?? "leaf",
      // The top-level group object — or every element of a collection group —
      // is a row unit, the same rule `enveloped()`'s walk applies.
      true,
      walk,
    );
  }
};

const walkExtractionField = (
  field: z.ZodType,
  path: string,
  granularity: ProvenanceGranularity,
  isRow: boolean,
  walk: WalkAccumulator,
): void => {
  const stripped = stripOptionalNullable(field);
  if (stripped instanceof z.ZodObject) {
    // A leaf envelope — only under `"leaf"` granularity, where every leaf is
    // one. Post-envelope the two are unambiguous: an enveloped GROUP's members
    // are themselves envelopes (objects), never the bare nullable/number pair
    // `isExtractedSchema` matches.
    if (isExtractedSchema(stripped)) {
      if (granularity !== "leaf") {
        throw new Error(
          `shape mapping: the schema at "${path}" is a leaf envelope, but the group's ` +
            `provenance is "${granularity}" — the schema and the mapping's provenance ` +
            "disagree about who carries the citation.",
        );
      }
      const value = stripOptionalNullable(fieldAt(stripped.shape, "value"));
      walk.leaves.set(path, {
        kind: leafKindOf(value),
        vocabulary: leafVocabularyOf(value),
      });
      return;
    }
    for (const key of Object.keys(stripped.shape)) {
      if (granularity === "row" && isRow && key === ROW_SOURCE_SPAN_KEY) continue;
      walkExtractionField(
        fieldAt(stripped.shape, key),
        childPath(path, key),
        granularity,
        false,
        walk,
      );
    }
    return;
  }
  if (stripped instanceof z.ZodArray) {
    walk.arrayPaths.add(path);
    // The element is a row — again the rule `enveloped()` applies — so the
    // element's own `sourceSpan` is skipped below it.
    walkExtractionField(stripped.element as z.ZodType, path, granularity, true, walk);
    return;
  }
  if (granularity === "leaf") {
    throw new Error(
      `shape mapping: a bare leaf at "${path}" under "leaf" provenance — the extraction ` +
        "schema was not derived by enveloping this position.",
    );
  }
  walk.leaves.set(path, {
    kind: leafKindOf(stripped),
    vocabulary: leafVocabularyOf(stripped),
  });
};

/** Do two leaves' kinds agree, including their vocabulary when they have one? */
const kindsAgree = (
  extraction: { kind: LeafKind; vocabulary?: readonly string[] },
  patch: { kind: LeafKind; vocabulary?: readonly string[] },
): boolean => {
  if (extraction.kind !== patch.kind) return false;
  const extractionVocabulary = extraction.vocabulary;
  const patchVocabulary = patch.vocabulary;
  if (extractionVocabulary === undefined || patchVocabulary === undefined) return true;
  // Same length and same members — order included, since both sides were
  // declared verbatim and position is what a write sends.
  return (
    extractionVocabulary.length === patchVocabulary.length &&
    extractionVocabulary.every((member, i) => member === patchVocabulary[i])
  );
};

/**
 * Refuse a mapping path that is not a pure object-key path. Schema-time paths
 * have no instances — brackets belong to data-time instance keys — so a
 * bracketed mapping path addresses nothing either walk produced.
 */
const assertObjectKeyPath = (path: string, side: "extraction" | "patch"): void => {
  const segments = parseFieldPath(path);
  if (segments.length === 0 || segments.some((segment) => segment.kind !== "objectKey")) {
    throw new Error(
      `shape mapping: the ${side} path "${path}" is not a plain dotted object path — ` +
        "schema-time paths have no instance keys (brackets address data-time instances).",
    );
  }
};

/**
 * Refuse a mapping that does not faithfully relate the two schemas it names.
 *
 * Called at construction by the reversal combinator — which receives a mapping
 * that may be hand-written — and as a post-condition by the derivation that
 * builds one. Each check is against a silent failure:
 *
 *   - both endpoints are pure object-key paths — schema-time paths have no
 *     instances, and a bracketed path addresses nothing either walk produced;
 *   - every leaf of the extraction schema has a mapping entry — a missing one
 *     would drop that leaf's data on the floor at reversal;
 *   - every mapping key IS an extraction leaf — a stale entry would write a
 *     value nowhere;
 *   - the sources are exactly the patch's leaves, bijectively — a patch leaf
 *     with no entry would present a permanent sentinel at review, and an
 *     unknown source would write outside the patch;
 *   - each entry's retype names the two kinds the schemas actually have, and
 *     an unretyped entry's kinds agree — including enum and literal
 *     vocabulary, which a kind-only check would let swap;
 *   - every entry's source shares the entry's first path segment — the
 *     top-level key. Regrouping within a top-level key is the supported move;
 *     one that crossed the boundary would strand a row-provenance span with no
 *     data-determined place to land, and `validateProvenance` and
 *     `statedEmptyGroups` are both keyed by the group;
 *   - each entry's two sides run under the same array-depth pattern from the
 *     leaf — measured in depths-from-leaf, not in path names, so a regroup
 *     that re-hangs an array-containing subtree under a new prefix keeps the
 *     pattern on both sides. A difference means the entry crosses a
 *     collection boundary on one side and not the other, and reversal would
 *     write data to an array the patch never declares.
 */
export const assertShapeMapping = (
  mapping: ShapeMapping,
  extractionSchema: z.ZodObject,
  patchSchema: z.ZodObject,
): void => {
  const extractionWalk: WalkAccumulator = { leaves: new Map(), arrayPaths: new Set() };
  walkExtractionSchema(extractionSchema, mapping.provenance, extractionWalk);
  const patchWalk: WalkAccumulator = { leaves: new Map(), arrayPaths: new Set() };
  walkPatchSchema(patchSchema, patchWalk);

  for (const [path, entry] of Object.entries(mapping.leaves)) {
    assertObjectKeyPath(path, "extraction");
    assertObjectKeyPath(entry.source, "patch");
    const extractionTop = path.split(".")[0]!;
    if (extractionTop !== entry.source.split(".")[0]!) {
      throw new Error(
        `shape mapping: the entry at "${path}" names source "${entry.source}" under a ` +
          "different top-level key — regrouping may not cross a top-level boundary. A " +
          "row-provenance group has one span with no data-determined place to land across " +
          "two original groups.",
      );
    }
    const extractionLeaf = extractionWalk.leaves.get(path);
    if (extractionLeaf === undefined) {
      throw new Error(
        `shape mapping: the entry at "${path}" is not a leaf of the extraction schema — ` +
          "every mapping key must name a leaf the model produces.",
      );
    }
    const patchLeaf = patchWalk.leaves.get(entry.source);
    if (patchLeaf === undefined) {
      throw new Error(
        `shape mapping: the entry at "${path}" names source "${entry.source}", which is not ` +
          "a leaf of the derived patch — every source must name a leaf review walks.",
      );
    }
    if (entry.retype === undefined) {
      if (!kindsAgree(extractionLeaf, patchLeaf)) {
        throw new Error(
          `shape mapping: the entry at "${path}" has no retype, but its kinds disagree — ` +
            `extraction ${extractionLeaf.kind} against patch ${patchLeaf.kind}. Declare the ` +
            "retype, or derive the leaf without changing its kind.",
        );
      }
    } else {
      if (
        extractionLeaf.kind !== entry.retype.extraction ||
        patchLeaf.kind !== entry.retype.patch
      ) {
        throw new Error(
          `shape mapping: the entry at "${path}" declares a retype ` +
            `${entry.retype.extraction}→${entry.retype.patch}, but the schemas carry ` +
            `extraction ${extractionLeaf.kind} against patch ${patchLeaf.kind}.`,
        );
      }
    }
    // An entry may not cross a collection boundary on one side and not the
    // other. Reversal walks each side independently, so the two patch-side
    // writes that would result either share an array index they shouldn't
    // (`g.top` written at `g.arr[0]` when `g.arr[0]` came from a different
    // entry) or seed an array the patch never declares. The check is by
    // STRUCTURAL depth pattern, not by path name: a regroup that re-hangs
    // an array-containing subtree under a new prefix keeps the pattern on
    // both sides, even though the names diverge.
    const extractionDepths = arrayDepthsFromLeaf(path, extractionWalk.arrayPaths);
    const patchDepths = arrayDepthsFromLeaf(entry.source, patchWalk.arrayPaths);
    if (
      extractionDepths.length !== patchDepths.length ||
      extractionDepths.some((d, i) => d !== patchDepths[i])
    ) {
      throw new Error(
        `shape mapping: the entry at "${path}" crosses a collection boundary the source ` +
          `"${entry.source}" does not — the entry's extraction array-depth pattern ` +
          `[${extractionDepths.join(",")}] disagrees with its patch array-depth pattern ` +
          `[${patchDepths.join(",")}]. An entry's two sides must run under the same ` +
          "collections, even after a regrouping renames their prefix, or reversal writes " +
          "data to a position the patch never declared.",
      );
    }
  }

  for (const path of extractionWalk.leaves.keys()) {
    if (!Object.hasOwn(mapping.leaves, path)) {
      throw new Error(
        `shape mapping: the extraction leaf at "${path}" has no mapping entry — reversal ` +
          "would silently drop its data. Every leaf of the extraction schema must be mapped.",
      );
    }
  }
  for (const path of patchWalk.leaves.keys()) {
    if (!Object.values(mapping.leaves).some((entry) => entry.source === path)) {
      throw new Error(
        `shape mapping: the patch leaf at "${path}" is no entry's source — it would present ` +
          "a permanent sentinel at review. The mapping and the patch must be bijective.",
      );
    }
  }
};
