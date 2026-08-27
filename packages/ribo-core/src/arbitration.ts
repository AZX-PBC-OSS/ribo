import type { Extractor, ExtractionResult } from "./extractor.js";
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

  // EXHAUSTION IS CHECKED FIRST, and the ordering is load-bearing. `continue` is
  // illegal once every candidate has settled — the engine rejects it as a caller
  // bug — so every "keep going" branch below must be unreachable at exhaustion.
  // An earlier version tested the schema-parse branch before this one, which made
  // a ladder whose candidates ALL failed zod (tier 1 and tier 2 both sampling
  // badly — the primary case this arbiter exists for) return `continue` on the
  // last call and die with a TypeError instead of the parse error. Verified by
  // running it, then pinned below.
  if (input.exhausted) {
    const firstError = input.outcomes.find(isErrorOutcome);
    if (firstError) {
      return { giveUp: firstError.error };
    }
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

// --- Sequential extraction engine -----------------------------------------------------------
//
// The shared scheduler for `fallbackExtractor` and the reimplemented `compositeExtractor`.
// It owns candidate iteration, verdict validation and result stamping; it owns no policy.
// Policy lives in the caller-supplied arbiter, admission in the caller-supplied probe, and
// the provenance key in the caller-supplied stamp. Keeping the engine dumb is what lets the
// three combinators (fallback, composite, and later race) share one path while keeping their
// public guarantees structural: no scheduling flag, no capability vocabulary, no admission
// semantics leak across constructors.

/** A candidate the engine can run: an identifier, an extractor, and an optional admission probe. */
export interface ExtractorEngineCandidate<F> {
  readonly id: string;
  readonly extractor: Extractor<F>;
  /**
   * Optional lazy admission probe. Called only when this candidate is reached and only if no
   * earlier candidate was already accepted; probing behind a winner would be a real side effect
   * (a network hit) and a behaviour change. A probe returns admitted or not-admitted with an
   * opaque detail the caller's error factory formats.
   */
  readonly probe?: () => Promise<AdmissionVerdict>;
}

/** Two-state admission answer: admitted, or refused with an opaque detail for the caller. */
export type AdmissionVerdict =
  { readonly admitted: true } | { readonly admitted: false; readonly detail: unknown };

/** What the caller supplies to {@link createSequentialExtractor}. */
export interface SequentialExtractorOptions<F> {
  readonly candidates: readonly ExtractorEngineCandidate<F>[];
  readonly arbiter: ExtractionArbiter<F>;
  /** Key the engine stamps with the accepted candidate's id on success, e.g. `"engine"` or `"strategy"`. */
  readonly stampKey: string;
  /** Builds the error thrown when every candidate is refused admission. */
  readonly buildNoAdmissionError: (
    rejected: readonly { readonly id: string; readonly detail: unknown }[],
  ) => Error;
}

function validateCandidates<F>(candidates: readonly ExtractorEngineCandidate<F>[]): void {
  if (candidates.length === 0) {
    throw new TypeError("sequential extraction engine requires at least one candidate");
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) {
      throw new TypeError(`sequential extraction engine: duplicate candidate id "${candidate.id}"`);
    }
    seen.add(candidate.id);
  }
}

/**
 * Build a sequential {@link Extractor} from candidates, an arbiter, and a stamp key.
 *
 * Tries candidates in order. Each candidate's admission probe (if any) runs only when the
 * candidate is reached and no earlier candidate was accepted. After each extraction settles,
 * the arbiter is called with every outcome so far in settlement order and an `exhausted` flag
 * that is true only once every candidate has settled. On `accept` the result is stamped with
 * the winning candidate's id under `stampKey`; on `giveUp` the supplied error is thrown
 * unchanged; on `continue` the next candidate is tried if any remain.
 *
 * This is the engine only: no scheduling mode parameter, no capability vocabulary, no
 * admission semantics. Those are pinned by each public combinator that uses it.
 */
export function createSequentialExtractor<F>(options: SequentialExtractorOptions<F>): Extractor<F> {
  const { candidates, arbiter, stampKey, buildNoAdmissionError } = options;
  validateCandidates(candidates);

  return {
    extract: async (transcript: string): Promise<ExtractionResult<F>> => {
      const rejected: { readonly id: string; readonly detail: unknown }[] = [];
      const outcomes: ExtractionOutcome<F>[] = [];

      function applyVerdict(
        verdict: ArbiterVerdict<F>,
        input: ArbiterInput<F>,
      ): ExtractionResult<F> | "continue" {
        if ("accept" in verdict) {
          const acceptedOutcome = input.outcomes.find(
            (outcome): outcome is ResultOutcome<F> => outcome.result === verdict.accept,
          );
          if (!acceptedOutcome) {
            throw new TypeError(
              `arbiter ${arbiter.name || "(anonymous)"} returned a result not produced by any candidate`,
            );
          }
          const accepted = acceptedOutcome.result;
          return {
            ...accepted,
            usage: { ...accepted.usage, [stampKey]: acceptedOutcome.candidate },
          };
        }

        if ("giveUp" in verdict) {
          throw verdict.giveUp;
        }

        if (input.exhausted) {
          throw new TypeError(
            `arbiter ${arbiter.name || "(anonymous)"} returned continue at exhaustion`,
          );
        }

        return "continue";
      }

      let index = 0;
      for (const candidate of candidates) {
        const isLast = index === candidates.length - 1;
        index += 1;

        if (candidate.probe) {
          const verdict = await candidate.probe();
          if (!verdict.admitted) {
            rejected.push({ id: candidate.id, detail: verdict.detail });
            if (isLast && outcomes.length > 0) {
              const input = { outcomes, exhausted: true };
              const result = applyVerdict(arbiter(input), input);
              if (result !== "continue") return result;
            }
            continue;
          }
        }

        try {
          const result = await candidate.extractor.extract(transcript);
          outcomes.push(resultOutcome(candidate.id, result));
        } catch (error) {
          outcomes.push(errorOutcome(candidate.id, error));
        }

        const input = { outcomes, exhausted: isLast };
        const result = applyVerdict(arbiter(input), input);
        if (result !== "continue") return result;
      }

      if (outcomes.length === 0) {
        throw buildNoAdmissionError(rejected);
      }

      // Every candidate is settled, yet the loop did not return. This is a safety net for an
      // arbiter that returned `continue` at the last call without being caught above — which
      // should not happen, but naming the arbiter here keeps the failure diagnosable.
      const input = { outcomes, exhausted: true };
      const result = applyVerdict(arbiter(input), input);
      if (result !== "continue") return result;
      throw new TypeError(
        `arbiter ${arbiter.name || "(anonymous)"} returned continue at exhaustion`,
      );
    },
  };
}
