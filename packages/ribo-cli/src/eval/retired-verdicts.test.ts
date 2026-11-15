/**
 * @file The retired verdict translation table: every retired spike verdict,
 * and the one generic verdict it landed on.
 *
 * The retired names are written out here rather than imported: the old
 * record's `CELL_VERDICTS` lives in an adapter's acceptance directory, which
 * is not part of that package's published exports, and this package takes no
 * dependency on any adapter. The literal list is therefore the strongest pin
 * available — and a stronger one, since it states the vocabulary rather than
 * agreeing with whatever the other package happens to hold.
 */
import { expect, test } from "vitest";

import { RETIRED_VERDICT_TRANSLATION } from "./retired-verdicts.js";
import { EVAL_VERDICTS } from "./score-types.js";

/** Every retired verdict, and the generic verdict the design's §3 table gives it. */
const EXPECTED: Readonly<Record<string, string>> = {
  correct: "correct",
  "correct-null": "correct",
  wrong: "wrong",
  miss: "missed",
  "miss-excused": "unscorable",
  hallucination: "hallucinated",
  "hallucination-soft": "hallucinated",
  sanctioned: "correct",
  unscorable: "unscorable",
  "health-hallucinated-pass": "hallucinated",
  "health-hallucinated-problem": "hallucinated",
  "health-clean-dropped": "missed",
  "health-miss": "missed",
  "health-wrong": "wrong",
};

test("every retired verdict maps exactly once, and only onto a generic verdict", () => {
  expect(Object.keys(RETIRED_VERDICT_TRANSLATION).sort()).toEqual(Object.keys(EXPECTED).sort());
  for (const [retired, generic] of Object.entries(EXPECTED)) {
    expect(RETIRED_VERDICT_TRANSLATION[retired]).toBe(generic);
    expect(EVAL_VERDICTS).toContain(generic);
  }
});

test("the health vocabulary lands where the design's table says it does", () => {
  expect(RETIRED_VERDICT_TRANSLATION["health-hallucinated-pass"]).toBe("hallucinated");
  expect(RETIRED_VERDICT_TRANSLATION["health-hallucinated-problem"]).toBe("hallucinated");
  expect(RETIRED_VERDICT_TRANSLATION["health-clean-dropped"]).toBe("missed");
  expect(RETIRED_VERDICT_TRANSLATION["health-miss"]).toBe("missed");
  expect(RETIRED_VERDICT_TRANSLATION["health-wrong"]).toBe("wrong");
});
