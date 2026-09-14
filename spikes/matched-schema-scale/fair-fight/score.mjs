/**
 * Fair-fight scoring — uses `spanGroundedness` from `@azx/ribo-core` (imported,
 * not reimplemented) for the three-tier grounded / near-miss / ungrounded check.
 *
 * Replaces the prior harness's `isSpanGrounded` + custom near-miss classifier
 * with the real three-tier function, so every number lines up with
 * `spanGroundedness`'s definition.  The prior harness's `grounded` figure is
 * directly comparable (both use `isSpanGrounded` under the hood), but its
 * near-miss / ungrounded split is NOT: the prior classifier also counted
 * punctuation-insensitive matches and 4-word fragment overlaps as near-miss,
 * while `spanGroundedness` draws the line at case / whitespace / quote /
 * HTML-entity differences only.  This is stricter and is the honest choice for
 * a review card: a paraphrase sharing four words cannot be checked against the
 * document the way a re-spaced quote can.
 *
 * Tiers:
 *   - grounded:    `spanGroundedness` returns "grounded" (verbatim substring)
 *   - near-miss:   `spanGroundedness` returns "near-miss" (case/whitespace/quote diff)
 *   - ungrounded:  `spanGroundedness` returns "ungrounded" (not in the text at all)
 *   - abstained:   no value AND null span (field not stated — a correct null)
 *
 * A null span with a non-null value is "ungrounded" (value claimed without
 * quote) — `spanGroundedness(null, ...)` returns "ungrounded", which is the
 * correct classification.
 */

import { spanGroundedness } from "../../../packages/ribo-core/dist/index.js";

const CONF_PATH_SUFFIX = "extraction_notes.confidence";

export function isConfidenceLeaf(leaf) {
  return leaf.path.endsWith(CONF_PATH_SUFFIX);
}

/**
 * Score a single leaf's span against the transcript.
 */
export function scoreLeaf(leaf, transcript) {
  const hasValue = leaf.value !== null && leaf.value !== undefined && leaf.value !== "";
  if (!hasValue && leaf.sourceSpan === null) {
    return { tier: "abstained", detail: "no value, no span" };
  }
  const groundedness = spanGroundedness(leaf.sourceSpan, transcript);
  return { tier: groundedness, detail: groundedness };
}

/**
 * Score all leaves in an extraction.
 *
 * Returns counts for grounded / near-miss / ungrounded / abstained, plus the
 * same counts with `extraction_notes.confidence` leaves excluded (those leaves
 * ask for a model assessment, not a document fact, so their spans are
 * fabricated by construction).
 */
export function scoreExtraction(leaves, transcript) {
  const counts = { grounded: 0, nearMiss: 0, ungrounded: 0, abstained: 0 };
  const countsExclConf = { grounded: 0, nearMiss: 0, ungrounded: 0, abstained: 0 };
  const details = [];
  let filled = 0;
  let abstainedTotal = 0;

  for (const leaf of leaves) {
    const hasValue = leaf.value !== null && leaf.value !== undefined && leaf.value !== "";
    if (hasValue) filled++;
    else abstainedTotal++;

    const result = scoreLeaf(leaf, transcript);
    const confLeaf = isConfidenceLeaf(leaf);

    const tally = (c) => {
      if (result.tier === "grounded") c.grounded++;
      else if (result.tier === "near-miss") c.nearMiss++;
      else if (result.tier === "ungrounded") c.ungrounded++;
      else c.abstained++;
    };
    tally(counts);
    if (!confLeaf) tally(countsExclConf);

    details.push({ ...leaf, ...result, confLeaf });
  }

  const spanScorable = counts.grounded + counts.nearMiss + counts.ungrounded;
  const groundedPct = spanScorable > 0 ? (counts.grounded / spanScorable) * 100 : 0;

  const spanScorableExcl =
    countsExclConf.grounded + countsExclConf.nearMiss + countsExclConf.ungrounded;
  const groundedPctExclConf =
    spanScorableExcl > 0 ? (countsExclConf.grounded / spanScorableExcl) * 100 : 0;

  return {
    counts,
    countsExclConf,
    filled,
    abstained: abstainedTotal,
    spanScorable,
    groundedPct,
    spanScorableExcl,
    groundedPctExclConf,
    details,
  };
}
