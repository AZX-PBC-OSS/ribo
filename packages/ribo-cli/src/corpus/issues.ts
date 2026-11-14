/**
 * @file Zod issues, rendered as sentences a corpus author can act on.
 *
 * A zod issue names a path and a type; a corpus author needs the file, the
 * field and the fix. This module is the one place that translation happens,
 * so every refusal the loader raises reads the same way.
 */

/** The shape of a zod issue this module reads — the parts every issue carries. */
export interface CorpusIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly received?: string;
  readonly keys?: readonly string[];
}

/** Where an issue sits, in the words a corpus author reads. */
const describeLocation = (path: readonly PropertyKey[]): string => {
  const parts = path.map((part) => String(part));
  if (parts.length === 0) return "the document";
  if (parts[0] === "expected" && parts.length >= 2) {
    const leaf = parts[1] ?? "";
    const within = parts.slice(2);
    return within.length === 0
      ? `the expected entry "${leaf}"`
      : `the expected entry "${leaf}" (at "${within.join(".")}")`;
  }
  return `the field "${parts.join(".")}"`;
};

/** One zod issue, rendered as a sentence naming the field and the fix. */
const describeIssue = (issue: CorpusIssue): string => {
  const where = describeLocation(issue.path);
  if (issue.code === "unrecognized_keys") {
    const keys = (issue.keys ?? []).map((key) => `"${key}"`).join(", ");
    return `${where} carries unknown ${keys.length === 1 ? "key" : "keys"} ${keys}`;
  }
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return `${where} is missing`;
  }
  return `${where}: ${issue.message}`;
};

/**
 * Render a list of zod issues as one readable sentence.
 * @param issues - The issues a parse raised.
 * @returns The rendered sentence.
 * @category Eval
 */
export function describeIssues(issues: readonly CorpusIssue[]): string {
  return issues.map((issue) => describeIssue(issue)).join("; ");
}
