/**
 * @file Types for instance identity: the boundary where existing records meet review.
 *
 * Existing records enter at review, never at extraction. This file keeps the core
 * vocabulary (`ExistingRecord`, `InstanceLinkDecision`, `LinkTargets`) in one place
 * so the adapter, the review contract and the UI hook can all name them without any
 * package reaching into another's source tree.
 */

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
 * A human decision about whether a dictated instance should be linked to an existing
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
 * {@link buildInstancePositions}.
 */
export type LinkTargets = Readonly<Record<string, ReadonlyArray<LinkTarget>>>;
