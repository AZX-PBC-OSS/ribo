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
 *   - the destinations of one regroup's moves are pairwise distinct, no two
 *     destinations may prefix one another, and no destination may lie under a
 *     dropped path — so insert order cannot change the result.
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
    };
