import type { AnnotatedTranscript } from "../capture/annotated-transcript.js";
import type { ExtractOptions, Extractor, ExtractionResult } from "./extractor.js";
import type { BackoffOptions } from "../storage/backoff.js";
import { retryAsync } from "../async/retry-async.js";

/**
 * @file `retryExtractor` — wrap any {@link Extractor} with the attempt loop this repo
 * hand-rolled in six places, applying the same classification rules instead of a new set.
 *
 * A thin combinator over the core `Extractor` seam, following `fallbackExtractor` /
 * `raceExtractor`'s positional shape: an `F`-only generic takes its extractor first and an
 * options object second. The options-bag-only signature is reserved for the `V`/`P`-generic
 * combinators (`groupedExtractor`).
 *
 * **The loop itself now lives in `retryAsync`** (see that file): the policy was extracted
 * verbatim so the phased engine could retry items whose `run` is not an `Extractor`
 * without growing another copy. This wrapper only adapts the `Extractor` seam onto it —
 * the work is `extractor.extract(transcript, callerOptions)`, the signal is the caller's
 * own, and the options map member for member.
 *
 * What it deliberately does NOT do: touch `isTransientFailure`, the relay, or any existing
 * retry loop — `groupedExtractor` and `instance-fill.ts` keep their inline loops until their
 * own waves. And it does not decide whether a cancelled extraction *step* is retryable by
 * the relay; it only stops its own loop on a cancellation, which is the other layer's
 * question and a different answer.
 *
 * **Usage across attempts — this wrapper UNDERCOUNTS, and cannot do otherwise.** The
 * accepted attempt's result is returned by identity, retried or not. `ExtractionUsage`
 * only ever arrives on a RESOLVED result, so a rejected attempt reports nothing and
 * there is nothing to add: a `singleShotExtractor` that burns one call, fails, and
 * succeeds on the retry reports `calls: 1` where two were made, against
 * `ExtractionUsage.calls`' documented "including retries".
 *
 * An earlier version summed across attempts, which looked right and was dead code —
 * exactly one attempt ever returns a result, so the sum always equalled that attempt's
 * own count. It differs from `grouped-extractor.ts`, which genuinely sums across
 * ENTRIES that each resolve; that is a different axis. Closing the gap needs failed
 * attempts to carry usage, i.e. an error that transports it, which is a change to the
 * seam rather than something a wrapper can paper over.
 */

export interface RetryExtractorOptions extends BackoffOptions {
  /**
   * Retries after a transient failure, so the total attempts is `maxRetries + 1`.
   * Defaults to 2, matching `GroupedExtractorOptions`.
   */
  readonly maxRetries?: number;
  /**
   * Injectable sleep used between retry attempts, so tests do not wait real seconds.
   * Takes the **already-computed** `fullJitterDelay` result in milliseconds, exactly as
   * `GroupedExtractorOptions.delay` does — a caller that wants no backoff passes a
   * function that ignores its argument and resolves immediately, which is how the
   * on-device preset will disable backoff in Wave 6. Defaults to a `setTimeout`-backed
   * sleep, matching `grouped-extractor.ts`'s default.
   */
  readonly delay?: (ms: number) => Promise<void>;
}

/**
 * Retry a transiently-failing extractor, rethrowing everything else untouched.
 *
 * The attempt loop, abort policy and classification rules are {@link retryAsync}'s,
 * ported there verbatim; this wrapper forwards the caller's options bag **whole** —
 * not unwrapped, not rebuilt, so `callerOptions` reaches the inner extractor by
 * identity on every attempt — and consults the caller's own signal for the loop's
 * abort checks. A `SchemaParseError` is retried, because `isTransientFailure` already
 * returns `true` for it. See the usage-undercount note in the file header: the
 * accepted attempt's result is returned by identity, and its `usage.calls` is what
 * the result reports.
 */
export function retryExtractor<F>(
  extractor: Extractor<F>,
  options: RetryExtractorOptions = {},
): Extractor<F> {
  return {
    extract(
      transcript: AnnotatedTranscript,
      callerOptions?: ExtractOptions,
    ): Promise<ExtractionResult<F>> {
      return retryAsync(
        // The caller's options are forwarded whole — not unwrapped, not rebuilt.
        // A bag that dropped members here would strand them silently.
        () => extractor.extract(transcript, callerOptions),
        {
          maxRetries: options.maxRetries,
          delay: options.delay,
          baseMs: options.baseMs,
          capMs: options.capMs,
          random: options.random,
          signal: callerOptions?.signal,
        },
      );
    },
  };
}
