import { describe, expect, test } from "vitest";

import type { Extracted } from "../provenance/provenance.js";
import { majorityValues, unanimousValues } from "./consensus-arbiter.js";

/**
 * Tests for the `ConsensusArbiter` contract and the two shipped policies
 * (`sp2-judging-combinators-design.md` §4.1, ADR 0001).
 *
 * The pin that matters most replaces the design's first draft's two type-level
 * ones: a policy returns an INDEX, not an envelope, so there is no fabricated
 * return to `@ts-expect-error` against. The replacement assertion is on the
 * returned index resolving — by IDENTITY, not equality — to an envelope drawn
 * from the `samples` the policy was handed. Identity because two envelopes with
 * equal fields are not the same evidence: the guarantee the index buys is that
 * the combinator can only ever emit an envelope a sample actually produced.
 */

/** A hand-built leaf envelope, the way model output arrives after parsing. */
const leaf = (value: unknown, sourceSpan: string | null): Extracted<unknown> => ({
  value,
  confidence: 1,
  sourceSpan,
});

/**
 * The envelope the returned verdict names, resolved through the samples it was
 * handed. A verdict naming an out-of-range index fails here — which is the
 * range guarantee itself: every returned index must be in range for the
 * samples given.
 */
const named = (
  verdict: ReturnType<typeof unanimousValues>,
  samples: readonly Extracted<unknown>[],
): Extracted<unknown> => {
  const index = "accept" in verdict ? verdict.accept : verdict.contested;
  const sample = samples[index];
  if (sample === undefined) {
    throw new Error(`the verdict named index ${index}, outside the ${samples.length} samples`);
  }
  return sample;
};

describe("unanimousValues", () => {
  test("accepts index 0 when every sample's value is equal", () => {
    const first = leaf("gas", "gas furnace");
    const samples = [first, leaf("gas", "The heating system is a gas furnace.")];
    const verdict = unanimousValues({ path: ["heating", "systemType"], samples });

    expect(verdict).toEqual({ accept: 0 });
    // Identity, not equality — the named sample IS the first, not a lookalike.
    expect(named(verdict, samples)).toBe(first);
  });

  test("contests index 0 on a dissenter", () => {
    const samples = [leaf("gas", "gas furnace"), leaf("oil", "oil furnace")];
    const verdict = unanimousValues({ path: ["heating", "systemType"], samples });

    expect(verdict).toEqual({ contested: 0 });
    expect(named(verdict, samples)).toBe(samples[0]);
  });

  test("contests when one sample abstains and another commits", () => {
    // The model contradicting itself is the case consensus exists to catch: a
    // null beside a committed value is a disagreement, not an agreement about
    // "nothing".
    const samples = [leaf(null, null), leaf("gas", "gas furnace")];
    const verdict = unanimousValues({ path: ["heating", "systemType"], samples });

    expect(verdict).toEqual({ contested: 0 });
    expect(named(verdict, samples)).toBe(samples[0]);
  });

  test("compares values only — different spans over the same value still accept", () => {
    // Two samples can quote different sentences and mean the same value, so
    // requiring span equality would null nearly everything (design §4.1).
    const samples = [leaf("gas", "gas furnace"), leaf("gas", "it's a gas furnace, 80 AFUE")];
    expect(unanimousValues({ path: ["heating", "systemType"], samples })).toEqual({ accept: 0 });
  });
});

describe("majorityValues", () => {
  test("accepts the first index holding a 2-of-3 majority value", () => {
    const samples = [leaf("oil", "oil furnace"), leaf("gas", "gas furnace"), leaf("gas", "gas")];
    const verdict = majorityValues({ path: ["heating", "systemType"], samples });

    // The FIRST index HOLDING the majority value, not index 0: "gas" is the
    // majority and first appears at index 1.
    expect(verdict).toEqual({ accept: 1 });
    expect(named(verdict, samples)).toBe(samples[1]);
  });

  test("accepts index 0 when the majority value is already there", () => {
    const first = leaf("gas", "gas furnace");
    const samples = [first, leaf("oil", "oil furnace"), leaf("gas", "gas")];
    const verdict = majorityValues({ path: ["heating", "systemType"], samples });

    expect(verdict).toEqual({ accept: 0 });
    expect(named(verdict, samples)).toBe(first);
  });

  test("keeps a committed value against one dissenting null", () => {
    // The design's must-fail test: two agreeing with one dissenting null keep
    // under `majorityValues` what `unanimousValues` contests.
    const samples = [leaf("gas", "gas furnace"), leaf("gas", "gas"), leaf(null, null)];
    const verdict = majorityValues({ path: ["heating", "systemType"], samples });

    expect(verdict).toEqual({ accept: 0 });
    expect(named(verdict, samples)).toBe(samples[0]);
  });

  test("accepts a null majority — the policies differ in threshold, not in what counts as a value", () => {
    // `unanimousValues` already accepts an all-null unanimous set, so a
    // majority of nulls is the same accepted abstention at a lower bar. The
    // abstention keeps the first sample's citation, exactly as a committed
    // majority would.
    const first = leaf(null, null);
    const samples = [first, leaf(null, null), leaf("gas", "gas furnace")];
    const verdict = majorityValues({ path: ["heating", "systemType"], samples });

    expect(verdict).toEqual({ accept: 0 });
    expect(named(verdict, samples)).toBe(first);
  });

  test("contests a three-way split", () => {
    const samples = [leaf("gas", "gas"), leaf("oil", "oil"), leaf("propane", "propane")];
    const verdict = majorityValues({ path: ["heating", "systemType"], samples });

    expect(verdict).toEqual({ contested: 0 });
    expect(named(verdict, samples)).toBe(samples[0]);
  });

  test("contests a 1-1 tie", () => {
    const samples = [leaf("gas", "gas"), leaf("oil", "oil")];
    const verdict = majorityValues({ path: ["heating", "systemType"], samples });

    expect(verdict).toEqual({ contested: 0 });
    expect(named(verdict, samples)).toBe(samples[0]);
  });
});
