import type { AnnotatedTranscript } from "./annotated-transcript.js";

/**
 * @file Chunking for long transcripts: a caller-supplied policy that partitions the
 * canonical text, the shipped splitter over it, and the exact-partition check that
 * makes both honest.
 *
 * The partition check is the load-bearing part, not the splitter. An earlier draft of
 * `sp3-parity-and-scale-design.md` §4.3 verified chunks with a per-chunk
 * `text.includes(chunk)` — F6's finding — which verifies *membership* and says nothing
 * about **coverage**: a chunker that drops a paragraph, repeats a chunk, or skips a
 * region passes it on every chunk while silently losing whatever was in the gap.
 * `text.includes("")` is also true, so an empty chunk passes and would dispatch a model
 * call on empty text. {@link assertExactPartition} verifies positionally instead: the
 * chunks must be an **exact partition** of the text — contiguous, non-overlapping,
 * covering every character, in order.
 *
 * Exact partition is what makes `chunkedExtractor`'s stated-empty rule mean something
 * ("every chunk said none" is only a claim about the document if the chunks *are* the
 * document) and what keeps spans grounded for free. Overlapping chunks are deliberately
 * NOT allowed in this wave: they would duplicate instances across chunks, which only an
 * identity matcher can clean up, and that combination wants its own measurement before
 * it ships.
 */

/**
 * A caller-supplied chunking policy: partition a transcript's canonical text into the
 * pieces extraction runs over, in document order.
 *
 * The policy receives the whole transcript and returns the chunks. Chunks must satisfy
 * {@link assertExactPartition} against `transcript.text` — the combinator enforces that
 * on every run, because a chunker is caller-supplied code and a broken one must fail
 * loudly on the first run, not silently lose a paragraph on the thousandth.
 */
export type ChunkPolicy = (transcript: AnnotatedTranscript) => readonly string[];

/**
 * Assert that `chunks` are an **exact partition** of `text`: contiguous, non-overlapping,
 * in order, covering every character.
 *
 * The walk is positional — a cursor starts at 0, each chunk must equal
 * `text.slice(cursor, cursor + chunk.length)`, and at the end the cursor must equal
 * `text.length`. One pass rejects gaps, overlaps, reordering, duplication and chunks
 * that stop short, and every rejection names the offending chunk index: a chunker is
 * caller-supplied code, and a broken one must fail loudly on the first run.
 *
 * **An empty chunk has its own check, deliberately not folded into the walk.** On empty
 * text the positional walk accepts `[""]`: the zero-length slice matches, the cursor does
 * not move, and `cursor === text.length` holds at the end. The length check throws
 * regardless of the text — the walk only catches an empty chunk when there is text after
 * it.
 *
 * `assertExactPartition("", [])` passes: a cursor of 0 equals a length of 0. Empty text
 * legitimately yields zero chunks — see {@link splitOnBudget}.
 */
export const assertExactPartition = (text: string, chunks: readonly string[]): void => {
  let cursor = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.length === 0) {
      throw new Error(
        `assertExactPartition: chunk ${index} is empty. ` +
          "An empty chunk would dispatch a model call on empty text — and the positional " +
          "walk cannot catch it on empty overall text, so it has a check of its own.",
      );
    }
    if (text.startsWith(chunk, cursor)) {
      cursor += chunk.length;
      continue;
    }
    throw new Error(partitionError(text, chunks, index, cursor));
  }
  if (cursor !== text.length) {
    const lastIndex = chunks.length - 1;
    throw new Error(
      `assertExactPartition: chunk ${lastIndex} stops short — the chunks cover ` +
        `${cursor} of ${text.length} characters. ` +
        "An uncovered region was never extracted, and nothing downstream would know.",
    );
  }
};

/** Classify a positional mismatch for the error message: gap, overlap, or not a slice. */
const partitionError = (
  text: string,
  chunks: readonly string[],
  index: number,
  cursor: number,
): string => {
  const chunk = chunks[index]!;
  // A cut point before the cursor means already-covered text — an overlap, a repeat,
  // or a chunk carried past the end of the document.
  if (text.indexOf(chunk) >= 0 && text.indexOf(chunk) < cursor) {
    return (
      `assertExactPartition: chunk ${index} overlaps already-covered text ` +
      `(cursor ${cursor}, chunk starts at ${text.indexOf(chunk)}).`
    );
  }
  // A cut point after the cursor means a region between the cursor and the chunk was
  // skipped — a dropped paragraph, or chunks out of order.
  const after = text.indexOf(chunk, cursor + 1);
  if (after > cursor) {
    return (
      `assertExactPartition: chunk ${index} skips text — a gap between cursor ` +
      `${cursor} and ${after} was never covered.`
    );
  }
  return (
    `assertExactPartition: chunk ${index} is not a slice of the text at cursor ` +
    `${cursor} (expected ${JSON.stringify(text.slice(cursor, cursor + chunk.length))}, ` +
    `got ${JSON.stringify(chunk)}).`
  );
};

/**
 * The shipped {@link ChunkPolicy}: split the canonical text at a character budget,
 * preferring paragraph boundaries, then sentence boundaries, then — only when a single
 * sentence exceeds the budget — a word boundary. Never mid-word.
 *
 * **`maxChars` is a target, not a guarantee, and the one exception is pinned.** A single
 * token longer than the budget — a long identifier, a run-on with no spaces — has no
 * word boundary to split at, and the rule forbids splitting mid-word, so it comes back
 * as one over-budget chunk. That is better than throwing, which would make a legitimate
 * document entirely unextractable over one long word; the transport will give a clearer
 * error than core can. Every other case partitions within budget.
 *
 * Separators stay with the preceding chunk, so the pieces concatenate back to exactly
 * the text — {@link assertExactPartition} accepts the output, always.
 *
 * `maxChars` is required: core does not know the model's context window, and a default
 * would be a guess. Empty text yields zero chunks, not one empty chunk.
 */
export const splitOnBudget = (maxChars: number): ChunkPolicy => {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error(
      `splitOnBudget: maxChars (${maxChars}) must be a positive integer — a budget below ` +
        "one has no legal chunk, since chunks are non-empty and the budget is a maximum.",
    );
  }
  return (transcript) => {
    const text = transcript.text;
    if (text === "") return [];
    const paragraphCuts = collectCuts(text, PARAGRAPH_SEPARATOR);
    const sentenceCuts = collectCuts(text, SENTENCE_SEPARATOR);
    const wordCuts = collectCuts(text, WORD_SEPARATOR);
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      const limit = start + maxChars;
      if (text.length <= limit) {
        chunks.push(text.slice(start));
        break;
      }
      // Highest-precedence boundary within the budget wins; sentence and paragraph
      // separators are whitespace runs too, so a word cut below them always exists
      // when they do — the fallback only fires on a run with no boundary at all.
      const cut =
        lastCutWithin(paragraphCuts, start, limit) ??
        lastCutWithin(sentenceCuts, start, limit) ??
        lastCutWithin(wordCuts, start, limit) ??
        // A single token longer than the budget: cut where the token ends — the next
        // boundary beyond the limit, or the end of the text — producing the one
        // documented over-budget chunk rather than a mid-word split.
        firstCutAfter(wordCuts, limit) ??
        text.length;
      chunks.push(text.slice(start, cut));
      start = cut;
    }
    return chunks;
  };
};

/** Paragraph boundary: a blank line. CRLF counts. */
const PARAGRAPH_SEPARATOR = /\r?\n\r?\n+/g;

/** Sentence boundary: terminal punctuation followed by whitespace. */
const SENTENCE_SEPARATOR = /[.!?]+\s+/g;

/** Word boundary: a whitespace run. Covers tabs and lone newlines. */
const WORD_SEPARATOR = /\s+/g;

/**
 * Cut positions where a separator run ENDS — the separator stays with the preceding
 * chunk, so cutting here makes the pieces concatenate back to exactly the text.
 */
const collectCuts = (text: string, separator: RegExp): number[] => {
  const cuts: number[] = [];
  for (const match of text.matchAll(separator)) {
    cuts.push(match.index + match[0].length);
  }
  return cuts;
};

/** The last cut in `(start, limit]`, or `undefined` — the longest legal chunk. */
const lastCutWithin = (cuts: number[], start: number, limit: number): number | undefined => {
  let found: number | undefined;
  for (const cut of cuts) {
    if (cut > limit) break;
    if (cut > start) found = cut;
  }
  return found;
};

/** The first cut past `limit`, or `undefined` — where an over-budget token ends. */
const firstCutAfter = (cuts: number[], limit: number): number | undefined => {
  for (const cut of cuts) {
    if (cut > limit) return cut;
  }
  return undefined;
};
