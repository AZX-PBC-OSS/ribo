/**
 * @file Zod issues, rendered as sentences a corpus author can act on.
 *
 * A zod issue names a path and a type; a corpus author needs the file, the
 * field and the fix. This module is the one place that translation happens,
 * so every refusal the loader raises reads the same way.
 *
 * An enum refusal names the allowed values and the value the file carried —
 * `the field "provenance": expected one of real, synthetic, got "real-world"`
 * — through the ONE formatter below, never a per-field message: zod's own
 * text does not say what the file said, and a reader with only the installed
 * package has no docs site to look the values up in.
 */

/** The shape of a zod issue this module reads — the parts every issue carries. */
export interface CorpusIssue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly received?: string;
  readonly keys?: readonly string[];
  /** `invalid_value` — zod's enum failure — carries the allowed set. */
  readonly values?: readonly unknown[];
  /** `invalid_union` on a discriminated union's discriminator carries the allowed set. */
  readonly options?: readonly unknown[];
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

/**
 * The allowed set an issue carries, when it is an enum-style refusal: zod's
 * `invalid_value` (an enum) names it as `values`, and an `invalid_union`
 * raised for a discriminated union's discriminator names it as `options`. A
 * plain union's `invalid_union` carries neither, so it falls through to
 * zod's own message. Members that are not primitives say nothing a corpus
 * author could act on, so those fall through too.
 */
const allowedSet = (issue: CorpusIssue): readonly unknown[] | undefined => {
  const allowed =
    issue.code === "invalid_value"
      ? issue.values
      : issue.code === "invalid_union"
        ? issue.options
        : undefined;
  if (allowed === undefined || allowed.length === 0) return undefined;
  return allowed.every((value) => ["string", "number", "boolean"].includes(typeof value))
    ? allowed
    : undefined;
};

/** The value the raw input carries at an issue's path, when the path can be walked. */
const receivedAt = (input: unknown, path: readonly PropertyKey[]): unknown => {
  let node: unknown = input;
  for (const part of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<PropertyKey, unknown>)[part];
  }
  return node;
};

/** One zod issue, rendered as a sentence naming the field and the fix. */
const describeIssue = (issue: CorpusIssue, input: unknown): string => {
  const where = describeLocation(issue.path);
  if (issue.code === "unrecognized_keys") {
    const keys = (issue.keys ?? []).map((key) => `"${key}"`).join(", ");
    return `${where} carries unknown ${keys.length === 1 ? "key" : "keys"} ${keys}`;
  }
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return `${where} is missing`;
  }
  const allowed = allowedSet(issue);
  if (allowed !== undefined) {
    const received = receivedAt(input, issue.path);
    const got = received === undefined ? "" : `, got ${JSON.stringify(received)}`;
    return `${where}: expected one of ${allowed.map((value) => String(value)).join(", ")}${got}`;
  }
  return `${where}: ${issue.message}`;
};

/**
 * Render a list of zod issues as one readable sentence.
 * @param issues - The issues a parse raised.
 * @param input - The raw document the parse ran over, so an enum refusal can
 *   name the value the file carried; absent, the refusal names the allowed
 *   values alone.
 * @returns The rendered sentence.
 * @category Eval
 */
export function describeIssues(issues: readonly CorpusIssue[], input?: unknown): string {
  return issues.map((issue) => describeIssue(issue, input)).join("; ");
}
