import { CancellationError, isCancellation } from "./cancellation.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import type { ExtractOptions, Extractor, ExtractionResult } from "./extractor.js";
import type { BackoffOptions } from "./queue/backoff.js";
import { fullJitterDelay, isTransientFailure, TerminalQueueError } from "./queue/backoff.js";

/**
 * @file `retryExtractor` — wrap any {@link Extractor} with the attempt loop this repo
 * hand-rolls in six places, applying the same classification rules instead of a new set.
 *
 * A thin combinator over the core `Extractor` seam, following `fallbackExtractor` /
 * `raceExtractor`'s positional shape: an `F`-only generic takes its extractor first and an
 * options object second. The options-bag-only signature is reserved for the `V`/`P`-generic
 * combinators (`groupedExtractor`).
 *
 * What it deliberately does NOT do: touch `isTransientFailure`, the relay, or any existing
 * retry loop — `groupedExtractor` and `instance-fill.ts` keep their inline loops until their
 * own waves. And it does not decide whether a cancelled extraction *step* is retryable by
 * the relay; it only stops its own loop on a cancellation, which is the other layer's
 * question and a different answer.
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
 * The default {@link RetryExtractorOptions.delay} — a real `setTimeout` sleep. Tests
 * inject a fake that records the value and resolves immediately.
 */
const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_MAX_RETRIES = 2;

/**
 * Retry a transiently-failing extractor, rethrowing everything else untouched.
 *
 * The rules, in the order they are checked. **Before each attempt:** if the caller's
 * signal has already aborted, throw without starting the attempt and without counting it
 * — an attempt that never ran must not appear in the attempt count. On attempt zero there
 * is no previous error to rethrow, which is why a fresh `CancellationError` is thrown
 * there rather than a captured one. **After a failure:** a `TerminalQueueError` is
 * rethrown untouched; a cancellation (per `isCancellation`, consulted with the caller's
 * signal) is rethrown untouched; a failure for which `isTransientFailure` returns `false`
 * is rethrown untouched; anything else is retried until `maxRetries` is exhausted, after
 * which the last error is rethrown. A `SchemaParseError` is retried, because
 * `isTransientFailure` already returns `true` for it.
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
export function retryExtractor<F>(
  extractor: Extractor<F>,
  options: RetryExtractorOptions = {},
): Extractor<F> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delay = options.delay ?? defaultDelay;
  // Pre-compute the backoff options object once — passed to fullJitterDelay on every
  // retry. The random function defaults to Math.random inside fullJitterDelay when not
  // supplied here.
  const backoff: BackoffOptions = {
    baseMs: options.baseMs,
    capMs: options.capMs,
    random: options.random,
  };

  return {
    async extract(
      transcript: AnnotatedTranscript,
      callerOptions?: ExtractOptions,
    ): Promise<ExtractionResult<F>> {
      const callerSignal = callerOptions?.signal;
      let lastError: unknown;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // An attempt that never ran must not appear in the attempt count — checked at
        // the TOP of the loop, before the attempt starts. On attempt zero there is no
        // previous error to rethrow, so a fresh CancellationError carries the news.
        if (callerSignal?.aborted) {
          if (lastError instanceof Error) throw lastError;
          throw new CancellationError(
            "retryExtractor: the caller's signal had already aborted — no attempt was started",
          );
        }

        try {
          // The caller's options are forwarded whole — not unwrapped, not rebuilt.
          // A bag that dropped members here would strand them silently.
          //
          // The accepted attempt's result is returned by identity, retried or not.
          //
          // This UNDERCOUNTS `usage.calls` after a retry, and the undercount cannot be
          // fixed here. `ExtractionUsage` only ever arrives on a RESOLVED result, so a
          // rejected attempt reports nothing — there is no usage to add. An earlier
          // version of this file summed across attempts, which looked right and was
          // dead code: exactly one attempt ever returns a result, so the sum always
          // equalled that one attempt's own count.
          //
          // It differs from `groupedExtractor`, which genuinely sums (`grouped-extractor.ts`),
          // because that sums across ENTRIES that each resolve — a different axis.
          //
          // So a `singleShotExtractor` that burns one call, fails, and succeeds on the
          // retry reports `calls: 1` where two were made, against `ExtractionUsage.calls`'
          // documented "including retries". Closing it needs failed attempts to carry
          // usage, i.e. an error that transports it — a real change to the seam, not
          // something a wrapper can paper over. Recorded rather than silently wrong.
          return await extractor.extract(transcript, callerOptions);
        } catch (cause) {
          lastError = cause;
          // A deterministic failure — re-sending an identical request reproduces it.
          // Retrying would burn the budget for nothing.
          if (cause instanceof TerminalQueueError) throw cause;
          // A cancellation is not a transient blip — stop immediately, untouched.
          if (isCancellation(cause, callerSignal)) throw cause;
          // The unrecognised-error default is retryable (see isTransientFailure);
          // only what it calls terminal is not retried here either.
          if (!isTransientFailure(cause)) throw cause;
          // Transient — back off before the next attempt if budget remains.
          // fullJitterDelay takes the failure count before this failure (matching the
          // relay's convention), so the first retry draws from [0, base]. After the
          // delay, the loop's top-of-iteration abort check catches a caller abort that
          // fired while we were sleeping.
          if (attempt < maxRetries) {
            await delay(fullJitterDelay(attempt, backoff));
          }
        }
      }

      // Budget exhausted — rethrow the last error.
      throw lastError;
    },
  };
}
