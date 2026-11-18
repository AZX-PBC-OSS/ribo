/**
 * @file One cell's verdict: what the corpus expected, what the run produced,
 * and the verdicts that follow.
 *
 * The rules are the design's own:
 *
 * - asserted and the expected value (or one of the leaf's alternatives) —
 *   `correct`;
 * - asserted and a different value — `wrong`;
 * - asserted and no value — `missed`;
 * - declared-absent and no value — `correct`, unless the case failed: a
 *   failure said nothing, so its silence on an absent leaf is not a chosen
 *   abstention — `missed`, and no credit;
 * - declared-absent and a value — `hallucinated`;
 * - unmentioned, or an expectation the schema cannot hold — `unscorable`,
 *   with the reason.
 *
 * A cell's expectation comes from the corpus's own precedence rule
 * (`resolveExpectation`), never from a second implementation of it, and an
 * enum's members come from the schema's own inventory entry, never from a
 * hand-kept list.
 */
import type { LeafInventoryEntry } from "@azx/ribo-core";

import type { ResolvedExpectation } from "../corpus.js";
import { sameAnswer } from "./score-bridge.js";
import type { EvalCell } from "./score-types.js";
import type { EvalJsonValue } from "./types.js";

/**
 * A plain object — the shape a collection leaf's expectation is spelled in.
 * @param value - The value to test.
 * @returns Whether the value is a plain object.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A value as JSON: the corpus's own values, which the loader parsed from a
 * JSON file, carried through without inventing members.
 * @param value - The value to convert.
 * @returns The value as JSON.
 */
export const toJsonValue = (value: unknown): EvalJsonValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((member) => toJsonValue(member));
  if (typeof value === "object") {
    const out: Record<string, EvalJsonValue> = {};
    for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonValue(member);
    }
    return out;
  }
  return null;
};

/**
 * The values a collection expectation spells, in ordinal order.
 *
 * The corpus addresses a collection leaf once, at its element-relative path,
 * so a list-valued expectation is an object whose keys are the instance
 * ordinals. Ordinal keys are read in numeric order; keys that are not
 * ordinals keep the order the file wrote them in.
 * @param expectation - The expectation's value.
 * @returns The expected values, in order.
 */
const ordinalValues = (expectation: unknown): EvalJsonValue[] => {
  if (!isPlainObject(expectation)) return [toJsonValue(expectation)];
  const keys = Object.keys(expectation);
  const ordinals = keys.every((key) => /^\d+$/u.test(key));
  const ordered = ordinals ? [...keys].sort((left, right) => Number(left) - Number(right)) : keys;
  return ordered.map((key) => toJsonValue(expectation[key]));
};

/**
 * Does one produced element match the expected one, under the bridge?
 *
 * The leaf's alternatives apply to the element: an alternative that is a
 * plain object contributes its own ordinal's value, and an alternative that
 * is a plain value applies to the element itself.
 * @param produced - The produced element.
 * @param expected - The expected element.
 * @param alternatives - The leaf's alternatives.
 * @param index - The element's ordinal.
 * @returns Whether the element matches.
 */
const elementMatches = (
  produced: EvalJsonValue,
  expected: EvalJsonValue,
  alternatives: readonly unknown[],
  index: number,
): boolean => {
  if (sameAnswer(produced, expected)) return true;
  for (const alternative of alternatives) {
    if (isPlainObject(alternative)) {
      const values = ordinalValues(alternative);
      const candidate = values[index];
      if (candidate !== undefined && sameAnswer(produced, candidate)) return true;
      continue;
    }
    if (sameAnswer(produced, alternative)) return true;
  }
  return false;
};

/**
 * Does the produced list match the expectation's list?
 *
 * The lists must be the same length — a run that produced extra instances is
 * wrong, not correct — and every element must match under the bridge.
 * @param produced - The produced values, in order.
 * @param expectation - The expectation.
 * @returns Whether the list matches.
 */
const listMatches = (
  produced: readonly EvalJsonValue[],
  expectation: { readonly value: unknown; readonly alternatives: readonly unknown[] },
): boolean => {
  const expected = ordinalValues(expectation.value);
  if (produced.length !== expected.length) return false;
  return expected.every((element, index) =>
    elementMatches(produced[index]!, element, expectation.alternatives, index),
  );
};

/**
 * Can this expectation be compared to what the schema allows?
 *
 * An enum's or a literal's members come from the schema, so an expectation
 * naming no member the schema declares cannot be compared at all: the cell
 * is unscorable, with the reason, rather than a quiet wrong.
 * @param leaf - The leaf's inventory entry.
 * @param expectation - The expectation.
 * @returns Whether the expectation is comparable.
 */
const isComparable = (
  leaf: LeafInventoryEntry,
  expectation: { readonly value: unknown; readonly alternatives: readonly unknown[] },
): boolean => {
  if (leaf.kind !== "enum" && leaf.kind !== "literal") return true;
  const members = leaf.values ?? [];
  if (members.length === 0) return true;
  const candidates = [expectation.value, ...expectation.alternatives];
  return candidates.some((candidate) => members.some((member) => sameAnswer(candidate, member)));
};

/**
 * Judge one cell.
 * @param params - The leaf, the resolved expectation, what the run produced,
 * and whether the case failed.
 * @returns The cell.
 * @category Eval
 */
export function judgeLeaf(params: {
  readonly leaf: LeafInventoryEntry;
  readonly expectation: ResolvedExpectation;
  readonly produced: readonly EvalJsonValue[];
  /**
   * Whether the case's extraction failed. A failed case SAID nothing, so its
   * silence on a declared-absent leaf earns no credit: no value is `missed`,
   * not `correct`. An extracted case is unaffected.
   */
  readonly caseFailed?: boolean;
}): EvalCell {
  const { leaf, expectation } = params;
  const values = leaf.inArray ? params.produced : params.produced.slice(0, 1);
  const got: EvalJsonValue | null = leaf.inArray
    ? values.length === 0
      ? null
      : [...values]
    : (values[0] ?? null);
  const base = {
    expected: expectation.status === "asserted" ? toJsonValue(expectation.value) : null,
    got,
    origin: expectation.origin,
    ...(expectation.status === "unmentioned" || expectation.sourceSpan === undefined
      ? {}
      : { sourceSpan: expectation.sourceSpan }),
  };

  if (expectation.status === "unmentioned") {
    return { ...base, verdict: "unscorable", reason: "unmentioned" };
  }
  if (expectation.status === "declared-absent") {
    if (values.length > 0) return { ...base, verdict: "hallucinated" };
    // A failed case never chose silence: its absent leaves are missed, not
    // correct, so a run that produced nothing earns nothing.
    return { ...base, verdict: params.caseFailed === true ? "missed" : "correct" };
  }
  if (!isComparable(leaf, expectation)) {
    return { ...base, verdict: "unscorable", reason: "incomparable-expectation" };
  }
  if (values.length === 0) return { ...base, verdict: "missed" };
  const matched = leaf.inArray
    ? listMatches(values, expectation)
    : sameAnswer(values[0], expectation.value) ||
      expectation.alternatives.some((alternative) => sameAnswer(values[0], alternative));
  return { ...base, verdict: matched ? "correct" : "wrong" };
}
