import type { AnnotatedTranscript } from "./annotated-transcript.js";
import type { ScheduleTimer } from "./connectivity.js";
import type { ExtractOptions, Extractor, ExtractionResult } from "./extractor.js";

/**
 * @file `timeoutExtractor` — bound one extraction to a deadline, with an `AbortSignal`
 * the inner extractor can honour.
 *
 * A thin combinator over the core `Extractor` seam, following `fallbackExtractor` /
 * `raceExtractor`'s positional shape: an `F`-only generic takes its extractor first and an
 * options object second. The timer seam is the same injectable `ScheduleTimer`
 * `connectivity.ts` exports and `hedged.ts` uses, so tests drive time without sleeping.
 *
 * What it deliberately does NOT do: read or write a deadline in the options bag
 * (`ExtractOptions.deadline` is Wave 2), and it does not brand its error as a
 * cancellation — see below.
 */

/**
 * The deadline elapsed. Deliberately **not** cancellation-branded.
 *
 * A deadline elapsing and a caller cancelling are different events, and a consumer that
 * cannot tell them apart can report neither honestly. Not carrying the brand means
 * `isTransientFailure` treats it as transient (the unrecognised-error default), so an
 * **outer** `retryExtractor` retries it — a per-attempt deadline with retries around it,
 * which is the composition worth having. A cancellation-branded timeout would make that
 * composition silently do nothing.
 */
export class ExtractionTimeoutError extends Error {
  override readonly name = "ExtractionTimeoutError";
  /** The budget that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(
      `timeoutExtractor: the extraction did not settle within ${timeoutMs} ms — the deadline ` +
        `fired, failing this attempt so whatever wraps it can retry or report`,
    );
    this.timeoutMs = timeoutMs;
  }
}

export interface TimeoutExtractorOptions {
  /**
   * The deadline, in milliseconds. Required — a timeout combinator with a default
   * timeout is a trap. Validated at construction: a non-positive or non-finite value
   * throws, naming the value, as `fullJitterDelay` validates its own input.
   */
  readonly timeoutMs: number;
  /** Timer seam. Defaults to `setTimeout`/`clearTimeout`. See {@link ScheduleTimer}. */
  readonly scheduleTimer?: ScheduleTimer;
}

/** The default {@link TimeoutExtractorOptions.scheduleTimer}. */
const defaultScheduleTimer: ScheduleTimer = (fn, delayMs) => {
  const id = setTimeout(fn, delayMs);
  return () => clearTimeout(id);
};

/**
 * Race an extraction against a deadline.
 *
 * **The shape is a `Promise.race`, following the relay's `withTimeout`.** The deadline
 * must hold even against an inner extractor that ignores its signal — that is the whole
 * point of a timeout. An await-then-convert shape cannot reject until the inner settles,
 * so a hung inner hangs the combinator forever. `withTimeout`'s ordering is copied too:
 * the abort fires **before** the rejection, so anything the signal cancels is already
 * unwinding when the caller sees the timeout.
 *
 * **Signal policy.** The caller's signal and the deadline controller are combined with
 * `AbortSignal.any`, never `??` — a caller-supplied signal that silently replaced the
 * combinator's own would disable the deadline (the exact trap `grouped-extractor.ts`
 * documents).
 *
 * **Precedence when both happen.** If the caller's signal has aborted, the caller's
 * cancellation wins, whatever the timer did — first aborter wins, matching
 * `AbortSignal.any`'s own reason semantics, and misreporting a user's cancel as a
 * deadline would be a lie in the direction that hides a user action. So on rejection:
 * when the caller's signal is intact, the race's reason propagates untouched (an inner
 * error as an inner error, a fired timer as an {@link ExtractionTimeoutError}); when the
 * caller's signal is aborted and the timer's rejection won the race, the caller's own
 * abort reason is thrown — the inner error never surfaced, and the caller's cancellation
 * is the honest error.
 */
export function timeoutExtractor<F>(
  extractor: Extractor<F>,
  options: TimeoutExtractorOptions,
): Extractor<F> {
  const timeoutMs = options.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `timeoutExtractor: timeoutMs must be a positive, finite number of milliseconds, got ${timeoutMs}`,
    );
  }
  const scheduleTimer = options.scheduleTimer ?? defaultScheduleTimer;

  return {
    async extract(
      transcript: AnnotatedTranscript,
      callerOptions?: ExtractOptions,
    ): Promise<ExtractionResult<F>> {
      const callerSignal = callerOptions?.signal;
      const deadline = new AbortController();
      const effectiveSignal = callerSignal
        ? AbortSignal.any([callerSignal, deadline.signal])
        : deadline.signal;

      let timedOut = false;
      let cancelTimer: () => void = () => {};
      const timerPromise = new Promise<never>((_, reject) => {
        cancelTimer = scheduleTimer(() => {
          timedOut = true;
          // Fire the abort BEFORE rejecting, so anything the signal cancels is
          // already unwinding when the caller sees the timeout — the abort is
          // synchronous, so observers of the signal never see a window where the
          // extraction "timed out" but nothing was cancelled.
          //
          // The abort carries the SAME error instance the caller will receive. Two
          // reasons. An inner extractor reading `signal.reason` learns it was a
          // deadline rather than a user's cancel, which is the difference between
          // "try again later" and "stop". And it makes the ordering above testable:
          // promise settlement order is not observable from outside, but a reason
          // that is reference-equal to the thrown error proves the error existed
          // before the abort — an abort-then-construct implementation cannot fake it.
          const expired = new ExtractionTimeoutError(timeoutMs);
          deadline.abort(expired);
          reject(expired);
        }, timeoutMs);
      });

      try {
        const innerPromise = extractor.extract(transcript, {
          ...callerOptions,
          signal: effectiveSignal,
        });
        // Reap the losing promise: when the timer wins, the inner promise is still
        // outstanding and will often reject once its abort lands. An unhandled
        // rejection fails the suite (`hedged.ts` documents this exact trap for the
        // same reason). Attached where the race is set up, not conditionally after.
        innerPromise.catch(() => {});
        return await Promise.race([innerPromise, timerPromise]);
      } catch (error) {
        if (timedOut && callerSignal?.aborted) {
          // The caller's cancellation wins, whatever the timer did. The timer's
          // rejection won the race, so the inner error never surfaced; the caller's
          // own abort reason is the honest error.
          throw callerSignal.reason;
        }
        throw error;
      } finally {
        // Every path clears the timer — resolve, reject, and the caller-abort
        // conversion above.
        cancelTimer();
      }
    },
  };
}
