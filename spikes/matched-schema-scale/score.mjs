/**
 * Scoring module — uses `isSpanGrounded` from `@azx/ribo-core` (imported, not
 * reimplemented) for the binary grounded/ungrounded check, plus a near-miss
 * classification adapted from `spikes/extraction-snuggpro/score.mjs`.
 *
 * Three tiers:
 *   - grounded:     `isSpanGrounded(span, text)` returns true (verbatim substring)
 *   - near-miss:    not verbatim, but a normalised or partial fragment matches
 *   - ungrounded:   no substantial fragment found in the text
 *
 * A null span with a null value is "abstained" (not scored for grounding).
 * A null span with a non-null value is "ungrounded" (value claimed without quote).
 * An empty-string span is "ungrounded" (grounds for nothing).
 */

import { isSpanGrounded } from "../../packages/ribo-core/dist/index.js";

const normText = (s) =>
  s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

function classifyNearMiss(span, transcript) {
  if (typeof span !== "string" || span.length === 0) {
    return { tier: "ungrounded", detail: "empty span — grounds for nothing" };
  }
  const nt = normText(transcript);
  const ns = normText(span);
  if (nt.includes(ns))
    return { tier: "near-miss", detail: "differs only in case/whitespace/quotes" };
  const strip = (s) =>
    s
      .replace(/[^a-z0-9 ]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  if (strip(nt).includes(strip(ns)))
    return { tier: "near-miss", detail: "differs only in punctuation" };
  const words = ns.split(" ").filter(Boolean);
  for (let w = Math.min(6, words.length); w >= 4; w--) {
    for (let i = 0; i + w <= words.length; i++) {
      if (nt.includes(words.slice(i, i + w).join(" "))) {
        return {
          tier: "near-miss",
          detail: `only a ${w}-word fragment matches (paraphrase or join)`,
        };
      }
    }
  }
  return { tier: "ungrounded", detail: "no substantial fragment found in the text" };
}

export function scoreSpan(span, transcript) {
  if (span === null) return { tier: "abstained", detail: "null span" };
  if (isSpanGrounded(span, transcript)) return { tier: "grounded", detail: "exact substring" };
  return classifyNearMiss(span, transcript);
}

export function scoreExtraction(leaves, transcript) {
  const counts = { grounded: 0, nearMiss: 0, ungrounded: 0, abstained: 0 };
  const details = [];
  let filled = 0;
  let abstained = 0;

  for (const leaf of leaves) {
    const hasValue = leaf.value !== null && leaf.value !== undefined && leaf.value !== "";
    if (hasValue) filled++;
    else abstained++;

    if (!hasValue && leaf.sourceSpan === null) {
      counts.abstained++;
      details.push({ ...leaf, ...{ tier: "abstained", detail: "no value, no span" } });
      continue;
    }

    const result = scoreSpan(leaf.sourceSpan, transcript);
    if (result.tier === "grounded") counts.grounded++;
    else if (result.tier === "near-miss") counts.nearMiss++;
    else if (result.tier === "ungrounded") counts.ungrounded++;
    else counts.abstained++;

    details.push({ ...leaf, ...result });
  }

  const valueClaiming = filled;
  const spanScorable = counts.grounded + counts.nearMiss + counts.ungrounded;
  const groundedPct = spanScorable > 0 ? (counts.grounded / spanScorable) * 100 : 0;

  return {
    counts,
    filled,
    abstained,
    valueClaiming,
    spanScorable,
    groundedPct,
    details,
  };
}

export function findUngroundedLeaves(leaves, transcript) {
  return leaves.filter((l) => {
    if (l.value === null || l.value === undefined || l.value === "") return false;
    if (l.sourceSpan === null) return true;
    return !isSpanGrounded(l.sourceSpan, transcript);
  });
}

export function findAbstainedLeaves(leaves) {
  return leaves.filter((l) => l.value === null || l.value === undefined || l.value === "");
}
