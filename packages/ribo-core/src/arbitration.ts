import type { ExtractionResult } from "./extractor.js";
import { isTransientFailure } from "./queue/backoff.js";

/**
 * @file The arbiter contract: a caller-supplied classifier that decides whether an
 * extraction strategy's outcome is good enough, whether to try the next strategy,
 * or whether to give up and let the relay's backoff handle the failure.
 *
 * This file is pure vocabulary and pure defaults — no scheduling, no extractor.
 * A later combinator will call the arbiter each time a candidate settles, with
 * every outcome so far in settlement order. Keeping the contract here means the
 * core owns the shape of the decision without owning the policy inside it.
 */

/**
 * One settled candidate: either a produced result or the error it failed with.
 *
 * The two branches are mutually exclusive at the type level (`error` and `result`
 * are `never` on the opposite branch) so a constructed outcome cannot silently
 * carry both.
 */
export type ExtractionOutcome<F> =
  | { readonly candidate: string; readonly result: ExtractionResult<F>; readonly error?: never }
  | { readonly candidate: string; readonly error: unknown; readonly result?: never };

type ResultOutcome<F> = Extract<ExtractionOutcome<F>, { result: ExtractionResult<F> }>;
type ErrorOutcome<F> = Extract<ExtractionOutcome<F>, { error: unknown }>;

/**
 * Construct a result outcome. Prefer this over inline objects so the union
 * stays genuinely exclusive.
 */
export function resultOutcome<F>(
  candidate: string,
  result: ExtractionResult<F>,
): ExtractionOutcome<F> {
  return { candidate, result };
}

/**
 * Construct an error outcome. Prefer this over inline objects so the union
 * stays genuinely exclusive.
 */
export function errorOutcome<F>(candidate: string, error: unknown): ExtractionOutcome<F> {
  return { candidate, error };
}

/**
 * What the arbiter receives each time a candidate settles.
 *
 * `outcomes` is in settlement order, not dispatch order: under a race the second
 * candidate started may be the first to settle. `exhausted` means every candidate
 * has settled, not merely that none is left to start — the two readings coincide
 * under sequential scheduling and diverge under a race.
 */
export interface ArbiterInput<F> {
  /** Every outcome so far, in the order they settled. */
  readonly outcomes: readonly ExtractionOutcome<F>[];
  /** True once every candidate has settled. The arbiter must then accept or give up. */
  readonly exhausted: boolean;
}

/**
 * The arbiter's verdict: accept a result, try the next candidate, or stop and
 * throw an error. The three discriminants are named so a mistyped verdict is a
 * compile-time error rather than a silent `continue`.
 */
export type ExtractionArbiter<F> = (
  input: ArbiterInput<F>,
) =>
  | { readonly accept: ExtractionResult<F> }
  | { readonly continue: true }
  | { readonly giveUp: unknown };

function isResultOutcome<F>(outcome: ExtractionOutcome<F>): outcome is ResultOutcome<F> {
  return "result" in outcome;
}

function isErrorOutcome<F>(outcome: ExtractionOutcome<F>): outcome is ErrorOutcome<F> {
  return "error" in outcome;
}

/**
 * The conservative default: accept the first success, fall through on a terminal
 * error, and give up immediately on a transient one.
 *
 * The direction is the opposite of what the name suggests on a first reading.
 * By the time an error reaches the arbiter, the candidate has already spent its
 * own retry budget. A terminal error means the request itself is structurally
 * broken — exactly what a different strategy might fix — so we continue. A
 * transient error means the transport is down, and the next strategy on the same
 * engine shares that transport, so retrying the whole extraction later is better
 * than burning a worse strategy now.
 */
export function terminalFallsThrough<F>(
  input: ArbiterInput<F>,
):
  | { readonly accept: ExtractionResult<F> }
  | { readonly continue: true }
  | { readonly giveUp: unknown } {
  const firstResult = input.outcomes.find(isResultOutcome);
  if (firstResult) {
    return { accept: firstResult.result };
  }

  // A transient error means the transport is down after the candidate's own
  // retries. The next strategy shares that transport, so continuing now would
  // burn it for no gain; give up and let the relay retry the whole extraction.
  const firstTransient = input.outcomes.find(
    (outcome): outcome is ErrorOutcome<F> =>
      isErrorOutcome(outcome) && isTransientFailure(outcome.error),
  );
  if (firstTransient) {
    return { giveUp: firstTransient.error };
  }

  if (input.exhausted) {
    const firstError = input.outcomes.find(isErrorOutcome);
    if (firstError) {
      return { giveUp: firstError.error };
    }
  }

  return { continue: true };
}

/**
 * The degraded-experience arbiter: accept the first success, continue past any
 * failure, and at exhaustion accept the first result or give up if none exists.
 *
 * Naming this separately from `terminalFallsThrough` is how a deployment opts into
 * degradation deliberately rather than by omission.
 */
export function acceptAnySuccess<F>(
  input: ArbiterInput<F>,
):
  | { readonly accept: ExtractionResult<F> }
  | { readonly continue: true }
  | { readonly giveUp: unknown } {
  const firstResult = input.outcomes.find(isResultOutcome);
  if (firstResult) {
    return { accept: firstResult.result };
  }

  if (input.exhausted) {
    const firstError = input.outcomes.find(isErrorOutcome);
    if (firstError) {
      return { giveUp: firstError.error };
    }
  }

  return { continue: true };
}
