/**
 * @file The pure grounding census — a tally of how well an extraction result is
 * cited (`sp2-judging-combinators-design.md` §4.2, wave-2 plan Task 1). The
 * first judging combinator (`validateExtractor`) hands this tally to a
 * caller-supplied policy, but the tally is useful alone — a host debugging why a
 * result was rejected, or writing a policy of its own, reads the same shape — so
 * it is exported on its own.
 *
 * It is a census, not a judgement: no policy, no threshold, no score (§3, §5).
 * It walks the per-leaf provenance envelopes of an extraction result's fields,
 * records three independent facts about each leaf, and counts them.
 */

import { mapExtractedLeaves } from "./extracted-leaves.js";
import type { LeafPath } from "./extracted-leaves.js";
import { spanGroundedness } from "./provenance.js";
import type { Extracted, SpanGroundedness } from "./provenance.js";

/** The census's record of one leaf: where it is, and how well it is cited. */
export interface CensusLeaf {
  /** Structured path through the fields — object keys and array indices, never a formatted string. */
  readonly path: LeafPath;
  /**
   * The leaf holds a non-null value — a model that answered. An abstention
   * (`value: null`) is an honest one, and is not a citation failure.
   */
  readonly committed: boolean;
  /**
   * The leaf holds a **non-null and non-blank** `sourceSpan` — a model that
   * offered a quote. Blank matters: the envelope schema legalises `""`, and
   * `spanGroundedness("")` returns `"ungrounded"`, the same answer it gives for
   * `null`. Both mean "no checkable quote", so `cited` must not split them on a
   * distinction neither the model nor the schema treats as meaningful.
   */
  readonly cited: boolean;
  /**
   * {@link spanGroundedness} of the leaf's quote — **and `null` when `cited` is
   * false.** Never call `spanGroundedness` on a null (or blank) span and record
   * the answer: it returns `"ungrounded"`, which would mark every honest
   * abstention as a citation failure. `null` is what keeps an abstention
   * distinguishable from a fabrication.
   */
  readonly groundedness: SpanGroundedness | null;
}

/**
 * The census's record of one stated-empty group — a per-group verbatim span
 * where a roster recorded "none of these" (`ExtractionResult.statedEmptyGroups`).
 *
 * Those spans are committed claims with citations, written straight from model
 * output, and a fabricated "there is no attic" quote is exactly the failure
 * `validateExtractor` exists to catch — so the census covers them, and a policy
 * over the leaves alone could not see them at all. Unlike a leaf, a stated-empty
 * entry has no separate committed/cited facts: the entry's existence IS the
 * commitment and the span IS its citation, so there is only the groundedness.
 */
export interface CensusEmptyGroup {
  /** The group's own top-level key — the key `statedEmptyGroups` was keyed by. */
  readonly group: string;
  /** {@link spanGroundedness} of the group's verbatim span, computed the same way a leaf's is. */
  readonly groundedness: SpanGroundedness;
}

/**
 * Counts over {@link GroundingCensus.leaves} — a convenience, not a second
 * source of truth. Every member is derived from the leaves in one pass; a
 * policy that wants something these do not offer walks `leaves`.
 */
export interface GroundingCensusCounts {
  /** Every leaf the walk visited. */
  readonly leaves: number;
  /** Leaves that committed — `committed: true`. */
  readonly committed: number;
  /** Leaves that cited — `cited: true`. */
  readonly cited: number;
  /** Cited leaves whose quote is verbatim in the transcript. */
  readonly grounded: number;
  /** Cited leaves whose quote differs only in case, whitespace runs or quote characters. */
  readonly nearMiss: number;
  /** Cited leaves whose quote is absent from the transcript — the fabrication signal. */
  readonly ungrounded: number;
  /** Stated-empty group spans recorded. */
  readonly emptyGroups: number;
}

/** The tally {@link groundingCensus} produces, and a {@link ValidationPolicy} decides from. */
export interface GroundingCensus {
  /** One entry per leaf, in walk order — depth-first, schema order, array indices ascending. */
  readonly leaves: readonly CensusLeaf[];
  /** One entry per stated-empty group, in `statedEmptyGroups` key order. */
  readonly emptyGroups: readonly CensusEmptyGroup[];
  /** Derived counts over {@link GroundingCensus.leaves} — see {@link GroundingCensusCounts}. */
  readonly counts: GroundingCensusCounts;
}

/**
 * Tally how well an extraction result is cited.
 *
 * `fields` is the enveloped data an extractor returned — whatever
 * `ExtractionResult.fields` holds. `statedEmptyGroups` is the result's own
 * optional bag of per-group "none of these" spans; pass `undefined` when the
 * extractor does not produce one. `transcript` is the **canonical `string`** —
 * what `extract` receives is the `AnnotatedTranscript`, and
 * `spanGroundedness` takes the text (`spanGroundedness(span, transcript.text)`
 * is the repo's precedent). Passing the object would survive a loosely-typed
 * call site and blow up inside the string comparison at runtime, so the
 * parameter is typed `string` and the caller does the unwrapping.
 *
 * Pure: no I/O, no mutation of `fields` — the leaf walk runs as a pure visitor
 * that returns every leaf unchanged.
 */
export const groundingCensus = (
  fields: unknown,
  statedEmptyGroups: Readonly<Record<string, string>> | undefined,
  transcript: string,
): GroundingCensus => {
  const leaves: CensusLeaf[] = [];
  mapExtractedLeaves(fields, [], (leaf: Extracted<unknown>, path: LeafPath) => {
    const span = leaf.sourceSpan;
    const cited = typeof span === "string" && span.trim().length > 0;
    leaves.push({
      path,
      committed: leaf.value !== null && leaf.value !== undefined,
      cited,
      groundedness: cited ? spanGroundedness(span, transcript) : null,
    });
    // A pure visitor: collect the facts, rebuild nothing.
    return leaf;
  });

  const emptyGroups: CensusEmptyGroup[] = Object.entries(statedEmptyGroups ?? {}).map(
    ([group, span]) => ({ group, groundedness: spanGroundedness(span, transcript) }),
  );

  // Counts are derived here, once, from the leaves above — never maintained in
  // parallel with them.
  let committed = 0;
  let cited = 0;
  let grounded = 0;
  let nearMiss = 0;
  let ungrounded = 0;
  for (const entry of leaves) {
    if (entry.committed) committed += 1;
    if (!entry.cited) continue;
    cited += 1;
    if (entry.groundedness === "grounded") grounded += 1;
    else if (entry.groundedness === "near-miss") nearMiss += 1;
    else ungrounded += 1;
  }

  return {
    leaves,
    emptyGroups,
    counts: {
      leaves: leaves.length,
      committed,
      cited,
      grounded,
      nearMiss,
      ungrounded,
      emptyGroups: emptyGroups.length,
    },
  };
};
