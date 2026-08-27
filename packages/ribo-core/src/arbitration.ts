import type { ExtractionResult } from "./extractor.js";
import { isTransientFailure } from "./queue/backoff.js";
import { SchemaParseError } from "./schema-parse-error.js";

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

/** The success branch of {@link ExtractionOutcome}. */
export type ResultOutcome<F> = Extract<ExtractionOutcome<F>, { result: ExtractionResult<F> }>;
/** The failure branch of {@link ExtractionOutcome}. */
export type ErrorOutcome<F> = Extract<ExtractionOutcome<F>, { error: unknown }>;

/**
 * Construct a result outcome. Prefer this over inline objects so the union
 * stays genuinely exclusive.
 *
 * Returns the narrowed branch rather than the union: a caller that builds one
 * of these knows which branch it built, and widening here would throw that away
 * at the point it is cheapest to keep.
 */
export function resultOutcome<F>(candidate: string, result: ExtractionResult<F>): ResultOutcome<F> {
  return { candidate, result };
}

/**
 * Construct an error outcome. Prefer this over inline objects so the union
 * stays genuinely exclusive.
 */
export function errorOutcome<F>(candidate: string, error: unknown): ErrorOutcome<F> {
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
export type ArbiterVerdict<F> =
  | { readonly accept: ExtractionResult<F> }
  | { readonly continue: true }
  | { readonly giveUp: unknown };

export type ExtractionArbiter<F> = (input: ArbiterInput<F>) => ArbiterVerdict<F>;

/**
 * Discriminate on the `result` VALUE, never on key presence.
 *
 * `result?: never` permits an explicit `result: undefined`, so an error outcome
 * written as `{ candidate, error, result: undefined }` type-checks — and under a
 * `"result" in outcome` test it read as a SUCCESS. `terminalFallsThrough` then
 * returned `{ accept: undefined }`: it accepted a result that does not exist and
 * swallowed the error. Verified in a REPL against the first implementation of
 * this file, and pinned by a test below.
 *
 * The two guards are exact complements, which is what makes the union genuinely
 * exclusive at runtime as well as in the type. `result` is the discriminant
 * rather than `error` because `throw undefined` is legal, so an error outcome
 * can carry `error: undefined` — but an `ExtractionResult` is always an object.
 */
function isResultOutcome<F>(outcome: ExtractionOutcome<F>): outcome is ResultOutcome<F> {
  return outcome.result !== undefined;
}

function isErrorOutcome<F>(outcome: ExtractionOutcome<F>): outcome is ErrorOutcome<F> {
  return outcome.result === undefined;
}

/**
 * The conservative default: accept the first success, fall through on a terminal
 * error or a schema-parse miss, and give up immediately on a transient one.
 *
 * The direction is the opposite of what the name suggests on a first reading.
 * By the time an error reaches the arbiter, the candidate has already spent its
 * own retry budget. A terminal error means the request itself is structurally
 * broken — exactly what a different strategy might fix — so we continue. A
 * transient error means the transport is down, and the next strategy on the same
 * engine shares that transport, so retrying the whole extraction later is better
 * than burning a worse strategy now.
 *
 * A schema-parse error is a special case: it is sampled (the same request can pass
 * zod on re-send), so `isTransientFailure` still classifies it as retryable and
 * the queue keeps retrying. But it is also a shape mismatch, so a different
 * strategy might succeed where this one keeps sampling badly; we continue.
 */
export function terminalFallsThrough<F>(input: ArbiterInput<F>): ArbiterVerdict<F> {
  const firstResult = input.outcomes.find(isResultOutcome);
  if (firstResult) {
    return { accept: firstResult.result };
  }

  // A schema miss is sampled, not deterministic. The queue should still retry it,
  // but the ladder should also fall through to a different strategy rather than
  // wedging on the same shape. Continue now and let the next candidate try.
  const firstSchemaParse = input.outcomes.find(
    (outcome): outcome is ErrorOutcome<F> =>
      isErrorOutcome(outcome) && outcome.error instanceof SchemaParseError,
  );
  if (firstSchemaParse) {
    return { continue: true };
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
export function acceptAnySuccess<F>(input: ArbiterInput<F>): ArbiterVerdict<F> {
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
