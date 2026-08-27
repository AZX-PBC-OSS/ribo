/**
 * Threshold for the trailing whitespace loop detector.
 *
 * Measured successful on-device extraction responses were 462–917 characters of
 * ordinary pretty-printed JSON with two-space indentation. Real formatted JSON
 * never contains 80 consecutive whitespace characters, so this threshold cannot
 * fire on a good answer. False positives matter enormously here: a wrongly
 * detected loop would silently truncate a correct extraction.
 */
export const WHITESPACE_LOOP_THRESHOLD = 80;

/**
 * Returns true when the accumulated streaming output has degenerated into a
 * trailing run of pure whitespace at least {@link WHITESPACE_LOOP_THRESHOLD}
 * characters long. This is the kill signal for the constrained-decoding loop
 * where Chrome's on-device model emits valid JSON and then falls into an
 * unbounded whitespace run until it hits the output cap.
 */
export function isLoopingOutput(output: string): boolean {
  if (output.length < WHITESPACE_LOOP_THRESHOLD) {
    return false;
  }
  // `tail` is exactly WHITESPACE_LOOP_THRESHOLD characters long, because the
  // length guard above already rejected anything shorter. So testing "all
  // whitespace" is equivalent to testing "that many whitespace characters", and
  // it stays correct if the threshold ever changes — a hardcoded `\s{80}` would
  // silently stop matching the constant it is supposed to enforce.
  const tail = output.slice(-WHITESPACE_LOOP_THRESHOLD);
  return /^\s+$/.test(tail);
}
