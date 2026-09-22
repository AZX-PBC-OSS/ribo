/**
 * @file The operation set, and the applier that turns a caller's plain zod
 * schema plus an explicit list of those operations into the derived artifact —
 * an extraction schema, and the mapping back.
 *
 * The operation set is what a human did when they built the pilot adapter by
 * hand, made minimal and explicit: **drop** (the pilot's scoping — fields no
 * dictation ever fills), **retype** (the pilot's KNOWN DIVERGENCES — numeric
 * fields the vendor types as form-input strings, modelled as what they mean),
 * **regroup within a top-level key** (re-nesting leaves for extraction), and
 * **nest** (create a NEW top-level group and move top-level leaves into it —
 * the move a flat schema needs; spike 0009's model reached for exactly this
 * operation and the vocabulary could not express it). Beside the four
 * value-space operations, the artifact carries the four declarations review
 * and write need — required-on-create, identifying fields, provenance
 * granularity and the leaves' own descriptions — validated against the
 * derived patch rather than trusted.
 *
 * **Regrouping may not cross a top-level boundary; `nest` is the one way a
 * leaf reaches a different one.** A row-provenance derived group has one span
 * with no data-determined place to land across two original groups;
 * `validateProvenance` and `statedEmptyGroups` are both keyed by the top-level
 * group — so `regroup` stays within its top-level key. A nest move is legal
 * across the boundary precisely because the leaf it moves has no group and no
 * span on the patch side: a top-level leaf is never `"row"`-provenanced
 * (`validateProvenance` refuses that outright — a leaf has no object to hang
 * the row's sourceSpan on), so nothing is stranded. The mapping's
 * construction-time check refuses any cross-top pairing that is not exactly
 * this case.
 *
 * A nest source is a top-level LEAF — never a group, never a collection,
 * never a nested leaf. Nesting a whole group is a different operation with a
 * real provenance problem behind it (its `"row"` span would have no place to
 * land under the new top-level key), not an incidental restriction. A leaf is
 * never a `ZodArray`, so a nest group is always a plain object of plain
 * leaves — and only a collection group can ever be stated-empty, so the
 * `statedEmptyGroups` passthrough in `reshaped-extractor.ts` stays sound.
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
 *   - at most one `retype` per path, one `regroup` per group, and one `nest`
 *     per group — a duplicate is refused, not silently overwritten — and a
 *     given source is moved by at most one `nest`;
 *   - `retype` and a move compose on the same leaf (retype the kind, move the
 *     position — orthogonal dimensions);
 *   - the destinations of one regroup's or nest's moves are pairwise distinct
 *     and no two destinations may prefix one another — so insert order cannot
 *     change the result — and a regroup destination may not lie under a
 *     dropped path. The dropped-path rule has no nest analogue: nest
 *     destinations live under a brand-new synthetic group, so nothing dropped
 *     can be under them;
 *   - a nest `group` may not collide with any surviving top-level key of the
 *     patch, nor reuse a DROPPED one — a name the caller deliberately removed
 *     reappearing as a synthetic group is confusing at review, the same ground
 *     regroup's no-resurrection rule stands on.
 *
 *     The "pairwise distinct" rule is its own check, not the prefix rule: equal
 *     destinations are reported as a same-destination collision, not as "one
 *     under the other". `isPrefixOf` says equal arrays prefix one another,
 *     which is the wrong name for the case; a same-destination pair would
 *     silently fall through to the ambiguous prefix message without an
 *     independent check.
 *
 * **The refusals the derivation owes.** A scalar array, a union or a record is
 * refused HERE, naming the path — review refuses a scalar array outright, and
 * `enveloped()`'s allowlist rejects unions and records — and an error at
 * derivation, where the schema author is present, beats the same failure at
 * extraction, where it surfaces as an opaque route error far from its cause.
 */

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
    } /** Create a NEW top-level group and move top-level leaves into it —
   * `regroup`'s counterpart for a flat schema. The patch is untouched: the
   * group exists only in the extraction schema, where it gives the split and
   * the prompt assembly a semantic unit. Each key of `moves` is a top-level
   * patch LEAF key (never a group, a collection, or a nested path), moved to
   * the destination it names — a path relative to the new group. */
  | {
      readonly op: "nest";
      /** The name of the new top-level key the operation creates. */
      readonly group: string;
      /** Top-level patch leaf key → destination path relative to the new group. */
      readonly moves: Readonly<Record<string, string>>;
    };
