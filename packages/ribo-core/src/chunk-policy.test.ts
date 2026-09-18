import { describe, expect, test } from "vitest";

import { assertExactPartition, splitOnBudget } from "./chunk-policy.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";

/**
 * Tests for `chunk-policy.ts` — the exact-partition contract and the shipped splitter.
 *
 * The partition check is the load-bearing half, and the pins below are organised around
 * what a per-chunk `text.includes(chunk)` membership test would MISS: a gap (a dropped
 * paragraph), an overlap, a duplicate chunk, and an empty chunk (which `includes` accepts
 * unconditionally, since every string contains `""`). Each rejection names the offending
 * index, because a caller-supplied chunker that is wrong must fail loudly on the first
 * run rather than silently lose a paragraph on the thousandth.
 */

const transcriptOf = (text: string): AnnotatedTranscript => ({ text, annotations: {} });

/** Catch the partition check's rejection, or fail the test if it did not throw. */
const rejectionOf = (text: string, chunks: readonly string[]): unknown => {
  try {
    assertExactPartition(text, chunks);
  } catch (caught) {
    return caught;
  }
  throw new Error("expected assertExactPartition to throw");
};

describe("assertExactPartition", () => {
  test("accepts a real partition — contiguous, ordered, covering", () => {
    expect(() => assertExactPartition("abcdef", ["abc", "def"])).not.toThrow();
    expect(() => assertExactPartition("abcdef", ["abcdef"])).not.toThrow();
    expect(() => assertExactPartition("", [])).not.toThrow();
  });

  test("rejects a gap — a dropped region between chunks", () => {
    const error = rejectionOf("abcdef", ["abc", "ef"]);
    expect((error as Error).message).toContain("1");
  });

  test("rejects an overlap — a chunk that re-reads covered text", () => {
    const error = rejectionOf("abcdef", ["abc", "cde"]);
    expect((error as Error).message).toContain("1");
  });

  test("rejects a duplicate chunk", () => {
    const error = rejectionOf("abcdef", ["abc", "abc"]);
    expect((error as Error).message).toContain("1");
  });

  test("rejects an empty chunk — including on empty text, where the cursor walk cannot", () => {
    const withText = rejectionOf("abc", ["a", "", "bc"]);
    expect((withText as Error).message).toContain("1");
    // `text.includes("")` is true, and on empty text the positional slice also matches
    // (a zero-length slice at cursor 0), so only the dedicated check catches this.
    const onEmpty = rejectionOf("", [""]);
    expect((onEmpty as Error).message).toContain("0");
  });

  test("rejects chunks that stop short of text.length", () => {
    const error = rejectionOf("abcdef", ["abc"]);
    expect((error as Error).message).toContain("0");
  });

  test("rejects reordered chunks", () => {
    const error = rejectionOf("abcdef", ["def", "abc"]);
    expect((error as Error).message).toContain("0");
  });

  test("rejects a chunk that appears nowhere in the text", () => {
    const error = rejectionOf("abcdef", ["abc", "xyz"]);
    expect((error as Error).message).toContain("1");
  });
});

describe("splitOnBudget", () => {
  test("empty text yields zero chunks", () => {
    expect(splitOnBudget(10)(transcriptOf(""))).toEqual([]);
  });

  test("text shorter than the budget comes back as one chunk", () => {
    const text = "A short paragraph.";
    const chunks = splitOnBudget(100)(transcriptOf(text));
    expect(chunks).toEqual([text]);
  });

  test("output satisfies assertExactPartition on a multi-paragraph fixture", () => {
    const text = [
      "The attic insulation is R-38 across the whole deck.",
      "",
      "The furnace is a gas unit, about ten years old.",
      "",
      "Two return ducts run through the crawlspace.",
    ].join("\n");
    const chunks = splitOnBudget(60)(transcriptOf(text));
    expect(chunks.length).toBeGreaterThan(1);
    expect(() => assertExactPartition(text, chunks)).not.toThrow();
  });

  test("output satisfies assertExactPartition on text with no paragraph breaks", () => {
    const text =
      "The heating system is a gas furnace. The water heater is electric. " +
      "The attic hatch is uninsulated. There are two returns in the crawlspace.";
    const chunks = splitOnBudget(50)(transcriptOf(text));
    expect(chunks.length).toBeGreaterThan(1);
    expect(() => assertExactPartition(text, chunks)).not.toThrow();
  });

  test("a single sentence longer than the budget still partitions exactly", () => {
    const text =
      "The north elevation has twelve windows of which eight are original sash " +
      "requiring full reglazing and weatherstripping before winter arrives.";
    const chunks = splitOnBudget(40)(transcriptOf(text));
    expect(chunks.length).toBeGreaterThan(1);
    expect(() => assertExactPartition(text, chunks)).not.toThrow();
  });

  test("never splits mid-word — every non-final chunk ends on a separator it kept", () => {
    const text =
      "Alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima " +
      "mike november oscar papa quebec romeo sierra tango uniform victor whiskey " +
      "xray yankee zulu.";
    const chunks = splitOnBudget(30)(transcriptOf(text));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      // Separators stay with the preceding chunk, so a chunk that ends mid-word is a
      // split the splitter was forbidden to make.
      expect(chunk).toMatch(/\s$/);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("a single token longer than the budget comes back as one over-budget chunk", () => {
    // A run-on with no boundary has no word to split at, and splitting mid-word is
    // forbidden — so returning it oversized beats throwing, which would make a
    // legitimate document entirely unextractable over one long word. The chunk is the
    // whole token (its trailing separator rides along, as separators do), unsplit.
    const token = "a".repeat(100);
    const text = `short ${token} tail`;
    const chunks = splitOnBudget(20)(transcriptOf(text));
    expect(() => assertExactPartition(text, chunks)).not.toThrow();
    const carrier = chunks.find((chunk) => chunk.includes(token));
    expect(carrier).toBeDefined();
    expect(carrier!.length).toBeGreaterThan(20);
  });
});
