/**
 * @file The unreviewed-proposal verdict: a pending proposal is never a
 * measurement (R5).
 *
 * The suites here drive the internal seam — a hand-built schema, hand-written
 * proposal-bearing expectations and hand-written results — so the rule is
 * exercised row by row, with no corpus directory and no model call.
 */
import { expect, test } from "vitest";
import { z } from "zod";

import { scoreEvalOverSchema } from "./score.js";
import type { ScoreCase } from "./score.js";
import type { EvalCell, EvalScore } from "./score-types.js";
import { envelope, extracted, failed } from "./test-support/score.js";

/** The schema every suite in this file scores against. */
const SCHEMA = z.object({
  name: z.string(),
  state: z.enum(["open", "closed"]),
  count: z.number(),
});

/** The proposal block a pending entry carries — what the model proposed. */
const proposal = {
  status: "asserted" as const,
  value: "steel",
  evidence: { quote: "steel frame", input: "input.txt" },
  backend: "stub-backend",
  model: "stub-model",
  proposedAt: "2026-11-13T09:00:00.000Z",
};

/** The proposal block a proposed absence carries — a claim of silence. */
const absentProposal = {
  status: "declared-absent" as const,
  backend: "stub-backend",
  model: "stub-model",
  proposedAt: "2026-11-13T09:00:00.000Z",
};

/** The cell one case's one leaf carries. */
const cellOf = (score: EvalScore, caseId: string, path: string): EvalCell => {
  const scored = score.cases.find((entry) => entry.caseId === caseId);
  if (scored === undefined) throw new Error(`no scored case "${caseId}"`);
  const cell = scored.cells[path];
  if (cell === undefined) throw new Error(`no cell for "${path}" in "${caseId}"`);
  return cell;
};

test("a pending asserted entry is unscorable with the reason, whatever the run produced", () => {
  // Every produced outcome — the proposed value itself, a different value,
  // nothing, and a case that failed outright — lands on the same verdict:
  // an unreviewed answer is not a measurement, in no row of the table.
  const pending = (id: string): ScoreCase => ({
    id,
    expected: { name: { status: "asserted", value: "steel", proposal, review: "pending" } },
    defaults: [],
  });
  const score = scoreEvalOverSchema({
    schema: SCHEMA,
    cases: ["the-proposed-value", "another-value", "nothing", "a-failed-case"].map(pending),
    results: [
      extracted("the-proposed-value", { name: envelope("steel") }),
      extracted("another-value", { name: envelope("aluminium") }),
      extracted("nothing", { name: envelope(null) }),
      failed("a-failed-case", "the extraction refused"),
    ],
  });

  for (const id of ["the-proposed-value", "another-value", "nothing", "a-failed-case"]) {
    const cell = cellOf(score, id, "name");
    expect(cell.verdict, id).toBe("unscorable");
    expect(cell.reason, id).toBe("unreviewed-proposal");
  }
});

test("the unscorable cell still carries the proposed value and what the run produced", () => {
  const score = scoreEvalOverSchema({
    schema: SCHEMA,
    cases: [
      {
        id: "proposed",
        expected: {
          name: { status: "asserted", value: "steel", proposal, review: "pending" },
        },
        defaults: [],
      },
    ],
    results: [extracted("proposed", { name: envelope("aluminium") })],
  });

  expect(cellOf(score, "proposed", "name")).toMatchObject({
    verdict: "unscorable",
    reason: "unreviewed-proposal",
    expected: "steel",
    got: "aluminium",
    origin: "explicit",
  });
});

test("a pending absent entry is unscorable with the reason, whatever the run produced", () => {
  const pendingAbsent = (id: string): ScoreCase => ({
    id,
    expected: {
      count: { status: "declared-absent", proposal: absentProposal, review: "pending" },
    },
    defaults: [],
  });
  const score = scoreEvalOverSchema({
    schema: SCHEMA,
    cases: ["a-value", "silence", "a-failed-case"].map(pendingAbsent),
    results: [
      extracted("a-value", { count: envelope(3) }),
      extracted("silence", {}),
      failed("a-failed-case", "the extraction refused"),
    ],
  });

  for (const id of ["a-value", "silence", "a-failed-case"]) {
    const cell = cellOf(score, id, "count");
    // Each produced outcome has its own judged verdict — hallucinated,
    // correct, missed — and none of them may fire: the entry is unreviewed.
    expect(cell.verdict, id).toBe("unscorable");
    expect(cell.reason, id).toBe("unreviewed-proposal");
  }
});

test("confirming the same entry makes it judged", () => {
  const score = scoreEvalOverSchema({
    schema: SCHEMA,
    cases: [
      {
        id: "confirmed",
        expected: {
          name: { status: "asserted", value: "steel", proposal, review: "confirmed" },
          count: {
            status: "declared-absent",
            proposal: absentProposal,
            review: "confirmed",
          },
        },
        defaults: [],
      },
    ],
    results: [extracted("confirmed", { name: envelope("steel") })],
  });

  expect(cellOf(score, "confirmed", "name").verdict).toBe("correct");
  expect(cellOf(score, "confirmed", "name").reason).toBeUndefined();
  expect(cellOf(score, "confirmed", "count").verdict).toBe("correct");
});

test("totals over a mixed case count only reviewed cells", () => {
  const score = scoreEvalOverSchema({
    schema: SCHEMA,
    cases: [
      {
        id: "mixed",
        expected: {
          name: { status: "asserted", value: "steel", proposal, review: "pending" },
          state: { status: "asserted", value: "open" },
        },
        defaults: [],
      },
    ],
    results: [extracted("mixed", { name: envelope("steel"), state: envelope("open") })],
  });

  // One judged cell — the reviewed one. The pending name cell and the
  // unmentioned count cell are both unscorable, in no denominator: not
  // judged, not answered, not correct.
  expect(score.totals.judged).toBe(1);
  expect(score.totals.unscorable).toBe(2);
  expect(score.totals.correct).toBe(1);
  expect(score.totals.answered).toBe(1);
  expect(score.totals.accuracyOverAll).toBe(1);
});

test("a failed case's pending cell is in no denominator either", () => {
  const score = scoreEvalOverSchema({
    schema: SCHEMA,
    cases: [
      {
        id: "broken",
        expected: {
          name: { status: "asserted", value: "steel", proposal, review: "pending" },
          state: { status: "asserted", value: "open" },
        },
        defaults: [],
      },
    ],
    results: [failed("broken", "the extraction refused")],
  });

  // The failure turns the reviewed leaf missed; the pending leaf stays
  // unscorable — it is in no denominator, including a failed case's.
  expect(cellOf(score, "broken", "name")).toMatchObject({
    verdict: "unscorable",
    reason: "unreviewed-proposal",
  });
  expect(cellOf(score, "broken", "state").verdict).toBe("missed");
  expect(score.totals.judged).toBe(1);
  expect(score.totals.unscorable).toBe(2);
});
