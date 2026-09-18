import { assertLeafGranularity } from "./assert-leaf-granularity.js";
import { assertExactPartition, type ChunkPolicy } from "./chunk-policy.js";
import { mergeChunkResults } from "./merge-chunk-results.js";
import type { MergePolicy } from "./merge-policy.js";
import type { InstanceMatcher } from "./instance-identity.js";
import type { Enveloped, NoProvenance } from "./enveloped.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import type {
  ExtractOptions,
  Extractor,
  ExtractionResult,
  ExtractionTarget,
  ExtractionUsage,
} from "./extractor.js";

/**
 * @file `chunkedExtractor` — make a transcript longer than a context window
 * extractable: split it, extract from each piece, and put the pieces back together
 * without inventing anything (`sp3-parity-and-scale-design.md` §4.3 as corrected by
 * §10's F2, F6, F7, F9 and F14).
 *
 * The decisions most worth restating here, because the obvious-looking "fix" breaks
 * each of them:
 *
 * - **Chunks run sequentially, and there is no concurrency option.** They are not
 *   redundant samples racing to be first; they are N× the calls of one pass, and
 *   firing forty at a rate-limited transport at once is how a caller discovers their
 *   quota. A bounded pool would also need a sibling-abort policy on failure —
 *   `consensusExtractor` deliberately does not abort siblings, `groupedExtractor`
 *   deliberately does — and shipping an option with no test and no stated abort
 *   semantics is worse than not shipping it. Sequential until someone measures that
 *   it matters.
 * - **A chunk failure propagates the inner error UNCHANGED.** ADR 0002 classifies by
 *   *who failed*, and the inner error already encodes that: a transport failure is
 *   transient, a model producing unparseable output is terminal. Wrapping it in a
 *   ChunkFailedError would erase the classification every `isTransientFailure` and
 *   `TerminalError` check downstream depends on, and would turn a terminal failure
 *   into a relay retry loop. The cost is that the error does not say which chunk
 *   failed; that is worth less than the classification.
 * - **A failure fails the whole run** — the opposite of `consensusExtractor`.
 *   Consensus's candidates are redundant, so two survivors are still evidence. Chunks
 *   are **disjoint**: a failed chunk means a region of the document was never read,
 *   and returning a result that silently omits whatever was in it is the worst
 *   outcome available. A caller wanting resilience composes `retryExtractor` around
 *   the inner extractor, per chunk, which is what that combinator is for.
 * - **The caller's whole options bag is forwarded to every chunk, deadline
 *   unnarrowed.** The deadline is absolute epoch milliseconds precisely so it
 *   survives composition — every layer passes the same instant down, and a chunk
 *   that starts after it has passed is the inner extractor's to reject.
 *   `consensusExtractor` forwards it the same way.
 * - **Each chunk carries the original `annotations` bag unchanged.** Annotations
 *   describe the capture, not the region; a chunk is not a different capture.
 * - **Empty transcript → the inner extractor runs once, on the empty text.** Zero
 *   chunks would mean zero calls and a merge with nothing to merge, and inventing an
 *   all-null result would be this combinator asserting an extraction it never
 *   performed. Delegating once preserves whatever the inner extractor already does
 *   with empty input, which is its decision to make and not this wrapper's.
 *
 * **Usage** sums `calls` across chunks; each token member sums only when every chunk
 * reported it and is omitted entirely otherwise (ADR 0005's absent-is-not-zero);
 * `engine` and `strategy` are omitted, since they identify one producer. **`raw` is
 * dropped**, for `consensusExtractor`'s reason: it describes one producer's run, and
 * here there are N of them.
 *
 * **Known limit, recorded rather than fixed:** there is no per-chunk resumption. One
 * transient failure at chunk 40 discards 39 paid successes and the relay re-runs all
 * 40 (§10's F14). Real, and not solved here.
 */

/** What a caller supplies to {@link chunkedExtractor}. */
export interface ChunkedExtractorOptions<V extends Record<string, unknown>, P = NoProvenance> {
  /**
   * The field knowledge the inner extractor was built against. Read ONCE, at
   * construction: {@link assertLeafGranularity} refuses a `"row"` or `"none"` group
   * before any call is made, because the merge walks per-leaf envelopes and would
   * otherwise merge nothing while returning a result that looks merged (ADR 0003).
   */
  readonly target: ExtractionTarget<V, P>;
  /**
   * The caller-supplied chunking policy — e.g. `splitOnBudget(maxChars)`. Its output
   * is verified to be an exact partition of the canonical text on EVERY run, before
   * any model call: a chunker is caller-supplied code, and a broken one must fail
   * loudly on the first run, not silently lose a paragraph on the thousandth.
   */
  readonly chunk: ChunkPolicy;
  /**
   * Which chunk's envelope wins for a scalar leaf. Defaults to `firstCommitted` —
   * earlier text is usually the primary description, a later mention a passing
   * reference.
   */
  readonly merge?: MergePolicy;
  /**
   * Optional cross-chunk instance alignment. Absent, collections concatenate and a
   * fact describing the same real-world thing in two chunks appears twice, for
   * review to see and remove. Supplied, an incoming instance merges into the first
   * earlier-chunk instance the matcher calls `"same"`, keeping that anchor's
   * position. No shipped matcher merges anything — sameness across disjoint regions
   * is host judgement, always.
   */
  readonly alignInstances?: InstanceMatcher;
}

/**
 * Run the inner extractor over an exact partition of a long transcript and merge the
 * pieces back together.
 *
 * On each `extract`: run the chunk policy, verify the result is an exact partition of
 * the canonical text (throwing before any model call when it is not), then run the
 * inner extractor over each chunk **sequentially**. A chunk that rejects fails the run
 * with the inner error, unchanged — not wrapped, not classified, by identity.
 */
export function chunkedExtractor<V extends Record<string, unknown>, P = NoProvenance>(
  inner: Extractor<Enveloped<V, P>>,
  options: ChunkedExtractorOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  // Construction-time, before any call: a "row" or "none" group would make the merge
  // walk merge nothing while the result looked merged — silently blind exactly where
  // hallucination is worst.
  assertLeafGranularity(options.target.extractionSchema, { combinator: "chunkedExtractor" });

  return {
    extract: async (
      transcript: AnnotatedTranscript,
      callerOptions?: ExtractOptions,
    ): Promise<ExtractionResult<Enveloped<V, P>>> => {
      // Empty text delegates once: the chunk policy is not consulted, because zero
      // chunks and a merge over nothing would invent a result. Whatever the inner
      // extractor does with empty input is its decision.
      if (transcript.text === "") {
        return inner.extract(transcript, callerOptions);
      }

      const chunks = options.chunk(transcript);
      // Before ANY model call: a gap, an overlap or a duplicate chunk means whatever
      // the chunks miss was never extracted, and nothing downstream would know.
      assertExactPartition(transcript.text, chunks);

      const perChunk: ExtractionResult<Enveloped<V, P>>[] = [];
      for (const text of chunks) {
        // Sequential, deliberately — see the file header. The caller's whole options
        // bag is forwarded verbatim, deadline unnarrowed; the annotations bag is the
        // ORIGINAL object, unchanged, because a chunk is not a different capture.
        perChunk.push(
          await inner.extract({ text, annotations: transcript.annotations }, callerOptions),
        );
      }

      const fields = mergeChunkResults(
        perChunk.map((result) => result.fields),
        {
          merge: options.merge,
          alignInstances: options.alignInstances,
        },
      );
      const statedEmptyGroups = mergeStatedEmptyGroups(perChunk, fields);
      return statedEmptyGroups === undefined
        ? { fields, usage: mergeUsage(perChunk) }
        : { fields, usage: mergeUsage(perChunk), statedEmptyGroups };
    },
  };
}

/** The usage members a chunk run sums-or-omits; `calls` is handled separately. */
interface TokenTotals {
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  cacheCreationPromptTokens?: number;
}

const TOKEN_MEMBERS: readonly (keyof TokenTotals)[] = [
  "promptTokens",
  "completionTokens",
  "cachedPromptTokens",
  "cacheCreationPromptTokens",
];

/**
 * The chunks' combined usage. `calls` sums across every chunk; each token member sums
 * only when every chunk reported it and is omitted entirely otherwise — absent means
 * "not reported", never zero (ADR 0005). `engine` and `strategy` are omitted: they
 * identify one producer, and a chunked run has N. The same rules
 * `consensusExtractor` applies to its survivors.
 */
const mergeUsage = (perChunk: readonly ExtractionResult<unknown>[]): ExtractionUsage => {
  const usages = perChunk.map((result) => result.usage);
  const tokens: TokenTotals = {};
  for (const member of TOKEN_MEMBERS) {
    let total = 0;
    let allReported = true;
    for (const reported of usages) {
      const value = reported[member];
      if (value === undefined) {
        allReported = false;
        break;
      }
      total += value;
    }
    if (allReported) tokens[member] = total;
  }
  return { calls: usages.reduce((sum, usage) => sum + usage.calls, 0), ...tokens };
};

/**
 * The stated-empty claims, merged — two rules, in order:
 *
 * 1. If **any** chunk produced an instance for the group, the claim is false and is
 *    dropped entirely — "there are none of these" meant none *in that region*.
 * 2. Otherwise, if **any** chunk stated it empty, keep the EARLIEST such chunk's span.
 *    Not unanimity: a single-shot extractor emits no `statedEmptyGroups` at all, so
 *    one chunk roster-ing "no rooms" while another simply finds none would lose a true
 *    claim. What makes the kept claim honest is the exact partition — no chunk found
 *    one, and the chunks *are* the document.
 *
 * Returns `undefined` when nothing survives, so the field is absent rather than empty.
 */
const mergeStatedEmptyGroups = <V extends Record<string, unknown>, P = NoProvenance>(
  perChunk: readonly ExtractionResult<Enveloped<V, P>>[],
  mergedFields: Enveloped<V, P>,
): Readonly<Record<string, string>> | undefined => {
  const earliest: Record<string, string> = {};
  for (const result of perChunk) {
    for (const [group, span] of Object.entries(result.statedEmptyGroups ?? {})) {
      if (!(group in earliest)) earliest[group] = span;
    }
  }
  const merged = mergedFields as Record<string, unknown>;
  const kept: Record<string, string> = {};
  for (const [group, span] of Object.entries(earliest)) {
    const produced = merged[group];
    if (Array.isArray(produced) && produced.length > 0) continue;
    kept[group] = span;
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
};
