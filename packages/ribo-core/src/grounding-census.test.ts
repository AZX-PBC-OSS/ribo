import { describe, expect, test } from "vitest";

import { groundingCensus } from "./grounding-census.js";
import type { Extracted } from "./provenance.js";

/**
 * Tests for the pure grounding census — the tally `validateExtractor`'s policy
 * decides from (`sp2-judging-combinators-design.md` §4.2, wave-2 plan Task 1).
 *
 * Every fixture is hand-built enveloped data: `{ value, confidence, sourceSpan }`
 * leaves in plain object/array structure, the shape `enveloped()` derives and
 * `mapExtractedLeaves` walks. The transcript is a known string — the census takes
 * the canonical `string`, NOT the `AnnotatedTranscript` object, so that is what
 * the tests pass.
 *
 * The case that matters most is the abstained null-span leaf: `spanGroundedness`
 * answers `"ungrounded"` for a null span, so an implementation that called it
 * unconditionally would mark every honest abstention as a citation failure and the
 * default policy would reject nearly every real result. The tests assert
 * `groundedness` IS null explicitly — "not ungrounded" would let `"near-miss"`
 * or any other value pass.
 */

const TRANSCRIPT = [
  "The heating system is a gas furnace.",
  "The attic insulation is R-38.",
  "Water heater: 50 gallons.",
  "There are no solar panels.",
].join(" ");

/** A hand-built leaf envelope, the way model output arrives after parsing. */
const leaf = (value: unknown, sourceSpan: string | null): Extracted<unknown> => ({
  value,
  confidence: 1,
  sourceSpan,
});

/** Fields covering one leaf per combination the census must keep apart. */
const fields = {
  heating: {
    systemType: leaf("gas", "gas furnace"),
    efficiency: leaf(0.8, "80% AFUE"),
  },
  attic: {
    insulation: leaf("R-38", "r-38"),
  },
  solar: {
    present: leaf(null, null),
  },
  waterHeater: {
    capacity: leaf(50, null),
  },
};

const censusFor = (theseFields: unknown, statedEmptyGroups?: Readonly<Record<string, string>>) =>
  groundingCensus(theseFields, statedEmptyGroups, TRANSCRIPT);

describe("groundingCensus — the three facts per leaf", () => {
  test("a committed leaf quoting verbatim text is grounded", () => {
    const census = censusFor(fields);
    expect(census.leaves).toContainEqual({
      path: ["heating", "systemType"],
      committed: true,
      cited: true,
      groundedness: "grounded",
    });
  });

  test("a leaf quoting text that differs only in case is a near-miss, not a fabrication", () => {
    const census = censusFor(fields);
    expect(census.leaves).toContainEqual({
      path: ["attic", "insulation"],
      committed: true,
      cited: true,
      groundedness: "near-miss",
    });
  });

  test("a committed leaf quoting text absent from the transcript is ungrounded", () => {
    const census = censusFor(fields);
    expect(census.leaves).toContainEqual({
      path: ["heating", "efficiency"],
      committed: true,
      cited: true,
      groundedness: "ungrounded",
    });
  });

  test("an abstained leaf with a null span has groundedness null — NOT ungrounded", () => {
    const census = censusFor(fields);
    const abstained = census.leaves.find((entry) =>
      entry.path.length === 2 && entry.path[0] === "solar",
    );
    expect(abstained).toEqual({
      path: ["solar", "present"],
      committed: false,
      cited: false,
      groundedness: null,
    });
    // The explicit pin: `spanGroundedness(null, ...)` returns "ungrounded", which
    // is exactly the wrong answer here. `toEqual` above already demands null, but
    // assert it again on its own so a failure names the distinction.
    expect(abstained?.groundedness).toBe(null);
  });

  test("a committed leaf with a null span carries a null groundedness too", () => {
    const census = censusFor(fields);
    const uncited = census.leaves.find((entry) =>
      entry.path.length === 2 && entry.path[0] === "waterHeater",
    );
    expect(uncited).toEqual({
      path: ["waterHeater", "capacity"],
      committed: true,
      cited: false,
      groundedness: null,
    });
  });
});

describe("groundingCensus — cited means non-null AND non-blank", () => {
  test("a committed leaf with an empty span is uncited with groundedness null", () => {
    // The envelope schema legalises "" and `spanGroundedness("")` is "ungrounded" —
    // the same answer it gives for null. Both mean "no checkable quote", so the
    // census must not split them: a wrong `cited` (merely non-null) would judge
    // this leaf a fabricated citation while the identical null-span leaf above
    // was tolerated.
    const census = censusFor({ heating: { systemType: leaf("gas", "") } });
    expect(census.leaves[0]).toEqual({
      path: ["heating", "systemType"],
      committed: true,
      cited: false,
      groundedness: null,
    });
  });

  test("a whitespace-only span is uncited the same way", () => {
    const census = censusFor({ heating: { systemType: leaf("gas", "   ") } });
    expect(census.leaves[0]).toEqual({
      path: ["heating", "systemType"],
      committed: true,
      cited: false,
      groundedness: null,
    });
  });
});

describe("groundingCensus — paths", () => {
  test("paths are structured: object keys and array indices, never a formatted string", () => {
    const census = censusFor(fields);
    const paths = census.leaves.map((entry) => entry.path);
    expect(paths).toContainEqual(["heating", "systemType"]);
    expect(paths).toContainEqual(["attic", "insulation"]);
  });

  test("a collection group's leaf carries its index", () => {
    const census = censusFor({
      hvac: [{ systemType: leaf("furnace", "gas furnace") }],
    });
    expect(census.leaves[0]?.path).toEqual(["hvac", 0, "systemType"]);
  });

  test("an array of envelopes — a primitive collection — indexes too", () => {
    const census = censusFor({ tags: [leaf("drafty", "drafty")] });
    expect(census.leaves[0]?.path).toEqual(["tags", 0]);
  });
});

describe("groundingCensus — statedEmptyGroups", () => {
  test("each stated-empty group is one entry, groundedness computed the same way", () => {
    const census = censusFor(
      { heating: { systemType: leaf("gas", "gas furnace") } },
      { solar: "There are no solar panels.", ev: "no electric vehicle charger was seen" },
    );
    expect(census.emptyGroups).toEqual([
      { group: "solar", groundedness: "grounded" },
      { group: "ev", groundedness: "ungrounded" },
    ]);
  });

  test("an absent statedEmptyGroups records no empty groups", () => {
    const census = censusFor(fields);
    expect(census.emptyGroups).toEqual([]);
  });
});

describe("groundingCensus — counts are a convenience over leaves", () => {
  test("counts agree with the leaves they are derived from", () => {
    // 6 leaves: 2 grounded citations, 1 near-miss, 1 ungrounded, 1 committed
    // uncited, 1 honest abstention. One stated-empty group.
    const census = censusFor(
      {
        ...fields,
        hvac: [{ systemType: leaf("furnace", "gas furnace") }],
      },
      { solar: "There are no solar panels." },
    );
    expect(census.counts).toEqual({
      leaves: 6,
      committed: 5,
      cited: 4,
      grounded: 2,
      nearMiss: 1,
      ungrounded: 1,
      emptyGroups: 1,
    });
  });

  test("counts of grounded + nearMiss + ungrounded equal cited", () => {
    const census = censusFor(fields, { solar: "There are no solar panels." });
    const { cited, grounded, nearMiss, ungrounded } = census.counts;
    expect(grounded + nearMiss + ungrounded).toBe(cited);
  });
});
