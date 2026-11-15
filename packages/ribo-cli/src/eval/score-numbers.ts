/**
 * @file The numeric fold's parser: a number written in digits or in English
 * words.
 *
 * The bridge compares two numbers when both parse to the same finite number,
 * so the parser is the whole of the numeric fold. It is deliberately narrow:
 * digits with an optional sign and decimal point, and the English number
 * words a transcript carries — units, tens, hundreds, thousands and millions,
 * with hyphens as separators and "and" skipped.
 *
 * Nothing else parses. A range ("10-12"), a measurement ("10 kW") and a
 * version ("1.2.3") are strings, and a string that does not parse is never
 * numerically equal to one that does.
 */

/** The number words that stand alone, under the tens. */
const UNITS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

/** The tens words. */
const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** The scales, and how each one multiplies the current group. */
const SCALES: Readonly<Record<string, number>> = {
  hundred: 100,
  thousand: 1_000,
  million: 1_000_000,
};

/** The digits a fraction may spell out. */
const FRACTION_DIGITS: Readonly<Record<string, string>> = {
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};

/** A number written in digits, with an optional sign and decimal point. */
const DIGITS = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/** The words a number is written in, once the hyphens are separators. */
const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/-/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length > 0);

/**
 * The integer part of a number written in words.
 *
 * The words compose the way they are spoken: "three hundred" is three
 * hundreds, "one thousand two hundred" is a thousand and two hundreds.
 * @param tokens - The words, in order.
 * @returns The number, or undefined when the words are not a number.
 */
const parseIntegerWords = (tokens: readonly string[]): number | undefined => {
  let total = 0;
  let current = 0;
  let sawNumber = false;
  for (const token of tokens) {
    if (token === "and") continue;
    const unit = UNITS[token];
    if (unit !== undefined) {
      current += unit;
      sawNumber = true;
      continue;
    }
    const ten = TENS[token];
    if (ten !== undefined) {
      current += ten;
      sawNumber = true;
      continue;
    }
    const scale = SCALES[token];
    if (scale === undefined) return undefined;
    if (!sawNumber) return undefined;
    if (scale === 100) {
      current *= 100;
      continue;
    }
    total += (current === 0 ? 1 : current) * scale;
    current = 0;
  }
  if (!sawNumber) return undefined;
  return total + current;
};

/**
 * The fraction of a number written in words: "point five" is five tenths.
 * @param tokens - The words after "point".
 * @returns The fraction's digits, or undefined when they are not digits.
 */
const parseFractionWords = (tokens: readonly string[]): string | undefined => {
  let digits = "";
  for (const token of tokens) {
    const digit = FRACTION_DIGITS[token];
    if (digit === undefined) return undefined;
    digits += digit;
  }
  return digits.length > 0 ? digits : undefined;
};

/**
 * Parse a value as a number: digits, or the English number words.
 *
 * A value that does not parse is not a number, and never equals one that
 * does.
 * @param text - The text to parse.
 * @returns The number, or undefined when the text is not one.
 * @category Eval
 */
export function parseNumberish(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (DIGITS.test(trimmed)) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const tokens = words(trimmed);
  const pointIndex = tokens.indexOf("point");
  if (pointIndex === -1) return parseIntegerWords(tokens);
  const integer = parseIntegerWords(tokens.slice(0, pointIndex));
  const fraction = parseFractionWords(tokens.slice(pointIndex + 1));
  if (integer === undefined || fraction === undefined) return undefined;
  return Number(`${integer}.${fraction}`);
}
