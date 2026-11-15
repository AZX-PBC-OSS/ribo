/**
 * @file The scorer's verdict matrix: every row of the design's §2 table, and
 * the counts and rates that follow from it.
 *
 * The suites here drive the internal seam — a hand-built schema, hand-written
 * expectations and hand-written results — so each row of the table is
 * exercised on its own, with no corpus directory and no model call.
 */
import { z } from "zod";
import { expect, test } from "vitest";

import { walkFieldInventory } from "../inspect/field-inventory.js";
import { EvalError } from "./error.js";
import { scoreEvalOverSchema } from "./score.js";
import type { ScoreCase } from "./score.js";
import type { EvalCell, EvalScore } from "./score-types.js";
import { envelope, extracted, failed } from "./test-support/score.js";
import type { EvalCaseResult } from "./types.js";

/** The schema every suite in this file scores against. */
const SCHEMA = z.object({
  name: z.string(),
  state: z.enum(["open", "closed"]),
  count: z.number(),
});

/** One case per row of the verdict table. */
const CASES: readonly ScoreCase[] = [
  { id: "match", expected: { name: { status: "asserted", value: "steel" } }, defaults: [] },
  {
    id: "alternative",
    expected: { name: { status: "asserted", value: "BW-4471", alternatives: ["BW4471"] } },
    defaults: [],
  },
  { id: "mismatch", expected: { name: { status: "asserted", value: "steel" } }, defaults: [] },
  { id: "abstain", expected: { name: { status: "asserted", value: "steel" } }, defaults: [] },
  { id: "absent-quiet", expected: { count: { status: "declared-absent" } }, defaults: [] },
  { id: "absent-loud", expected: { count: { status: "declared-absent" } }, defaults: [] },
  { id: "unmentioned", expected: {}, defaults: [] },
  { id: "incomparable", expected: { state: { status: "asserted", value: "ajar" } }, defaults: [] },
];

/** The run the table is scored against. */
const RESULTS: readonly EvalCaseResult[] = [
  extracted("match", { name: envelope("steel") }),
  extracted("alternative", { name: envelope("BW4471") }),
  extracted("mismatch", { name: envelope("aluminium") }),
  extracted("abstain", { name: envelope(null) }),
  extracted("absent-quiet", {}),
  extracted("absent-loud", { count: envelope(3) }),
  extracted("unmentioned", { name: envelope("steel") }),
  extracted("incomparable", { state: envelope("open") }),
];

/** The cell one case's one leaf carries. */
const cellOf = (score: EvalScore, caseId: string, path: string): EvalCell => {
  const scored = score.cases.find((entry) => entry.caseId === caseId);
  if (scored === undefined) throw new Error(`no scored case "${caseId}"`);
  const cell = scored.cells[path];
  if (cell === undefined) throw new Error(`no cell for "${path}" in "${caseId}"`);
  return cell;
};

/** Score the table. */
const scoreTable = (): EvalScore =>
  scoreEvalOverSchema({ schema: SCHEMA, cases: CASES, results: RESULTS });

test("every row of the verdict table has its verdict", () => {
  const score = scoreTable();

  expect(cellOf(score, "match", "name").verdict).toBe("correct");
  expect(cellOf(score, "alternative", "name").verdict).toBe("correct");
  expect(cellOf(score, "mismatch", "name").verdict).toBe("wrong");
  expect(cellOf(score, "abstain", "name").verdict).toBe("missed");
  expect(cellOf(score, "absent-quiet", "count").verdict).toBe("correct");
  expect(cellOf(score, "absent-loud", "count").verdict).toBe("hallucinated");
  expect(cellOf(score, "unmentioned", "name").verdict).toBe("unscorable");
  expect(cellOf(score, "unmentioned", "name").reason).toBe("unmentioned");
  expect(cellOf(score, "incomparable", "state").verdict).toBe("unscorable");
  expect(cellOf(score, "incomparable", "state").reason).toBe("incomparable-expectation");
});

test("the cell carries what it judged, and where the expectation came from", () => {
  const score = scoreTable();

  expect(cellOf(score, "match", "name")).toMatchObject({
    expected: "steel",
    got: "steel",
    origin: "explicit",
  });
  // An expectation the corpus spelled with a source span carries it, and the
  // span is carried rather than scored.
  expect(cellOf(score, "match", "name").sourceSpan).toBeUndefined();
  // A leaf the corpus says nothing about carries no expectation.
  expect(cellOf(score, "unmentioned", "name")).toMatchObject({ expected: null, origin: "none" });
  // A declared-absent leaf carries no expected value either.
  expect(cellOf(score, "absent-quiet", "count")).toMatchObject({ expected: null, got: null });
});

test("an expectation resolved through a default behaves like an explicit one", () => {
  const score = scoreEvalOverSchema({
    schema: SCHEMA,
    cases: [
      {
        id: "blanket",
        expected: {},
        defaults: [{ scope: ["name", "state"], status: "declared-absent", sourceSpan: "nothing" }],
      },
    ],
    results: [extracted("blanket", { name: envelope("steel"), state: envelope("open") })],
  });

  expect(cellOf(score, "blanket", "name").verdict).toBe("hallucinated");
  expect(cellOf(score, "blanket", "name").origin).toBe("default");
  expect(cellOf(score, "blanket", "state").verdict).toBe("hallucinated");
  // The corpus's own span is carried, never scored.
  expect(cellOf(score, "blanket", "name").sourceSpan).toBe("nothing");
});

test("a default that says unmentioned leaves the leaf unjudged", () => {
  const score = scoreEvalOverSchema({
    schema: SCHEMA,
    cases: [{ id: "silent", expected: {}, defaults: [{ scope: ["name"], status: "unmentioned" }] }],
    results: [extracted("silent", { name: envelope("steel") })],
  });

  expect(cellOf(score, "silent", "name").verdict).toBe("unscorable");
  expect(cellOf(score, "silent", "name").reason).toBe("unmentioned");
  expect(cellOf(score, "silent", "name").origin).toBe("default");
});

test("a failed case is scored as an empty extraction", () => {
  const score = scoreEvalOverSchema({
    schema: SCHEMA,
    cases: [
      {
        id: "broken",
        expected: {
          name: { status: "asserted", value: "steel" },
          count: { status: "declared-absent" },
        },
        defaults: [],
      },
    ],
    results: [failed("broken", "the endpoint refused the request")],
  });

  expect(cellOf(score, "broken", "name").verdict).toBe("missed");
  expect(cellOf(score, "broken", "count").verdict).toBe("correct");
  expect(cellOf(score, "broken", "state").verdict).toBe("unscorable");
  // The failure's message travels with the case, so a reader can tell "missed
  // because the case failed" from "missed because the model abstained".
  expect(score.cases[0]?.error).toBe("the endpoint refused the request");
  expect(score.cases[0]?.status).toBe("failed");
  // A failed run's answer rate is zero, not a quiet null.
  expect(score.totals.judged).toBeGreaterThan(0);
  expect(score.totals.answered).toBe(0);
  expect(score.totals.answerRate).toBe(0);
  expect(score.totals.accuracyOverAnswered).toBeNull();
});

test("the totals count every verdict and compute the three rates", () => {
  const score = scoreEvalOverSchema({
    schema: z.object({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
      f: z.string(),
    }),
    cases: [
      {
        id: "mixed",
        expected: {
          a: { status: "asserted", value: "x" },
          b: { status: "asserted", value: "y" },
          c: { status: "asserted", value: "z" },
          d: { status: "declared-absent" },
          e: { status: "declared-absent" },
        },
        defaults: [],
      },
    ],
    results: [
      extracted("mixed", {
        a: envelope("x"),
        b: envelope("wrong"),
        c: envelope(null),
        e: envelope("v"),
        f: envelope("whatever"),
      }),
    ],
  });

  expect(score.totals).toMatchObject({
    cases: 1,
    correct: 2,
    wrong: 1,
    missed: 1,
    hallucinated: 1,
    unscorable: 1,
    judged: 5,
    // The declared-absent leaf that abstained is correct but unanswered.
    answered: 3,
  });
  expect(score.totals.answerRate).toBeCloseTo(3 / 5);
  expect(score.totals.accuracyOverAnswered).toBeCloseTo(1 / 3);
  expect(score.totals.accuracyOverAll).toBeCloseTo(2 / 5);
  // The unscorable cell is in the grid and in the totals, and in no
  // denominator.
  expect(Object.keys(score.cases[0]?.cells ?? {})).toHaveLength(6);
});

test("the three rates are always present, and null when a denominator is zero", () => {
  const score = scoreEvalOverSchema({
    schema: z.object({ a: z.string() }),
    cases: [{ id: "silent", expected: {}, defaults: [] }],
    results: [extracted("silent", { a: envelope("x") })],
  });

  expect(score.totals).toHaveProperty("answerRate", null);
  expect(score.totals).toHaveProperty("accuracyOverAnswered", null);
  expect(score.totals).toHaveProperty("accuracyOverAll", null);
  expect(score.totals.judged).toBe(0);
});

test("the leaf set is the field inventory's, in order", () => {
  const score = scoreTable();
  expect(score.leafPaths).toEqual(walkFieldInventory(SCHEMA).map((entry) => entry.path));
  // The grid is dense: every leaf has a cell in every case.
  for (const entry of score.cases) {
    expect(Object.keys(entry.cells)).toEqual([...score.leafPaths]);
  }
});

test("a malformed pairing of cases and results is refused", () => {
  expect(() =>
    scoreEvalOverSchema({
      schema: SCHEMA,
      cases: [{ id: "known", expected: {}, defaults: [] }],
      results: [extracted("stranger", { name: envelope("x") })],
    }),
  ).toThrow(EvalError);
  expect(() =>
    scoreEvalOverSchema({
      schema: SCHEMA,
      cases: [{ id: "known", expected: {}, defaults: [] }],
      results: [extracted("stranger", { name: envelope("x") })],
    }),
  ).toThrow(/stranger/);

  expect(() =>
    scoreEvalOverSchema({
      schema: SCHEMA,
      cases: [{ id: "known", expected: {}, defaults: [] }],
      results: [],
    }),
  ).toThrow(/known/);

  expect(() =>
    scoreEvalOverSchema({
      schema: SCHEMA,
      cases: [{ id: "known", expected: {}, defaults: [] }],
      results: [
        extracted("known", { name: envelope("x") }),
        extracted("known", { name: envelope("y") }),
      ],
    }),
  ).toThrow(/known/);
});
