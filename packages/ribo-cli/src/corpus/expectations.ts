/**
 * @file The expectation precedence rule, implemented once.
 *
 * A leaf's expectation is the explicit entry when the case has one, else the
 * covering default with the longest matching scope, else unmentioned. The
 * rule lives here and nowhere else, so the runner, the scorer and a reader of
 * a run record all see the same answer.
 *
 * Scope matching is at SEGMENT boundaries: the scope `"a"` covers `"a.b"` and
 * never `"ab"`, because a scope is a path prefix and not a string prefix.
 */
import { sameAnswer } from "../eval/score-bridge.js";
import type { CorpusCase, ExpectationEntry, ExpectationValue, ScopedDefault } from "./case.js";

/**
 * Where a resolved expectation came from: an explicit entry, a covering
 * default, or nothing at all.
 *
 * The distinction matters to a reader of a run record: a blanket statement
 * and a per-leaf statement are different claims about the same leaf.
 * @category Eval
 */
export type ResolvedExpectationOrigin = "explicit" | "default" | "none";

/**
 * How an explicit entry's answer came to be what it is (ADR 0049): written
 * by hand, proposed and still pending, or confirmed — unchanged, or changed
 * by the reviewer. The classification lives in ONE place, this file, so a
 * reader of a run record and a reader of the review sheet see the same
 * answer.
 * @category Eval
 */
export type ExpectationReviewClass =
  "hand-written" | "pending" | "accepted-unchanged" | "corrected";

/**
 * A leaf's resolved expectation.
 * @category Eval
 */
export type ResolvedExpectation =
  | {
      readonly status: "asserted";
      /** The value the leaf is expected to carry. */
      readonly value: ExpectationValue;
      /** The acceptable alternative values — a run producing any one is correct. */
      readonly alternatives: readonly ExpectationValue[];
      /** The verbatim span that supports the expectation, when the corpus recorded one. */
      readonly sourceSpan?: string;
      /** Where the answer came from — an explicit entry always. */
      readonly origin: "explicit";
      /** How the answer came to be what it is. */
      readonly reviewClass: ExpectationReviewClass;
      /** The proposal's backend, when the entry carries a proposal. */
      readonly proposerBackend?: string;
      /** The proposal's model, when the entry carries a proposal. */
      readonly proposerModel?: string;
    }
  | {
      readonly status: "declared-absent";
      /** The verbatim span that carries the blanket statement, when recorded. */
      readonly sourceSpan?: string;
      /** Where the answer came from — an explicit entry carries a review class. */
      readonly origin: "explicit";
      /** How the answer came to be what it is. */
      readonly reviewClass: ExpectationReviewClass;
      /** The proposal's backend, when the entry carries a proposal. */
      readonly proposerBackend?: string;
      /** The proposal's model, when the entry carries a proposal. */
      readonly proposerModel?: string;
    }
  | {
      readonly status: "declared-absent";
      /** The verbatim span that carries the blanket statement, when recorded. */
      readonly sourceSpan?: string;
      /** Where the answer came from — a covering default carries no review class. */
      readonly origin: "default";
    }
  | {
      readonly status: "unmentioned";
      /** Where the answer came from: a default that said "unmentioned", or nothing. */
      readonly origin: ResolvedExpectationOrigin;
    };

/**
 * Does one scope string cover one leaf path?
 *
 * The special scope `"*"` covers every leaf; every other scope covers the
 * leaf it names and the leaves under it, matched at segment boundaries.
 * @param scope - The scope string, as the corpus wrote it.
 * @param leafPath - The dotted leaf path to test.
 * @returns Whether the scope covers that leaf.
 * @category Eval
 */
export function scopeCovers(scope: string, leafPath: string): boolean {
  if (scope === "*") return true;
  if (leafPath === scope) return true;
  return leafPath.startsWith(`${scope}.`);
}

/**
 * Classify one explicit entry by how its answer came to be what it is — the
 * ONE copy of the rule (ADR 0049). An entry with no `proposal` is
 * hand-written. A pending proposal stays pending. A confirmed proposal is
 * accepted-unchanged only when the reviewer changed nothing that matters:
 * the entry's status equals the proposal's, its value is the same answer
 * under the scorer's own fold, and it carries no alternative. Any added
 * alternative, changed value or changed status is corrected.
 *
 * A proposal never carries alternatives, so the rule has no
 * removed-alternative comparison to make.
 * @param entry - The explicit entry, as the case file declares it.
 * @returns The entry's review class.
 */
const reviewClassOf = (entry: ExpectationEntry): ExpectationReviewClass => {
  const { proposal, review } = entry;
  if (proposal === undefined) return "hand-written";
  if (review === "pending") return "pending";
  if (entry.status !== proposal.status) return "corrected";
  if (entry.status === "asserted" && proposal.status === "asserted") {
    if (entry.alternatives !== undefined && entry.alternatives.length > 0) return "corrected";
    if (!sameAnswer(entry.value, proposal.value)) return "corrected";
  }
  return "accepted-unchanged";
};

/** The covering default with the longest matching scope, if any covers the leaf. */
const longestCoveringDefault = (
  defaults: readonly ScopedDefault[] | undefined,
  leafPath: string,
): { readonly entry: ScopedDefault; readonly length: number } | undefined => {
  let best: { readonly entry: ScopedDefault; readonly length: number } | undefined;
  for (const entry of defaults ?? []) {
    for (const scope of entry.scope) {
      if (!scopeCovers(scope, leafPath)) continue;
      if (best === undefined || scope.length > best.length) {
        best = { entry, length: scope.length };
      }
    }
  }
  return best;
};

/**
 * Resolve one leaf's expectation for one case.
 *
 * The resolution is total: a path the case never mentions resolves to
 * unmentioned rather than throwing, because the caller decides which leaves
 * it asks about. The path itself is not re-validated here — the loader has
 * already refused a path that is not a leaf of the schema.
 * @param caseFile - The case whose expectations are resolved — its expected
 *   map and its scoped defaults, which is all the rule reads.
 * @param leafPath - The dotted leaf path to resolve.
 * @returns The leaf's resolved expectation.
 * @category Eval
 */
export function resolveExpectation(
  caseFile: Pick<CorpusCase, "expected" | "defaults">,
  leafPath: string,
): ResolvedExpectation {
  const explicit = caseFile.expected[leafPath];
  if (explicit) {
    const review = {
      reviewClass: reviewClassOf(explicit),
      ...(explicit.proposal === undefined
        ? {}
        : { proposerBackend: explicit.proposal.backend, proposerModel: explicit.proposal.model }),
    };
    if (explicit.status === "asserted") {
      return {
        status: "asserted",
        value: explicit.value,
        alternatives: explicit.alternatives ?? [],
        sourceSpan: explicit.sourceSpan,
        origin: "explicit",
        ...review,
      };
    }
    return {
      status: "declared-absent",
      sourceSpan: explicit.sourceSpan,
      origin: "explicit",
      ...review,
    };
  }
  const covering = longestCoveringDefault(caseFile.defaults, leafPath);
  if (covering === undefined) return { status: "unmentioned", origin: "none" };
  if (covering.entry.status === "unmentioned") {
    return { status: "unmentioned", origin: "default" };
  }
  return {
    status: "declared-absent",
    sourceSpan: covering.entry.sourceSpan,
    origin: "default",
  };
}
