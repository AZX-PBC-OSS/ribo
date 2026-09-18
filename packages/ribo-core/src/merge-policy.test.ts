import { describe, expect, test } from "vitest";

import type { Extracted } from "./provenance.js";
import type { LeafPath } from "./extracted-leaves.js";
import { firstCommitted, lastCommitted } from "./merge-policy.js";

/**
 * Tests for the `MergePolicy` contract and its two shipped policies.
 *
 * The policy returns an INDEX into the samples it was handed — not an envelope — for
 * ADR 0001's reason exactly: a policy that cannot construct an envelope cannot fabricate
 * a value, a confidence, or a citation. One arm, not two: unlike a consensus arbiter
 * there is no `contested` state, because chunks are sequential passages of one document
 * rather than competing samples of one question.
 */

const leaf = <const V>(value: V | null, sourceSpan: string | null): Extracted<V> => ({
  value,
  confidence: 1,
  sourceSpan,
});

const PATH: LeafPath = ["notes"];

describe("firstCommitted", () => {
  test("picks the first committed value, ignoring earlier nulls", () => {
    const samples = [leaf(null, null), leaf("R-38", "R-38"), leaf("R-49", "R-49")];
    expect(firstCommitted({ path: PATH, samples })).toBe(1);
  });

  test("returns an in-range index", () => {
    const samples = [leaf("a", "a"), leaf("b", "b")];
    const index = firstCommitted({ path: PATH, samples });
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(samples.length);
  });

  test("an all-null set returns 0 — the first sample, a null envelope with its citation", () => {
    const samples = [leaf<string>(null, "not going to guess"), leaf<string>(null, null)];
    expect(firstCommitted({ path: PATH, samples })).toBe(0);
  });
});

describe("lastCommitted", () => {
  test("picks the last committed value", () => {
    const samples = [leaf("R-38", "R-38"), leaf(null, null), leaf("R-49", "R-49")];
    expect(lastCommitted({ path: PATH, samples })).toBe(2);
  });

  test("skips a trailing null to find the last committed value", () => {
    const samples = [leaf("R-38", "R-38"), leaf("R-49", "R-49"), leaf(null, null)];
    expect(lastCommitted({ path: PATH, samples })).toBe(1);
  });

  test("returns an in-range index", () => {
    const samples = [leaf("a", "a"), leaf("b", "b")];
    const index = lastCommitted({ path: PATH, samples });
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(samples.length);
  });

  test("an all-null set returns 0", () => {
    const samples = [leaf<string>(null, null), leaf<string>(null, null)];
    expect(lastCommitted({ path: PATH, samples })).toBe(0);
  });
});
