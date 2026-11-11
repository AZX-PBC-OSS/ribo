import type { AnnotatedTranscript } from "../capture/annotated-transcript.js";
import { isCancellation } from "../async/cancellation.js";
import type { ScheduleTimer } from "../async/schedule-timer.js";
import type { ExtractOptions, Extractor, ExtractionResult } from "./extractor.js";

/**
 * @file `hedgedExtractor` — the extraction counterpart of `hedgedTranscriber`: start the
 * primary; if it has not settled within a delay, start the hedge too and take
 * whichever finishes first — cancelling the loser, so the usual case bills for
 * one (§4.1 REVISED of the SP3 parity-and-scale design, which maps every
 * resolution rule across).
 *
 * **Deliberately not built on `createConcurrentExtractor`.** That engine
 * forwards the caller's options unchanged and constructs no `AbortController`,
 * so a loser runs to completion and bills. For a hedge, whose whole value is
 * "usually you only pay for one", that is the entire cost question — so this
 * combinator holds the timer, the per-lane controllers and the resolution
 * rules itself, following `timeout-extractor.ts`'s signal and deadline
 * discipline instead of the arbitration engine's scheduling.
 *
 * **No capability probe, no TTL, no cache.** `Transcriber` has a
 * `capability()` contract and `hedgedTranscriber` caches it; `Extractor` is documented as
 * "a plain builder, not a capability contract". Nothing to probe — this
 * returns a plain `Extractor<F>`, and rule 8 of `hedgedTranscriber` (primary not ready →
 * straight delegation) has no analogue and is dropped: readiness is a
 * capability concept.
 */

/**
 * The hedge settled and the run is over: which lane's result was used, or
 * `undefined` when both failed and there was no winner.
 *
 * `winner` is positional (`"primary" | "hedge"`) rather than an engine id,
 * because this combinator takes two bare extractors and has no ids to name —
 * which separates the hedge's fire rate from its win rate just as well.
 * @category Arbitration & Fallback
 */
export interface ExtractionHedgeEvent {
  /**
   * Which lane's result was used. Separating the hedge's fire rate from its
   * win rate is the only way to learn whether this combinator earns its cost;
   * `hedgedTranscriber`'s own event carries a winner for exactly this reason.
   */
  readonly winner: "primary" | "hedge" | undefined;
}

/**
 * How long to give the primary before firing the hedge: a fixed number of
 * milliseconds, or a function of the transcript returning them.
 * @category Arbitration & Fallback
 */
export type HedgeDelay = number | ((transcript: AnnotatedTranscript) => number);

/**
 * What a caller supplies to {@link hedgedExtractor}.
 *
 * @category Arbitration & Fallback
 */
export interface HedgedExtractorOptions {
  /**
   * When to fire the hedge, in milliseconds. Required — **core ships no
   * default.** Core has no model of how long an extraction takes, exactly as
   * it has no model of a real-time factor; a required option with no default
   * is the honest encoding of "we cannot know this for you".
   */
  readonly delay: HedgeDelay;
  /** Timer seam. Defaults to `setTimeout`/`clearTimeout`. See {@link ScheduleTimer}. */
  readonly scheduleTimer?: ScheduleTimer;
  /** Injectable clock in epoch milliseconds. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Fired once at SETTLEMENT, carrying the winner — not at dispatch, where
   * win-or-lose is unknowable. Fires only when the hedge was actually
   * dispatched (never when the primary won before the timer), including when
   * both lanes failed (`winner: undefined`): the hedge still ran and was
   * still paid for. Must not throw; a throwing handler is swallowed and the
   * run continues.
   *
   * This count — not `usage` — is the measure of what hedging costs. See
   * {@link hedgedExtractor} for why the loser's usage is not added.
   */
  readonly onHedge?: (event: ExtractionHedgeEvent) => void;
}

/** The default {@link HedgedExtractorOptions.scheduleTimer}. */
const defaultScheduleTimer: ScheduleTimer = (fn, delayMs) => {
  const id = setTimeout(fn, delayMs);
  return () => clearTimeout(id);
};

/**
 * Race a primary extraction against a hedge on a latency budget.
 *
 * The resolution rules, mapped from `hedgedTranscriber`'s eight (§4.1 REVISED):
 *
 * 0. **A cancellation is not a rejection.** The relay aborts the extract
 *    step's signal on timeout, so a caller abort arrives as a primary
 *    rejection. `isCancellation(reason, callerSignal)` is consulted FIRST:
 *    the cancellation propagates untouched and no hedge is dispatched. When
 *    the caller's own signal is aborted, the caller's abort reason is the
 *    honest error and the primary's inner error never surfaces — the same
 *    precedence `timeout-extractor.ts` states (misreporting a user's cancel
 *    hides a user action). **A cancellation never CAUSES a hedge dispatch** —
 *    which is the precise claim, and weaker than it first reads. If the timer
 *    has already fired, the hedge is running before any cancellation is
 *    observed, so a cancel on that path aborts a hedge that was already
 *    dispatched and `onHedge` reports it with no winner. What rule 0
 *    guarantees is that no cancellation ever starts one.
 * 1. Primary settles before the timer → **primary**. The hedge is never
 *    invoked — the case the combinator exists for.
 * 2. Timer fired, primary settles first → **primary**, and the hedge is
 *    **cancelled**.
 * 3. Timer fired, hedge settles first → **hedge**, and the primary is
 *    **cancelled**.
 * 4. Both already settled → **primary**. Deterministic, not principled:
 *    `hedgedTranscriber` breaks this tie on privacy — audio not leaving the device — and
 *    nothing analogous applies here, so the primary wins because the caller
 *    named it first. (No branch implements this: with both tags settled, the
 *    race resolves with the primary's because it was attached first.)
 * 5. A **non-cancellation** primary rejection dispatches the hedge
 *    immediately, without waiting out the remaining delay. Narrowed from
 *    `hedgedTranscriber`'s rule 5, which fires only on `TranscriberUnavailableError`;
 *    there is no extractor analogue of "this engine cannot serve this item".
 * 6. An ordinary primary rejection after the hedge already succeeded → the
 *    hedge's result.
 * 7. Both reject → **the primary's error** propagates; it is the more
 *    actionable one.
 *
 * **Cancellation needs a controller PER LANE** — one shared controller can
 * only abort *both*. Each lane's is composed with the caller's signal via
 * `AbortSignal.any`, never `??` (the trap `grouped-extractor.ts` documents):
 * a caller-supplied signal that silently replaced the combinator's own would
 * disable cancellation. The winner's controller is left alone; the loser's is
 * aborted the moment a winner is known.
 *
 * **Every discarded promise gets a rejection handler**, or a losing failure
 * surfaces as an unhandled rejection — `hedged-transcriber.ts` states this requirement
 * explicitly. And a loser's abort rejection must never surface as the run's
 * result: `isCancellation` answers true for anything named `AbortError` even
 * while the caller's signal is intact, so a leaked loser rejection would
 * report a **successful** run as cancelled — and the relay's "aborted is
 * deliberately left retryable" posture would re-queue and re-bill it. Loser
 * rejections are reaped; they never become the returned error.
 *
 * **Deadline narrowing, matching `timeout-extractor.ts`'s discipline.** This
 * combinator mints no deadline of its own — the delay is a latency policy,
 * not a wall (rules 2 and 3 continue the run after the timer fires), so the
 * effective deadline is the inherited one, and the effective deadline — not
 * merely the caller's — is what reaches both lanes. An inherited deadline
 * already in the past rejects immediately without calling either lane.
 * **A hedge is never dispatched past the effective deadline**: its fire time
 * is measured from the same start as the timer, and one that would land at or
 * after the wall is pure cost, so no timer is scheduled. Rule 5's failover is
 * untouched by this — its dispatch happens the moment the primary fails,
 * before the wall, where the call can still finish in time.
 *
 * **Usage.** The winner's result is returned whole — its `usage` with it.
 * `strategy` is not stamped: there are no ids to stamp with. The **loser's
 * usage is not added**: `usage` describes the result that was returned, as in
 * every other combinator, and a cancelled lane's partial usage would make the
 * number mean something different here than everywhere else. The true cost of
 * hedging is measured by counting {@link HedgedExtractorOptions.onHedge}
 * fires.
 * @category Arbitration & Fallback
 */
export function hedgedExtractor<F>(
  primary: Extractor<F>,
  hedge: Extractor<F>,
  options: HedgedExtractorOptions,
): Extractor<F> {
  const scheduleTimer = options.scheduleTimer ?? defaultScheduleTimer;
  const now = options.now ?? Date.now;
  const delayOption = options.delay;
  const delayOf: (transcript: AnnotatedTranscript) => number =
    typeof delayOption === "function" ? delayOption : () => delayOption;
  const onHedge = options.onHedge;

  return {
    async extract(
      transcript: AnnotatedTranscript,
      callerOptions?: ExtractOptions,
    ): Promise<ExtractionResult<F>> {
      // The deadline check comes before anything: no lane runs past a wall the
      // caller imposed.
      const atStart = now();
      const effectiveDeadline = callerOptions?.deadline;
      if (effectiveDeadline !== undefined && effectiveDeadline <= atStart) {
        // A plain Error, not ExtractionTimeoutError: that class names the budget
        // that elapsed, and this combinator mints none — the delay is a latency
        // policy, not a wall. `ExtractionTimeoutError(undefined)` would be a typed
        // lie. Classification is unaffected (both are transient by default).
        throw new Error(
          `hedgedExtractor: the caller's deadline had already passed (${effectiveDeadline} ` +
            `is not after ${atStart}) — no budget remains, so neither lane was called`,
        );
      }
      const delayMs = delayOf(transcript);

      const callerSignal = callerOptions?.signal;
      const primaryController = new AbortController();
      const hedgeController = new AbortController();
      const laneSignal = (lane: AbortController): AbortSignal =>
        callerSignal ? AbortSignal.any([callerSignal, lane.signal]) : lane.signal;
      const laneOptions = (signal: AbortSignal): ExtractOptions => ({
        ...callerOptions,
        signal,
        deadline: effectiveDeadline,
      });

      // On a lane's rejection: the caller's own abort reason when the caller's
      // signal is aborted (the cancellation is the honest error — the lane's
      // inner error is an artifact of the abort), the lane's error otherwise.
      const honestRejection = (error: unknown): unknown =>
        callerSignal?.aborted ? callerSignal.reason : error;

      const primaryPromise = primary.extract(
        transcript,
        laneOptions(laneSignal(primaryController)),
      );
      // Tagging attaches a rejection handler to the raw promise, so the
      // primary's rejection is never unhandled even when the race never looks
      // at it again.
      const taggedPrimary = primaryPromise.then(
        (result): LaneTag<F> => ({ lane: "primary", ok: true as const, result }),
        (error): LaneTag<F> => ({ lane: "primary", ok: false as const, error }),
      );

      // The hedge is dispatched only by the race below — after the timer, or
      // immediately on a non-cancellation primary rejection (rule 5).
      const raceBoth = async (): Promise<ExtractionResult<F>> => {
        const hedgePromise = hedge.extract(transcript, laneOptions(laneSignal(hedgeController)));
        const taggedHedge = hedgePromise.then(
          (result): LaneTag<F> => ({ lane: "hedge", ok: true as const, result }),
          (error): LaneTag<F> => ({ lane: "hedge", ok: false as const, error }),
        );

        let winner: "primary" | "hedge" | undefined;
        try {
          const first = await Promise.race([taggedPrimary, taggedHedge]);

          if (first.ok) {
            // Rules 2 and 3 — and rule 4 needs no branch: with both tags
            // already settled, the race resolves with the primary's because it
            // was attached first. The winner's controller is left alone; the
            // loser's is aborted the moment a winner is known. Aborting a lane
            // that already settled is a no-op.
            winner = first.lane;
            (first.lane === "primary" ? hedgeController : primaryController).abort();
            return first.result;
          }

          if (first.lane === "primary") {
            // Rule 0, consulted before the hedge takes over — a cancellation
            // is not a rejection, whatever dispatched it.
            if (isCancellation(first.error, callerSignal)) {
              hedgeController.abort();
              throw honestRejection(first.error);
            }
            // Rules 5 and 6: the hedge takes over. If it succeeds, its result
            // is the run's; if it also fails, the primary's error propagates
            // (rule 7) — by identity, whatever the hedge failed with.
            try {
              const result = await hedgePromise;
              winner = "hedge";
              return result;
            } catch {
              throw honestRejection(first.error);
            }
          }

          // The hedge rejected first — the primary is still a candidate. If it
          // succeeds it wins; if it also fails, its own error propagates
          // (rule 7), which the await below does naturally.
          const result = await primaryPromise;
          winner = "primary";
          return result;
        } finally {
          // Fired at SETTLEMENT with the winner — `undefined` when both lanes
          // failed is a real event, not a missing one: the hedge still ran and
          // was still paid for. A throwing handler must not fail the run.
          if (onHedge) {
            try {
              onHedge({ winner });
            } catch {
              // Swallowed deliberately — a notification must not change behaviour.
            }
          }
        }
      };

      // Rule 0 first; rule 5 — a non-cancellation primary rejection hands over
      // to the hedge immediately, without waiting out the remaining delay.
      const failOver = async (error: unknown): Promise<ExtractionResult<F>> => {
        if (isCancellation(error, callerSignal)) {
          throw honestRejection(error);
        }
        return await raceBoth();
      };

      let cancelTimer: () => void = () => {};
      try {
        if (effectiveDeadline !== undefined && atStart + delayMs >= effectiveDeadline) {
          // The hedge would fire at or after the wall — a call that cannot
          // finish in time is pure cost, so no timer is scheduled and the
          // hedge is never dispatched by the timer. The primary alone runs,
          // with the effective deadline it was handed. A rejection still fails
          // over: rule 5's dispatch happens now, before the wall, where the
          // call can still finish in time.
          const first = await taggedPrimary;
          if (first.ok) return first.result;
          return await failOver(first.error);
        }

        const timerPromise = new Promise<"timer">((resolve) => {
          cancelTimer = scheduleTimer(() => resolve("timer"), delayMs);
        });

        const first = await Promise.race([taggedPrimary, timerPromise]);

        if (first === "timer") {
          return await raceBoth();
        }

        if (first.ok) {
          // Rule 1: the hedge is never invoked.
          return first.result;
        }

        return await failOver(first.error);
      } finally {
        // Every path cancels the timer — a settlement before the delay must
        // not leave a callback that fires into a finished run.
        cancelTimer();
      }
    },
  };
}

/** One lane's settlement, tagged with which lane it came from. */
type LaneTag<F> =
  | { lane: "primary" | "hedge"; ok: true; result: ExtractionResult<F> }
  | { lane: "primary" | "hedge"; ok: false; error: unknown };
