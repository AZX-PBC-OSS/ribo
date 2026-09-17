import { CancellationError, isCancellation } from "./cancellation.js";
import type { BackoffOptions } from "./queue/backoff.js";
import { fullJitterDelay, isTransientFailure, TerminalQueueError } from "./queue/backoff.js";

/**
 * @file `retryAsync` — the attempt loop this repo hand-rolls, extracted from
 * `retryExtractor` so the phased engine composes it rather than growing yet another
 * copy. It retries any async work — including items whose `run` is not an `Extractor`
 * — with the same classification rules every loop in the tree applies: rethrow a
 * `TerminalQueueError` untouched, rethrow a cancellation untouched, rethrow anything
 * `isTransientFailure` rejects, otherwise retry until `maxRetries` is exhausted.
 *
 * What it deliberately does NOT do: touch `isTransientFailure`, the relay, or any
 * existing retry loop — `groupedExtractor` and `instance-fill.ts` keep their inline
 * loops until their own waves. And it does not decide whether a cancelled
 * extraction *step* is retryable by the relay; it only stops its own loop on a
 * cancellation, which is the other layer's question and a different answer.
 */

export interface RetryAsyncOptions extends BackoffOptions {
  /**
   * Retries after a transient failure, so the total attempts is `maxRetries + 1`.
   * Defaults to 2, matching `GroupedExtractorOptions`.
   */
  readonly maxRetries?: number;
  /**
   * Injectable sleep used between retry attempts, so tests do not wait real seconds.
   * Takes the **already-computed** `fullJitterDelay` result in milliseconds, exactly as
   * `GroupedExtractorOptions.delay` does — a caller that wants no backoff passes a
   * function that ignores its argument and resolves immediately. Defaults to a
   * `setTimeout`-backed sleep, matching `grouped-extractor.ts`'s default.
   */
  readonly delay?: (ms: number) => Promise<void>;
  /** The caller's cancellation, consulted before each attempt and after each failure. */
  readonly signal?: AbortSignal;
  /**
   * Fired immediately before each attempt starts, **1-based** — 1 on the first try,
   * matching `extraction-observer.ts`'s `attempt` contract, which forwards this number
   * straight onto the event. Never fired for an attempt the pre-attempt abort check
   * prevented: an attempt that never ran must not appear in the attempt count.
   */
  readonly onAttempt?: (attempt: number) => void;
}

/**
 * The default {@link RetryAsyncOptions.delay} — a real `setTimeout` sleep. Tests
 * inject a fake that records the value and resolves immediately.
 */
const defaultDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_MAX_RETRIES = 2;

/**
 * Retry transiently-failing async work, rethrowing everything else untouched.
 *
 * The rules, in the order they are checked. **Before each attempt:** if the caller's
 * signal has already aborted, throw without starting the attempt and without counting
 * it — rethrowing the previous attempt's error when there is one (and it is an
 * `Error`), because the caller asked to stop after a real failure and deserves the
 * failure that actually happened; a fresh {@link CancellationError} only when there is
 * no previous error to rethrow, which is attempt 1. **After a failure:** a
 * `TerminalQueueError` is rethrown untouched; a cancellation (per `isCancellation`,
 * consulted with the caller's signal) is rethrown untouched; a failure for which
 * `isTransientFailure` returns `false` is rethrown untouched; anything else is retried
 * until `maxRetries` is exhausted, after which the last error is rethrown. A
 * `SchemaParseError` is retried, because `isTransientFailure` already returns `true`
 * for it.
 *
 * @param work - the async work to run. Its argument is the 1-based attempt number,
 *   the same number {@link RetryAsyncOptions.onAttempt} receives.
 * @param options - the retry policy; see {@link RetryAsyncOptions}.
 */
export async function retryAsync<T>(
  work: (attempt: number) => Promise<T>,
  options: RetryAsyncOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const delay = options.delay ?? defaultDelay;
  const signal = options.signal;
  // Pre-compute the backoff options object once — passed to fullJitterDelay on every
  // retry. The random function defaults to Math.random inside fullJitterDelay when not
  // supplied here.
  const backoff: BackoffOptions = {
    baseMs: options.baseMs,
    capMs: options.capMs,
    random: options.random,
  };

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // An attempt that never ran must not appear in the attempt count — checked at
    // the TOP of the loop, before the attempt starts. On the first attempt there
    // is no previous error to rethrow, which is why a fresh CancellationError is
    // thrown there rather than a captured one.
    if (signal?.aborted) {
      if (lastError instanceof Error) throw lastError;
      throw new CancellationError(
        "retryAsync: the caller's signal had already aborted — no attempt was started",
      );
    }

    options.onAttempt?.(attempt + 1);

    try {
      return await work(attempt + 1);
    } catch (cause) {
      lastError = cause;
      // A deterministic failure — re-sending an identical request reproduces it.
      // Retrying would burn the budget for nothing.
      if (cause instanceof TerminalQueueError) throw cause;
      // A cancellation is not a transient blip — stop immediately, untouched.
      if (isCancellation(cause, signal)) throw cause;
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
}
