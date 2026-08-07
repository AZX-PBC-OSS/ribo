import { expect, test } from "vitest";
import { z } from "zod";

import { describeLocated, zodIssues } from "./zod-issues.js";

test("a nested failure renders as its dotted path plus the message", () => {
  const schema = z.object({ healthSafety: z.object({ ambientCo: z.string() }) });
  const result = schema.safeParse({ healthSafety: { ambientCo: 7 } });

  if (result.success) throw new Error("expected the parse to fail");
  expect(zodIssues(result.error).map((issue) => issue.path)).toEqual(["healthSafety.ambientCo"]);
  expect(describeLocated(zodIssues(result.error))).toContain("healthSafety.ambientCo: ");
});

test("an issue about the object itself renders as the bare message, with no leading colon", () => {
  const result = z.object({ a: z.string() }).safeParse("not an object");

  if (result.success) throw new Error("expected the parse to fail");
  expect(zodIssues(result.error).map((issue) => issue.path)).toEqual([""]);
  expect(describeLocated(zodIssues(result.error)).startsWith(": ")).toBe(false);
});

test("a SYMBOL in the path renders instead of throwing", () => {
  // `issue.path` is `PropertyKey[]`, and this is the case that makes that typing real
  // rather than defensive: `z.record(z.symbol(), …)` genuinely puts a symbol there.
  // `["sym"].join(".")` would throw `TypeError: Cannot convert a Symbol value to a
  // string` — from inside a message-builder whose whole job was to report the FIRST
  // failure clearly, turning one bad parse into an unrelated crash in a queue step.
  //
  // It is reachable: an adapter's `ctxSchema` is a `ZodType<C>` and may be any schema at
  // all, symbol-keyed records included. (`schema` cannot — a zod object's shape is
  // string-keyed — which is exactly why formatting this in one shared place beats
  // remembering it at each call site.)
  const marker = Symbol("assessment");
  const result = z.record(z.symbol(), z.string()).safeParse({ [marker]: 1 });

  if (result.success) throw new Error("expected the parse to fail");
  expect(() => zodIssues(result.error)).not.toThrow();
  expect(zodIssues(result.error).map((issue) => issue.path)).toEqual(["Symbol(assessment)"]);
});

test("several issues are joined, so a UI can show them all at once", () => {
  expect(
    describeLocated([
      { path: "rValue", message: "expected number" },
      { path: "healthSafety.ambientCo", message: "invalid option" },
    ]),
  ).toBe("rValue: expected number; healthSafety.ambientCo: invalid option");
});
