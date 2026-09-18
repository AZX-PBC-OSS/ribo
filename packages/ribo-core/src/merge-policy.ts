import type { Extracted } from "./provenance.js";
import type { LeafPath } from "./extracted-leaves.js";

/**
 * @file The chunk merge policy: for one leaf path, which chunk's envelope wins.
 *
 * The policy returns an **index** into the samples it was handed — not an envelope —
 * for ADR 0001's reason exactly: a policy that cannot construct an envelope cannot
 * fabricate a value, a confidence, or a citation. It can only point at evidence it was
 * given. One arm, not two — unlike a consensus arbiter there is no `contested` state
 * here, because chunks are sequential passages of one document rather than competing
 * samples of one question, and an out-of-range index throws rather than clamping
 * (the walk in `merge-chunk-results.ts` enforces that half).
 *
 * **The else-0 rule is what makes "no chunk committed" honest.** When every chunk
 * abstained, the policy lands on sample 0 — the first null envelope, its citation
 * preserved — rather than inventing a value or dropping the leaf.
 */

/** Decides which chunk's envelope wins for one leaf path, by naming its index. */
export type MergePolicy = (input: {
  readonly path: LeafPath;
  readonly samples: readonly Extracted<unknown>[];
}) => number;

/**
 * The first chunk that committed a non-null value wins; nulls before it are ignored.
 * The default, because earlier text is usually the primary description and a later
 * mention is usually a passing reference. When no chunk committed, returns 0 — the
 * first sample, a null envelope with its citation.
 */
export const firstCommitted: MergePolicy = ({ samples }) => {
  const index = samples.findIndex((sample) => sample.value !== null);
  return index === -1 ? 0 : index;
};

/**
 * The last chunk that committed a non-null value wins — right when later text
 * supersedes earlier, such as a correction dictated after the fact. When no chunk
 * committed, returns 0.
 */
export const lastCommitted: MergePolicy = ({ samples }) => {
  for (let index = samples.length - 1; index >= 0; index--) {
    if (samples[index]!.value !== null) return index;
  }
  return 0;
};
