import { isTransientFailure } from "./storage/backoff.js";
import type { Transcript } from "./transcript.js";
import { TranscriberUnavailableError } from "./transcriber.js";
import { UnsupportedItemError } from "./unsupported-item.js";

/**
 * @file The transcription arbiter: a caller-supplied classifier that decides
 * whether a transcriber candidate's outcome is good enough, whether to try the
 * next candidate, or whether to give up and let the relay's backoff handle the
 * failure.
 *
 * This is a **sibling** of `arbitration.ts | arbitration.ts`, not a
 * generalisation of it. The extractor engine is parameterised by the field map
 * `F`, stamps `usage.strategy` on accept, and recognises `SchemaParseError`;
 * none of that applies here. A `Transcript` carries its own `engine` (required,
 * set by the implementation that ran), so there is nothing to stamp, and the
 * transcriber side's error vocabulary is `UnsupportedItemError` and
 * `TranscriberUnavailableError`, not `TerminalError` and `SchemaParseError`.
 * What is shared is a _pattern_ — outcomes in settlement order, an `exhausted`
 * flag, an accept/continue/give-up verdict, exhaustion checked first — not a
 * type. See the document-transcription plan Task 4's Intent for the full
 * argument.
 *
 * The honest residual risk of a sibling rather than a shared module is **drift**:
 * a fourth lesson learned on one side now has two homes. If you fix a bug here,
 * check whether `arbitration.ts | arbitration.ts` has the same one, and
 * vice versa.
 */

/**
 * One settled candidate: either a produced transcript or the error it failed
 * with.
 *
 * The two branches are mutually exclusive at the type level (`error` and
 * `result` are `never` on the opposite branch) so a constructed outcome cannot
 * silently carry both.
 */
export type TranscriptionOutcome =
  | { readonly candidate: string; readonly result: Transcript; readonly error?: never }
  | { readonly candidate: string; readonly error: unknown; readonly result?: never };

/** The success branch of {@link TranscriptionOutcome}. */
type TranscriptionResultOutcome = Extract<TranscriptionOutcome, { result: Transcript }>;
/** The failure branch of {@link TranscriptionOutcome}. */
type TranscriptionErrorOutcome = Extract<TranscriptionOutcome, { error: unknown }>;

/**
 * What the arbiter receives each time a candidate settles.
 *
 * `outcomes` is in settlement order. Under the sequential ladder there is no
 * divergence between settlement and dispatch order, but the contract says
 * settlement order so a future concurrent combinator would not need to change
 * the vocabulary.
 */
export interface TranscriptionArbiterInput {
  /** Every outcome so far, in the order they settled. */
  readonly outcomes: readonly TranscriptionOutcome[];
  /** True once every candidate has settled. The arbiter must then accept or give up. */
  readonly exhausted: boolean;
}

/**
 * The arbiter's verdict: accept a transcript, try the next candidate, or stop
 * and throw an error. The three discriminants are named so a mistyped verdict
 * is a compile-time error rather than a silent `continue`.
 */
export type TranscriptionArbiterVerdict =
  { readonly accept: Transcript } | { readonly continue: true } | { readonly giveUp: unknown };

export type TranscriptionArbiter = (
  input: TranscriptionArbiterInput,
) => TranscriptionArbiterVerdict;

// ---
// Outcome discrimination — carried over from arbitration.ts.
//
// Discriminate on the `result` VALUE, never on key presence.  `result?: never`
// permits an explicit `result: undefined`, so an error outcome written with the
// key present would read as a success under a `"result" in outcome` test.  The
// guard tests the value, and `result` is the discriminant rather than `error`
// because `throw undefined` is legal (an error outcome can carry `undefined`)
// but a `Transcript` is always an object.
// ---

function isResultOutcome(outcome: TranscriptionOutcome): outcome is TranscriptionResultOutcome {
  return outcome.result !== undefined;
}

function isErrorOutcome(outcome: TranscriptionOutcome): outcome is TranscriptionErrorOutcome {
  return outcome.result === undefined;
}

/**
 * The default arbiter, mirroring `terminalFallsThrough`'s shape but with
 * different rules. Rules, in this order (D7):
 *
 * 1. First success → **accept** it.
 * 2. **Exhausted** → give up with the first _retryable_ error if there is one,
 *    else with the first error. The retryable-first preference matters: a
 *    ladder where pdf.js said `no-text-layer` (terminal) and OCR then failed
 *    on a dropped uplink (retryable) must be retried, not buried in `dead`.
 * 3. First `UnsupportedItemError` **or** `TranscriberUnavailableError` →
 *    **continue**. Both mean "not this engine"; they differ only in whether
 *    the verdict is cached, and the ladder caches nothing. Demotion is
 *    `firstCapable`'s job — say so, and say that the two compose (a ladder of
 *    `firstCapable` composites, or a `firstCapable` roster of ladders).
 * 4. Any other error → **give up** with it. That is an attempt failure, the
 *    queue already owns it, and letting it route to a different engine is
 *    precisely the bug non-negotiable #2 exists to prevent.
 *
 * Rule 2 is a **deliberate divergence** from `terminalFallsThrough`, which at
 * exhaustion gives up with the first error full stop. Do not describe this as
 * mirroring that; it does not.
 *
 * Exhaustion is checked before every "keep going" branch, and the ordering is
 * load-bearing — `arbitration.ts` carries a comment about the version that got
 * this backwards and died with a `TypeError` instead of the real error on the
 * primary case it existed for. Do not reorder.
 */
export function unsupportedFallsThrough(
  input: TranscriptionArbiterInput,
): TranscriptionArbiterVerdict {
  // Rule 1: first success → accept.
  const firstResult = input.outcomes.find(isResultOutcome);
  if (firstResult) {
    return { accept: firstResult.result };
  }

  // EXHAUSTION IS CHECKED FIRST, and the ordering is load-bearing. `continue`
  // is illegal once every candidate has settled — the engine rejects it as a
  // caller bug — so every "keep going" branch below must be unreachable at
  // exhaustion. An earlier version of this pattern (on the extractor side,
  // arbitration.ts) checked a continue-branch before this one and died with a
  // TypeError instead of surfacing the real error.
  if (input.exhausted) {
    // Rule 2: prefer a retryable error over a terminal one.
    const firstRetryable = input.outcomes.find(
      (outcome): outcome is TranscriptionErrorOutcome =>
        isErrorOutcome(outcome) && isTransientFailure(outcome.error),
    );
    if (firstRetryable) {
      return { giveUp: firstRetryable.error };
    }
    const firstError = input.outcomes.find(isErrorOutcome);
    if (firstError) {
      return { giveUp: firstError.error };
    }
  }

  // Rule 3: UnsupportedItemError or TranscriberUnavailableError → continue.
  // Both mean "not this engine"; they differ only in whether the verdict is
  // cached, and the ladder caches nothing. Demotion is firstCapable's job.
  // The two compose: a ladder of firstCapable composites, or a firstCapable
  // roster of ladders.
  const firstUnsupported = input.outcomes.find(
    (outcome): outcome is TranscriptionErrorOutcome =>
      isErrorOutcome(outcome) &&
      (outcome.error instanceof UnsupportedItemError ||
        outcome.error instanceof TranscriberUnavailableError),
  );
  if (firstUnsupported) {
    return { continue: true };
  }

  // Rule 4: any other error → give up with it. That is an attempt failure, the
  // queue already owns it, and letting it route to a different engine is
  // precisely the bug non-negotiable #2 exists to prevent.
  const firstOther = input.outcomes.find(isErrorOutcome);
  if (firstOther) {
    return { giveUp: firstOther.error };
  }

  return { continue: true };
}

// ---
// Verdict validation — carried over from arbitration.ts.
//
// `isResultOutcome` first is load-bearing. Comparing `outcome.result ===
// verdict.accept` alone matches an ERROR outcome against an arbiter that
// accepted `undefined`, because both sides are `undefined` — the guard is
// bypassed and the engine returns a transcript that does not exist. Narrowing
// to result outcomes first makes an `undefined` accept match nothing.
// ---

/**
 * Apply an arbiter's verdict, validating it. Returns the accepted transcript or
 * `"continue"`; throws on `giveUp` or on an invalid verdict.
 *
 * No result stamping: `Transcript.engine` is already required and set by the
 * implementation that ran, so "which engine produced this?" is answerable off
 * `storage.captures.list()` for free. A second copy of that truth is a defect.
 */
export function applyTranscriptionVerdict(
  verdict: TranscriptionArbiterVerdict,
  input: TranscriptionArbiterInput,
  arbiter: TranscriptionArbiter,
): Transcript | "continue" {
  if ("accept" in verdict) {
    const acceptedOutcome = input.outcomes.find(
      (outcome): outcome is TranscriptionResultOutcome =>
        isResultOutcome(outcome) && outcome.result === verdict.accept,
    );
    if (!acceptedOutcome) {
      throw new TypeError(
        `arbiter ${arbiter.name || "(anonymous)"} returned a transcript not produced by any candidate`,
      );
    }
    return acceptedOutcome.result;
  }

  if ("giveUp" in verdict) {
    throw verdict.giveUp;
  }

  if (input.exhausted) {
    throw new TypeError(`arbiter ${arbiter.name || "(anonymous)"} returned continue at exhaustion`);
  }

  return "continue";
}
