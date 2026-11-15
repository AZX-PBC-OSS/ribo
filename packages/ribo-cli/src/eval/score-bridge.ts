/**
 * @file The normalisation bridge: the fixed, declared set of folds that makes
 * two values the same answer.
 *
 * Two values are the same answer when they are the same after these folds —
 * and nothing else. No stemming, no synonym expansion, no unit stripping: a
 * fold the corpus cannot predict is a fold that hides a real difference.
 *
 * The folds are:
 *
 * - the string fold — case, surrounding and repeated whitespace, and trailing
 *   sentence punctuation. Interior punctuation is NOT folded, so "BW-4471" and
 *   "BW4471" are different strings, which is why a corpus that hears one and
 *   writes the other lists the second as an alternative;
 * - the numeric fold — two values that both parse to the same finite number;
 * - the boolean fold — booleans by strict equality, and the string that
 *   spells one.
 *
 * The enum rule is not a fold: an enum's members come from the schema, and
 * the scorer reads them from the one field inventory.
 */
import { parseNumberish } from "./score-numbers.js";

/** The trailing punctuation the string fold strips. */
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);

/**
 * Fold a string: lowercase, trimmed, interior whitespace collapsed, trailing
 * sentence punctuation stripped.
 *
 * The trailing punctuation is stripped as a run, so "steel." and "steel!!"
 * are the same string.
 * @param text - The string to fold.
 * @returns The folded string.
 * @category Eval
 */
export function foldString(text: string): string {
  const collapsed = text.toLowerCase().replace(/\s+/gu, " ").trim();
  let end = collapsed.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(collapsed[end - 1]!)) end -= 1;
  return collapsed.slice(0, end);
}

/**
 * A value as a number, when it is one: a finite number, or text that parses
 * as one.
 * @param value - The value to read.
 * @returns The number, or undefined when the value is not one.
 * @category Eval
 */
export function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  return parseNumberish(value);
}

/**
 * Are two values the same answer?
 *
 * The comparison is by fold, never by a value's own type: a number and the
 * string that spells it are the same answer, and so are a boolean and the
 * string that spells it.
 * @param left - The first value.
 * @param right - The second value.
 * @returns Whether the two are the same answer.
 * @category Eval
 */
export function sameAnswer(left: unknown, right: unknown): boolean {
  if (typeof left === "boolean" || typeof right === "boolean") {
    if (typeof left === "boolean" && typeof right === "boolean") return left === right;
    const spelled = typeof left === "string" ? left : typeof right === "string" ? right : undefined;
    const other = typeof left === "boolean" ? left : right;
    if (spelled === undefined || typeof other !== "boolean") return false;
    const folded = foldString(spelled);
    if (folded !== "true" && folded !== "false") return false;
    return (folded === "true") === other;
  }
  const leftNumber = numericValue(left);
  const rightNumber = numericValue(right);
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber === rightNumber;
  if (typeof left === "string" && typeof right === "string")
    return foldString(left) === foldString(right);
  if (left === null || left === undefined) return right === null || right === undefined;
  if (typeof left === "object" && typeof right === "object" && right !== null) {
    return sameObject(left, right);
  }
  return false;
}

/**
 * Are two plain objects the same answer? Their members are compared by fold.
 * @param left - The first object.
 * @param right - The second object.
 * @returns Whether the two objects hold the same members.
 */
const sameObject = (left: object, right: object): boolean => {
  if (Array.isArray(left) && Array.isArray(right)) return sameArray(left, right);
  if (Array.isArray(left) || Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      sameAnswer(leftRecord[key], rightRecord[key]),
  );
};

/**
 * Are two arrays the same answer? Their members are compared by fold, in
 * order.
 * @param left - The first array.
 * @param right - The second array.
 * @returns Whether the two arrays hold the same members.
 */
const sameArray = (left: readonly unknown[], right: readonly unknown[]): boolean => {
  if (left.length !== right.length) return false;
  return left.every((member, index) => sameAnswer(member, right[index]));
};
