import type { core, ZodError } from "zod";

/**
 * @file Rendering a failed parse as something a human can act on — in one place.
 *
 * Three call sites were formatting zod issues into messages, in three slightly different
 * ways, and only one of them handled `issue.path` safely. That is the shape of bug this
 * module exists to stop: the lesson below is easy to learn once and easy to lose the
 * next time someone writes `.join(".")` inline.
 *
 * **`issue.path` is `PropertyKey[]`, not `string[]`.** `Array.prototype.join` calls
 * `String()` on each element, and `String(Symbol())` throws a `TypeError` — so a schema
 * with a symbol key turns a message-builder into a second failure, thrown from inside a
 * queue step whose whole job was to report the first one clearly. {@link zodIssues} maps
 * through `String` explicitly, which is safe for every `PropertyKey`.
 *
 * The two exports split along a real seam rather than a stylistic one. {@link zodIssues}
 * *locates* failures; {@link describeLocated} *renders* located failures, and it is
 * deliberately typed on `{ path, message }` rather than on zod, so `review.ts` can render
 * its own `ReviewIssue`s — which come from completeness checks that zod never saw — with
 * the same punctuation an operator reads everywhere else.
 */

/** A failure and where it happened. Structurally satisfied by `review.ts`'s `ReviewIssue`. */
export interface LocatedIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Every issue in a `ZodError`, with its path flattened to the dotted form the rest of
 * this package addresses leaves by. The root (an issue about the object as a whole)
 * flattens to `""`, which {@link describeLocated} renders as the bare message.
 */
export const zodIssues = (error: ZodError): LocatedIssue[] =>
  error.issues.map((issue: core.$ZodIssue) => ({
    // `String` per element, never a bare `.join(".")` — see the file header.
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));

/** `path: message`, semicolon-separated; an issue with no path renders as its message alone. */
export const describeLocated = (issues: readonly LocatedIssue[]): string =>
  issues.map(({ path, message }) => (path === "" ? message : `${path}: ${message}`)).join("; ");
