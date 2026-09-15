/**
 * @file The retry-budget derivation — shared by every managed extractor that
 * caps retries to fit a step timeout. Hoisted from `ribo-extractor-openai`'s
 * `per-group.ts` and `instance-fill.ts`, where it existed as two byte-identical
 * copies. Returning the {@link RetryBudget} event shape rather than a bare
 * number means the value that governs the run and the value a consumer is later
 * told cannot disagree — see `extraction-observability-design.md` §0.4.
 */

/**
 * Default conservative upper bound on one chat call's wall-clock duration.
 * A structured-output call typically takes 10–30 s; 120 s leaves headroom for
 * a slow endpoint without the retry budget being so tight it cannot absorb a
 * real blip. This is a physical assumption about call latency, not an arbitrary
 * retry count — the retry budget is derived from it and the step timeout.
 */
export const PER_CALL_CEILING_MS = 120_000;

/**
 * The derived retry budget an extractor reports to its retry loop and to an
 * observer. Returning the event shape rather than a bare number means the
 * number that governs the run and the number a consumer is told can never
 * disagree.
 */
export interface RetryBudget {
  /** What the caller asked for. */
  readonly requested: number;
  /** What fits the step timeout — the value handed to the retry loop. */
  readonly derived: number;
  /** Sequential batches the worst case runs across. */
  readonly batches: number;
  /** The per-call ceiling used in the derivation. */
  readonly perCallCeilingMs: number;
}

/**
 * Shared options mixin for extractors that surface their derived retry budget.
 * `onRetryBudget` fires when the budget was reduced to fit the step timeout;
 * `requireRetryBudget` (default `false`) turns a derived-to-zero budget into a
 * throw — see §0.5 for why the default stays non-throwing.
 */
export interface RetryBudgetObserver {
  /** Called when the retry budget had to be reduced to fit the step timeout. Must not throw. */
  readonly onRetryBudget?: (event: RetryBudget) => void;
  /**
   * When true, a `derived === 0` budget (while `requested > 0`) throws rather
   * than running with no retries. Defaults to `false`.
   */
  readonly requireRetryBudget?: boolean;
}

/**
 * Worst-case accumulated backoff for one call exhausting `retries` retries —
 * the sum of `fullJitterDelay` results when `random()` returns 1 every
 * time, so each delay is `min(cap, base * 2^attempts)`. The real delay is
 * always ≤ this; the budget derivation uses the worst case so the step timeout
 * is never exceeded by backoff alone.
 */
function maxAccumulatedBackoff(retries: number, baseMs: number, capMs: number): number {
  let total = 0;
  for (let i = 0; i < retries; i++) {
    total += Math.min(capMs, baseMs * 2 ** Math.min(i, 32));
  }
  return total;
}

interface DeriveRetryBudgetOptions {
  readonly requested: number;
  readonly batches: number;
  readonly stepTimeoutMs: number;
  readonly perCallCeilingMs: number;
  readonly baseMs: number;
  readonly capMs: number;
}

/**
 * Derive the effective max retries so the worst case — every group exhausting
 * its full retry budget, including backoff delays — fits inside `stepTimeoutMs`.
 *
 * The worst case per batch is one group's full budget:
 *
 *   (retries + 1) * perCallCeilingMs + maxAccumulatedBackoff(retries)
 *
 * across `batches` sequential batches. We decrement from the requested
 * `maxRetries` until it fits, floor 0 — the same relationship the previous
 * derivation enforced, now with accumulated backoff included so a timeout never
 * presents as a failed extraction with no sign that some groups succeeded.
 *
 * Returns a {@link RetryBudget} rather than a bare number: the caller reports
 * `derived` to its retry loop and hands the same object to `onRetryBudget`, so
 * the number that governs the run and the number a consumer is told can never
 * disagree.
 *
 * `perCallCeilingMs` is a per-instance default, not a fixed law: an on-device
 * transport whose calls complete in ~5 s can lower it so the derivation grants
 * a useful retry budget instead of zero.
 */
export function deriveRetryBudget(options: DeriveRetryBudgetOptions): RetryBudget {
  const { requested, batches, stepTimeoutMs, perCallCeilingMs, baseMs, capMs } = options;
  for (let r = Math.max(0, requested); r >= 0; r--) {
    const perGroup = (r + 1) * perCallCeilingMs + maxAccumulatedBackoff(r, baseMs, capMs);
    if (batches * perGroup <= stepTimeoutMs) {
      return { requested, derived: r, batches, perCallCeilingMs };
    }
  }
  return { requested, derived: 0, batches, perCallCeilingMs };
}
