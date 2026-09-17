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
 * **Usage across attempts.** `ExtractionUsage.calls` is documented as "Model calls made,
 * including retries", and the loop this generalizes (`grouped-extractor.ts`) sums
 * `usage.calls` across attempts. On a **retried** success this returns a new result whose
 * `usage.calls` is the sum over every attempt that reported one, preserving all other
 * usage members from the accepted attempt. On a **first-attempt** success it returns the
 * inner result object unchanged, by identity — there is nothing to sum, and rebuilding
 * would break the passthrough guarantee downstream consumers rely on. A failed attempt
 * that rejects reports no usage and contributes nothing; only attempts that returned a
 * result can.
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
      let reportedCalls = 0;
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
          const result = await extractor.extract(transcript, callerOptions);

          if (attempt === 0) return result;

          // Retried success: sum usage.calls across every attempt that reported one.
          // A failed attempt that rejects reports no usage and contributes nothing.
          reportedCalls += result.usage.calls;
          return { ...result, usage: { ...result.usage, calls: reportedCalls } };
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
