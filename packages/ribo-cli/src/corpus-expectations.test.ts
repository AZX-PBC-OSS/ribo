/**
 * @file The expectation precedence rule's own tests: an explicit entry beats
 * a covering default, the longest matching scope wins among defaults, and a
 * leaf nothing covers is unmentioned.
 */
import { expect, test } from "vitest";

import { CorpusCaseSchema } from "./corpus/case.js";
import type { CorpusCase } from "./corpus/case.js";
import { resolveExpectation } from "./corpus/expectations.js";

/** Parse a case document the way the loader parses one. */
const aCase = (document: Record<string, unknown>): CorpusCase =>
  CorpusCaseSchema.parse({
    id: "case",
    kind: "transcript",
    expected: {},
    ...document,
  });

test("an explicit entry beats a covering default", () => {
  const caseFile = aCase({
    expected: {
      "a.b": { status: "asserted", value: "kept" },
    },
    defaults: [{ scope: "a", status: "declared-absent" }],
  });
  expect(resolveExpectation(caseFile, "a.b")).toMatchObject({
    status: "asserted",
    value: "kept",
    origin: "explicit",
  });
});

test("the longest matching scope wins among covering defaults", () => {
  const caseFile = aCase({
    defaults: [
      { scope: "a", status: "declared-absent" },
      { scope: "a.b", status: "unmentioned" },
    ],
  });
  expect(resolveExpectation(caseFile, "a.b")).toMatchObject({
    status: "unmentioned",
    origin: "default",
  });
  expect(resolveExpectation(caseFile, "a.c")).toMatchObject({
    status: "declared-absent",
    origin: "default",
  });
});

test('the scope "*" covers every leaf', () => {
  const caseFile = aCase({
    defaults: [{ scope: "*", status: "declared-absent" }],
  });
  expect(resolveExpectation(caseFile, "a.b.c")).toMatchObject({ status: "declared-absent" });
  expect(resolveExpectation(caseFile, "z")).toMatchObject({ status: "declared-absent" });
});

test("a scope matches at segment boundaries only", () => {
  const caseFile = aCase({
    defaults: [{ scope: "a", status: "declared-absent" }],
  });
  expect(resolveExpectation(caseFile, "a.b")).toMatchObject({ status: "declared-absent" });
  // "ab" is not under "a" — the scope is a path prefix, not a string prefix.
  expect(resolveExpectation(caseFile, "ab")).toMatchObject({ status: "unmentioned" });
});

test("a scope equal to a leaf path covers that leaf and the leaves under it", () => {
  const caseFile = aCase({
    defaults: [{ scope: "a.b", status: "declared-absent" }],
  });
  expect(resolveExpectation(caseFile, "a.b")).toMatchObject({ status: "declared-absent" });
  // The scope is a path prefix, so the leaves under it are covered too.
  expect(resolveExpectation(caseFile, "a.b.c")).toMatchObject({ status: "declared-absent" });
  expect(resolveExpectation(caseFile, "a")).toMatchObject({ status: "unmentioned" });
  expect(resolveExpectation(caseFile, "ab")).toMatchObject({ status: "unmentioned" });
});

test("a leaf nothing covers is unmentioned", () => {
  const caseFile = aCase({});
  expect(resolveExpectation(caseFile, "a.b")).toMatchObject({
    status: "unmentioned",
    origin: "none",
  });
});

test("a default's scope is normalized to a read-only array", () => {
  const caseFile = aCase({
    defaults: [{ scope: ["a", "b"], status: "declared-absent" }],
  });
  expect(caseFile.defaults?.[0]?.scope).toEqual(["a", "b"]);
  expect(resolveExpectation(caseFile, "b.c")).toMatchObject({ status: "declared-absent" });
});

test("an explicit entry's alternatives and source span are carried", () => {
  const caseFile = aCase({
    expected: {
      "a.b": { status: "asserted", value: "one", alternatives: ["two"], sourceSpan: "one two" },
    },
  });
  expect(resolveExpectation(caseFile, "a.b")).toMatchObject({
    status: "asserted",
    value: "one",
    alternatives: ["two"],
    sourceSpan: "one two",
  });
});
