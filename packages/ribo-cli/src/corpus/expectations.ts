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
import type { CorpusCase, ExpectationValue, ScopedDefault } from "./case.js";

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
      /** Where the answer came from. */
      readonly origin: Exclude<ResolvedExpectationOrigin, "none">;
    }
  | {
      readonly status: "declared-absent";
      /** The verbatim span that carries the blanket statement, when recorded. */
      readonly sourceSpan?: string;
      /** Where the answer came from. */
      readonly origin: Exclude<ResolvedExpectationOrigin, "none">;
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
 * @param caseFile - The case whose expectations are resolved.
 * @param leafPath - The dotted leaf path to resolve.
 * @returns The leaf's resolved expectation.
 * @category Eval
 */
export function resolveExpectation(caseFile: CorpusCase, leafPath: string): ResolvedExpectation {
  const explicit = caseFile.expected[leafPath];
  if (explicit) {
    if (explicit.status === "asserted") {
      return {
        status: "asserted",
        value: explicit.value,
        alternatives: explicit.alternatives ?? [],
        sourceSpan: explicit.sourceSpan,
        origin: "explicit",
      };
    }
    return { status: "declared-absent", sourceSpan: explicit.sourceSpan, origin: "explicit" };
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
