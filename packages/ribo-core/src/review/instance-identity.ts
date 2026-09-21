/**
 * @file Types for instance identity: the boundary where existing records meet review.
 *
 * Existing records enter at review, never at extraction. This file keeps the core
 * vocabulary (`ExistingRecord`, `InstanceLinkDecision`, `LinkTargets`) in one place
 * so the adapter, the review contract and the UI hook can all name them without any
 * package reaching into another's source tree.
 *
 * It is also the home of the sameness question itself: whether two descriptions are
 * the same real-world thing. `ExistingRecord`/`LinkTargets` carry the *decision* a
 * human makes; `InstanceFacts`/`InstanceMatcher` below are the *evidence* vocabulary
 * that informs it, consumed by `rankCandidates` today and by cross-chunk instance
 * alignment after that. Host-specific identifying knowledge lives on the adapter
 * (`ToolAdapter.identifyingFields`); this file deliberately knows nothing about any
 * host — the matcher is wired to a field map at composition time.
 */

import { isExtractedLeaf } from "../provenance/extracted-leaves.js";

/**
 * One record that already exists in the host tool for a collection group.
 *
 * The uuid is the stable identifier the write step uses to choose an update over
 * a create; `fields` are the plain values the host tool returned for it. These are
 * NOT provenance envelopes — they never entered the extraction prompt.
 */
export interface ExistingRecord {
  readonly uuid: string;
  readonly fields: Record<string, unknown>;
}

/**
 * A candidate record after the tool-specific contradiction check has been run.
 *
 * Records are ordered with non-contradicting candidates first, then contradicting
 * ones; within each tier the original order is preserved so the host tool's own
 * sorting (e.g., creation order) survives.
 */
export interface RankedCandidate extends ExistingRecord {
  readonly contradicts: boolean;
}

/**
 * A human decision about whether a captured instance should be linked to an existing
 * record or created as a new one.
 */
export type InstanceLinkDecision =
  { readonly kind: "create" } | { readonly kind: "link"; readonly uuid: string };

/**
 * The link decisions that survive review, aligned with the positional array the
 * patch resolves each collection group to. `null` means "create a new record"; a
 * string is the uuid of the existing record to update.
 */
export type LinkTarget = string | null;

/**
 * Link targets per collection group. The array length matches the resolved instance
 * count for that group, and indices follow the first-mention order established by
 * `buildInstancePositions` (`review.ts`).
 */
export type LinkTargets = Readonly<Record<string, ReadonlyArray<LinkTarget>>>;

// --- The sameness question --------------------------------------------------
//
// The vocabulary below separates "what do we know about an instance" (`InstanceFacts`)
// from "how do two of those compare" (`InstanceMatcher`), so the next consumer of the
// question inherits the evidence shapes and the veto rather than any one adapter's
// matcher.

/**
 * What one side of a sameness comparison knows about one leaf.
 *
 * **`confidence` is deliberately absent.** It is a constant in this library —
 * `provenance.ts` records "uniform-high confidence is not calibration, it is a
 * constant" — so a matcher reading it would be reading noise. Leaving it out of the
 * type says so structurally: there is nothing here to read.
 */
export interface InstanceEvidence {
  readonly value: unknown;
  /**
   * The verbatim transcript quote that justified the value, when the leaf came out of
   * extraction. **No producer exists today**: `use-review.ts` flattens envelopes to
   * bare values and existing records never entered extraction, so nothing populates
   * this in the current pipeline. It is kept because two chunks quoting the identical
   * span are the one kind of positive evidence a host matcher could legitimately read,
   * and the type should not foreclose that — but a matcher must not assume a span is
   * present.
   */
  readonly sourceSpan: string | null;
}

/** What one side of a sameness comparison knows about one instance. */
export interface InstanceFacts {
  /** The collection group the instance belongs to (e.g. `"hvac"`). */
  readonly group: string;
  /** The captured leaves, keyed by the group-local leaf name. */
  readonly leaves: Readonly<Record<string, InstanceEvidence>>;
}

/**
 * Three values, not a boolean. A boolean cannot separate "these disagree" from "neither
 * side said anything", and that collapse is exactly how `confidence` became useless —
 * `SpanGroundedness`'s near-miss tier exists to prevent the same collapse. The consumer
 * maps `"unknown"` to its own safe default; the matcher is never asked to guess.
 */
export type InstanceSameness = "same" | "different" | "unknown";

/** Compares two instances and returns what the evidence supports. */
export type InstanceMatcher = (a: InstanceFacts, b: InstanceFacts) => InstanceSameness;

/**
 * The runtime shape a host's identifying-fields declaration is consumed as: group
 * name to the leaf names that identify an instance of that group. The typed form an
 * adapter *declares* is `IdentifyingFields<V>` in `adapter.ts`; these meet through
 * structural assignability, the same move `RequiredOnCreate` → `RequiredOnCreateMap`
 * makes in `review.ts`.
 */
export type IdentifyingFieldsMap = Readonly<Record<string, readonly string[]>>;

/**
 * The shipped matcher: veto on contradiction, refuse to judge otherwise.
 *
 * Different `group` → `"different"`. Otherwise, for each identifying field named for
 * that group: if both sides carry a non-null, non-undefined value and they are not
 * `Object.is`-equal → `"different"`; in every other case → `"unknown"`.
 *
 * **It never returns `"same"`, and that is the point.** Agreement on identifying
 * fields is not identity: an upstairs and a downstairs Lennox of the same model year
 * agree on every field the adapter names and are two records. A matcher returning
 * `"same"` on agreement would merge them silently, with citations — the exact failure
 * this vocabulary exists to prevent. This is R1.6 §10.4's rule one level down: there,
 * a single matching existing record can never auto-link; here, agreement can never
 * auto-merge. Same asymmetry, same reason — a wrong create is visible at review and
 * removable, a wrong merge is invisible and permanent. Saying `"same"` needs positive
 * evidence core cannot possess, so it is always host judgement.
 *
 * **`Object.is`, not `!==`** — a deliberate change from the first implementation's
 * operator. They differ on exactly two inputs: `NaN` vs `NaN` (with `!==`: a
 * contradiction; here: `"unknown"`) and `+0` vs `-0` (with `!==`: no contradiction;
 * here: `"different"`). Two records whose year is `NaN` are missing a year, not
 * disagreeing about one.
 *
 * **An `Extracted` envelope passed where a value belongs throws.** Two envelopes are
 * never `Object.is`-equal, so a caller who forgets to flatten would otherwise get a
 * matcher that vetoes every pair — a silent, total failure that looks like data. The
 * throw names the field and the flattening contract instead. ADR 0001's precedent:
 * an out-of-range index throws rather than clamping, because silently absorbing a
 * caller bug hides it forever.
 *
 * Nested collections inside an instance are out of scope: comparing a nested group
 * would need that group's identifying fields and a recursive walk over the instance,
 * which no host has asked for yet. When one does, this contract needs a second
 * parameter per nested group — do not approximate it by flattening nested groups into
 * dotted leaf names, which would make a host declare against instance keys that only
 * exist after extraction.
 */
export const contradictionMatcher = (fields?: IdentifyingFieldsMap): InstanceMatcher => {
  const identifying: IdentifyingFieldsMap = fields ?? {};
  return (a, b) => {
    if (a.group !== b.group) return "different";
    const names = identifying[a.group];
    if (names === undefined) return "unknown";
    for (const name of names) {
      const aEvidence = a.leaves[name];
      const bEvidence = b.leaves[name];
      // The flattening-contract check runs before the values are read, and it checks
      // BOTH wrapper levels, because they fail in opposite ways and only one of them
      // is caught by the obvious check:
      //
      //   - `leaves: { model: envelope }` — an `Extracted` is structurally assignable
      //     to `InstanceEvidence` (both carry `value` and `sourceSpan`), so this
      //     typechecks. Reading `.value` off it happens to give the right answer, so
      //     this is a contract violation rather than a bug: `confidence` would ride
      //     along in a type that deliberately excludes it. Rejected to keep the
      //     contract meaning one thing.
      //   - `leaves: { model: { value: envelope, sourceSpan: null } }` — the double
      //     wrap. `isExtractedLeaf` is FALSE for the outer object (no numeric
      //     `confidence`), so the obvious check misses it entirely, and then both
      //     sides compare as envelope objects, which are never `Object.is`-equal:
      //     every pair vetoes. That is the silent total failure this guard exists for,
      //     and checking only the outer level leaves it wide open.
      if (
        aEvidence !== undefined &&
        (isExtractedLeaf(aEvidence) || isExtractedLeaf(aEvidence.value))
      ) {
        throw new TypeError(unflattened(name));
      }
      if (
        bEvidence !== undefined &&
        (isExtractedLeaf(bEvidence) || isExtractedLeaf(bEvidence.value))
      ) {
        throw new TypeError(unflattened(name));
      }
      const aValue = aEvidence?.value;
      const bValue = bEvidence?.value;
      // Null or undefined on either side is missing information, not a disagreement —
      // an abstention cannot contradict, and two abstentions agree about nothing.
      if (
        aValue !== null &&
        aValue !== undefined &&
        bValue !== null &&
        bValue !== undefined &&
        !Object.is(aValue, bValue)
      ) {
        return "different";
      }
    }
    return "unknown";
  };
};

const unflattened = (field: string): string =>
  `contradictionMatcher: identifying field "${field}" arrived as a provenance envelope. ` +
  "Flatten extraction output to plain values before comparing — `InstanceEvidence.value` " +
  "must be the bare leaf value, the way `use-review.ts` flattens `field.extracted.value`.";
