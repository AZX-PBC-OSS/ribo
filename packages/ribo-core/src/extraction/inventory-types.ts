/**
 * @file Generic inventory/fill vocabulary shared by an adapter and a strategy.
 *
 * `Roster`, `RosterCandidate` and `FillScope` describe the contract between a
 * tool adapter (which knows what instances exist in the transcript) and the
 * scoped instance fill strategy (which turns one candidate at a time into a
 * structured extraction). They live in `ribo-core` because the adapter cannot
 * depend on the extractor package — and the scoped instance fill strategy
 * moved into core beside them, so both sides of the contract meet here.
 *
 * Adapters may declare narrower, zod-inferred versions of `Roster` and
 * `RosterCandidate` (e.g. an enum eligibility or a two-branch candidate); those
 * narrower types structurally satisfy the generic interfaces here.
 */

/**
 * One candidate returned by the inventory pass.
 *
 * @category Extraction
 */
export interface RosterCandidate {
  readonly mentionSpan: string;
  readonly discriminator: string;
  readonly distinguishedBy: string | null;
  readonly eligibility: string;
  readonly eligibilitySpan: string | null;
}

/**
 * The house-wide inventory roster: one ordered list per collection group.
 *
 * @category Extraction
 */
export interface Roster {
  readonly [groupKey: string]:
    | readonly RosterCandidate[]
    | {
        readonly stated: "none";
        readonly span: string;
      };
}

/**
 * The scope block passed to `buildFillInstructions` for each per-instance fill.
 *
 * @category Extraction
 */
export interface FillScope {
  /** The group being filled, e.g. `"hvac"`. */
  readonly groupKey: string;
  /** The candidate this fill call is for. */
  readonly positive: RosterCandidate;
  /** The position of {@link positive} within the roster's current candidates. */
  readonly positiveIndex: number;
  /** The other `current` candidates in the same group, declared out of scope. */
  readonly siblings: readonly RosterCandidate[];
  /** Candidates in the same group whose eligibility is not `current`, to be recorded nowhere. */
  readonly excluded: readonly RosterCandidate[];
}
