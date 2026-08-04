import { describe, expect, test } from "vitest";

import { toOxcTargets } from "./target.js";

describe("toOxcTargets", () => {
  test("keeps the lowest version per family", () => {
    expect(toOxcTargets(["chrome 150", "chrome 121", "chrome 135"])).toEqual(["chrome121"]);
  });

  test("drops Android families, which browserslist reports as current-only", () => {
    // This is the real shape of `baseline widely available`: and_chr reports only 150
    // while desktop chrome goes down to 121. Folding and_chr into a per-family minimum
    // would emit chrome150 — a floor high enough to break every device the target
    // exists to protect. Neither and_chr nor and_ff has an oxc token, and desktop
    // Chrome/Firefox already bind the same syntax.
    expect(toOxcTargets(["chrome 121", "and_chr 150", "and_ff 152"])).toEqual(["chrome121"]);

    // The assertion above documents the real shape but cannot FAIL under the bug: with
    // and_chr folded into chrome, min(121, 150) is still 121. These two use an Android
    // version BELOW its desktop counterpart, so folding would yield chrome115 / firefox118
    // and the test breaks — which is what makes the guard real. The inputs are synthetic
    // (browserslist reports Android above desktop); that is fine, this is a unit test of
    // the mapping, not of browserslist.
    expect(toOxcTargets(["chrome 121", "and_chr 115"])).toEqual(["chrome121"]);
    expect(toOxcTargets(["firefox 122", "and_ff 118"])).toEqual(["firefox122"]);
  });

  test("takes the low end of a version range", () => {
    expect(toOxcTargets(["safari 18.5-18.7"])).toEqual(["safari18.5"]);
  });

  test("compares versions numerically, not lexically", () => {
    // "16.10" sorts BELOW "16.4" as a string, and parseFloat reads it as 16.1.
    // Either bug would publish a floor two minors too high.
    expect(toOxcTargets(["safari 16.10", "safari 16.4"])).toEqual(["safari16.4"]);
  });

  test("maps ios_saf to oxc's ios token", () => {
    expect(toOxcTargets(["ios_saf 17.2"])).toEqual(["ios17.2"]);
  });

  test("ignores families oxc has no token for", () => {
    expect(toOxcTargets(["op_mob 80", "kaios 3.0", "chrome 121"])).toEqual(["chrome121"]);
  });

  test("returns tokens sorted, so the generated file is deterministic", () => {
    expect(toOxcTargets(["safari 17.2", "chrome 121", "edge 121"])).toEqual([
      "chrome121",
      "edge121",
      "safari17.2",
    ]);
  });

  test("returns nothing for an empty query result", () => {
    expect(toOxcTargets([])).toEqual([]);
  });
});
