import type { LeafInventoryEntry } from "@azx/ribo-core";

/**
 * The reformat-description lint's pinned, minimal directive vocabulary.
 * Case-insensitive, word-boundary matches against each leaf's description.
 * One named constant holds the list so widening is a single reviewable,
 * contract-visible change. The motivation: a description that asks the model
 * to reformat a value produces values that cannot be verbatim spans,
 * undermining span grounding (`docs/guide/provenance.md`'s near-miss tier).
 */
export const REFORMAT_DIRECTIVES = [
  "format",
  "reformat",
  "normalize",
  "normalise",
  "uppercase",
  "lowercase",
  "round to",
  "YYYY",
  "MM/DD",
  "DD/MM",
  "ISO 8601",
  "ISO-8601",
] as const;

const escapeForRegExp = (directive: string): string =>
  directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const PATTERNS: readonly { readonly directive: string; readonly pattern: RegExp }[] =
  REFORMAT_DIRECTIVES.map((directive) => ({
    directive,
    pattern: new RegExp(`\\b${escapeForRegExp(directive)}\\b`, "i"),
  }));

/**
 * One lint finding: the leaf whose description asks for reformatting, the
 * description text verbatim, and the matched directive from the pinned
 * vocabulary.
 */
export interface ReformatFinding {
  /** The leaf's dot-path, as the leaf inventory records it. */
  path: string;
  /** The description text, verbatim. */
  description: string;
  /** The matched directive from {@link REFORMAT_DIRECTIVES}. */
  directive: string;
}

/**
 * Find every leaf whose description asks the model to reformat a value —
 * "formatted as YYYY-MM-DD", "normalize to lowercase" — one finding per leaf,
 * the first matched directive reported when a description names several. The
 * lint is advisory: it never changes an exit-relevant number, and a
 * description that merely describes ("Street address", "as written") never
 * fires.
 */
export function findReformatFindings(entries: readonly LeafInventoryEntry[]): ReformatFinding[] {
  const findings: ReformatFinding[] = [];
  for (const entry of entries) {
    if (entry.description === undefined) continue;
    const matched = PATTERNS.find(({ pattern }) => pattern.test(entry.description!));
    if (matched === undefined) continue;
    findings.push({
      path: entry.path,
      description: entry.description,
      directive: matched.directive,
    });
  }
  return findings;
}
