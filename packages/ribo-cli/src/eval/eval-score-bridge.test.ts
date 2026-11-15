/**
 * @file The normalisation bridge: the folds that make two values the same
 * answer, and the ones that deliberately do not.
 *
 * The suites here drive the internal seam with hand-built schemas and
 * hand-written results, so each fold is exercised on its own.
 */
import { z } from "zod";
import { expect, test } from "vitest";

import { scoreEvalOverSchema } from "./score.js";
import type { ScoreCase } from "./score.js";
import { envelope, extracted } from "./test-support/score.js";
import type { EvalJsonValue } from "./types.js";

/** The verdict one expected/produced pair earns. */
const verdictOf = (
  schema: z.ZodObject,
  expected: ScoreCase["expected"],
  produced: EvalJsonValue,
): string => {
  const score = scoreEvalOverSchema({
    schema,
    cases: [{ id: "c", expected, defaults: [] }],
    results: [extracted("c", produced)],
  });
  const cell = score.cases[0]?.cells["name"];
  if (cell === undefined) throw new Error("no cell");
  return cell.verdict;
};

/** A one-leaf schema. */
const stringSchema = z.object({ name: z.string() });

test("case, surrounding whitespace and repeated whitespace are folded", () => {
  expect(
    verdictOf(
      stringSchema,
      { name: { status: "asserted", value: "Steel" } },
      {
        name: envelope("steel"),
      },
    ),
  ).toBe("correct");
  expect(
    verdictOf(
      stringSchema,
      { name: { status: "asserted", value: "  steel  " } },
      {
        name: envelope("steel"),
      },
    ),
  ).toBe("correct");
  expect(
    verdictOf(
      stringSchema,
      { name: { status: "asserted", value: "a  b" } },
      {
        name: envelope("a b"),
      },
    ),
  ).toBe("correct");
});

test("trailing sentence punctuation is folded", () => {
  expect(
    verdictOf(
      stringSchema,
      { name: { status: "asserted", value: "steel." } },
      {
        name: envelope("steel"),
      },
    ),
  ).toBe("correct");
  expect(
    verdictOf(
      stringSchema,
      { name: { status: "asserted", value: "steel" } },
      {
        name: envelope("steel!"),
      },
    ),
  ).toBe("correct");
});

test("interior punctuation is not folded", () => {
  expect(
    verdictOf(
      stringSchema,
      { name: { status: "asserted", value: "BW-4471" } },
      {
        name: envelope("BW4471"),
      },
    ),
  ).toBe("wrong");
  // The corpus's own alternative is the way a corpus spells the difference.
  expect(
    verdictOf(
      stringSchema,
      { name: { status: "asserted", value: "BW-4471", alternatives: ["BW4471"] } },
      { name: envelope("BW4471") },
    ),
  ).toBe("correct");
});

test("a number and the text that spells it are the same answer", () => {
  const schema = z.object({ name: z.number() });
  expect(
    verdictOf(schema, { name: { status: "asserted", value: 10 } }, { name: envelope("10") }),
  ).toBe("correct");
  expect(
    verdictOf(schema, { name: { status: "asserted", value: 10 } }, { name: envelope("ten") }),
  ).toBe("correct");
  expect(
    verdictOf(
      schema,
      { name: { status: "asserted", value: 25 } },
      {
        name: envelope("twenty-five"),
      },
    ),
  ).toBe("correct");
  expect(
    verdictOf(
      schema,
      { name: { status: "asserted", value: 25 } },
      {
        name: envelope("twenty five"),
      },
    ),
  ).toBe("correct");
  expect(
    verdictOf(
      schema,
      { name: { status: "asserted", value: 300 } },
      {
        name: envelope("three hundred"),
      },
    ),
  ).toBe("correct");
  expect(
    verdictOf(
      schema,
      { name: { status: "asserted", value: 1200 } },
      {
        name: envelope("one thousand two hundred"),
      },
    ),
  ).toBe("correct");
  expect(
    verdictOf(
      schema,
      { name: { status: "asserted", value: 2.5 } },
      {
        name: envelope("two point five"),
      },
    ),
  ).toBe("correct");
});

test("a value that is not a number is never numerically equal to one that is", () => {
  const schema = z.object({ name: z.number() });
  expect(
    verdictOf(schema, { name: { status: "asserted", value: 10 } }, { name: envelope("banana") }),
  ).toBe("wrong");
  // A range is a string, not a number.
  expect(
    verdictOf(schema, { name: { status: "asserted", value: 10 } }, { name: envelope("10-12") }),
  ).toBe("wrong");
});

test("an enum's members come from the schema, not from a list of their own", () => {
  const schema = z.object({ name: z.enum(["open", "closed"]) });
  // A differently-cased spelling of a declared member is the same member.
  expect(
    verdictOf(
      schema,
      { name: { status: "asserted", value: "Open" } },
      {
        name: envelope("open"),
      },
    ),
  ).toBe("correct");
  // A value matching no declared member is wrong, never close enough.
  expect(
    verdictOf(
      schema,
      { name: { status: "asserted", value: "open" } },
      {
        name: envelope("ajar"),
      },
    ),
  ).toBe("wrong");
});

test("an enum expectation naming no declared member cannot be judged", () => {
  const schema = z.object({ name: z.enum(["open", "closed"]) });
  const score = scoreEvalOverSchema({
    schema,
    cases: [{ id: "c", expected: { name: { status: "asserted", value: "ajar" } }, defaults: [] }],
    results: [extracted("c", { name: envelope("open") })],
  });
  const cell = score.cases[0]?.cells["name"];
  expect(cell?.verdict).toBe("unscorable");
  expect(cell?.reason).toBe("incomparable-expectation");
  // An unscorable cell is in no denominator.
  expect(score.totals.judged).toBe(0);
});

test("booleans compare by what they spell", () => {
  const schema = z.object({ name: z.boolean() });
  expect(
    verdictOf(schema, { name: { status: "asserted", value: true } }, { name: envelope(true) }),
  ).toBe("correct");
  expect(
    verdictOf(schema, { name: { status: "asserted", value: true } }, { name: envelope("TRUE") }),
  ).toBe("correct");
  expect(
    verdictOf(schema, { name: { status: "asserted", value: true } }, { name: envelope(false) }),
  ).toBe("wrong");
});
