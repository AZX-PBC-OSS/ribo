import { expect, test } from "vitest";

import type { EvalCompareReport } from "./compare-report.js";
import { renderCompareReport } from "./render-compare.js";
import type { EvalRunRecordCell } from "./record-schema.js";

const side = {
  corpus: { name: "c", fingerprint: "a".repeat(64) },
  identity: { backend: "stub", model: "m", fingerprint: "b".repeat(64), settings: {} },
  totals: {
    cases: 1,
    correct: 0,
    wrong: 0,
    missed: 0,
    hallucinated: 0,
    unscorable: 1,
    judged: 0,
    answered: 0,
  },
  excludedLeaves: 0,
  excludedCases: 0,
};

const render = (left: EvalRunRecordCell, right: EvalRunRecordCell): string =>
  renderCompareReport({
    left: side,
    right: side,
    axes: [],
    leafPaths: ["x"],
    differences: [{ leafPath: "x", caseId: "k", left, right }],
  } as unknown as EvalCompareReport);

test("a pending proposal's expected value is never printed as a plain answer", () => {
  const pending: EvalRunRecordCell = {
    verdict: "unscorable",
    expected: "secret-proposed",
    got: "y",
    origin: "explicit",
    reason: "unreviewed-proposal",
  };
  const confirmed: EvalRunRecordCell = {
    verdict: "wrong",
    expected: "x",
    got: "y",
    origin: "explicit",
  };
  const out = render(pending, confirmed);
  expect(out).toContain("expected (proposed, unreviewed)");
  expect(out).toContain("(unreviewed-proposal)");
  expect(out).not.toContain("secret-proposed");
  expect(out).toContain('expected "x"');
});
