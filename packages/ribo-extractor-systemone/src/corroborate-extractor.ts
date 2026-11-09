import { assertLeafGranularity, groundingCensus, TerminalError } from "@azx/ribo-core";
import type {
  AnnotatedTranscript,
  ExtractOptions,
  Extractor,
  ExtractionResult,
  ExtractionTarget,
  NoProvenance,
  ValidationVerdict,
} from "@azx/ribo-core";
import type { SystemOneClient } from "@azx/ribo-systemone-managed";

import { corroborationCensus } from "./corroboration-census.js";
import type { CorroborationCensus } from "./corroboration-census.js";

/**
 * @file `corroborateExtractor` — the second judging combinator (ADR 0021). It
 * wraps any {@link Extractor}, extends core's pure grounding census with a
 * System One verdict per committed leaf (`corroborationCensus`), hands
 * that census to a caller-supplied synchronous policy, and either returns the
 * result untouched or throws an error an arbitration ladder falls through on.
 *
 * The decisions most worth restating, because an obvious-looking "fix" inverts
 * each of them:
 *
 * - **The rejection is terminal, not transient.** The same reasoning as
 *   `validate-extractor.ts`'s header, verbatim in its consequences: under the
 *   shipped default arbiter a transient rejection makes the ladder give up and
 *   the relay re-run the whole extract step — including the rung that just
 *   failed corroboration — on backoff, until `dead`. A hallucination detector
 *   that becomes a full-price retry loop. Terminal is also the honest reading:
 *   an uncorroborated result is a property of the strategy, not a blip.
 * - **The policy thresholds a ratio, never a leaf.** ADR 0021 measured per-leaf
 *   scores landing on both sides of any threshold — identical mappings scored
 *   0.38 and 0.65 for the same phrase in different transcripts. A count
 *   aggregates that noise away; a policy acting on a single leaf's verdict
 *   produces a flag an auditor learns to ignore. The shipped policy below
 *   thresholds the share of committed leaves, and the test file pins that one
 *   bad leaf in a large result does not reject.
 * - **The ratio has no default.** Nothing measured justifies a number — the one
 *   current-schema data point is one transcript from one model, recorded as a
 *   magnitude, not a recommendation — and a wrong default fails silently in
 *   both directions: too high and the rung never falls through, too low and
 *   every result escalates at full price. Requiring it puts the guess at the
 *   call site, where the host knows what a wasted escalation costs.
 */

/**
 * A corroboration policy rejected the extraction result.
 *
 * Extends {@link TerminalError} DELIBERATELY — see the file header for why the
 * opposite classification produces the opposite of the intended behaviour plus
 * a relay retry loop. Under the shipped default arbiter this error makes a
 * ladder fall through to the next rung, which is the entire point.
 * @category Arbitration & Fallback
 */
export class CorroborationRejectedError extends TerminalError {
  override readonly name = "CorroborationRejectedError";

  /** The tally the policy decided from — so a log reader can re-derive the decision. */
  readonly census: CorroborationCensus;

  /** The human-readable rejection reason — the policy's own words. */
  readonly reason: string;

  constructor(census: CorroborationCensus, reason: string) {
    super(reason);
    this.census = census;
    this.reason = reason;
  }
}

/**
 * The caller-supplied decision a {@link CorroborationCensus} is handed to.
 *
 * Synchronous, like core's `ValidationPolicy` it returns into — the census
 * extension is where the network call lives (the asymmetry that makes this a
 * sibling combinator rather than an option on `validateExtractor`), so by the
 * time the policy runs, every verdict is already in hand. It owns the
 * judgement; the combinator owns the asking and the throw.
 * @category Arbitration & Fallback
 */
export type CorroborationPolicy = (census: CorroborationCensus) => ValidationVerdict;

/**
 * The shipped {@link CorroborationPolicy}: reject when the share of COMMITTED
 * leaves whose verdict is anything other than `"supports"` exceeds `ratio`.
 *
 * `ratio` is a REQUIRED argument with no default — ADR 0021's own choice, and
 * the reason this factory takes one rather than the combinator defaulting it.
 * `contradicts` and `says_nothing` both count; a leaf still carrying a null
 * verdict (no answer came back) does not, exactly as
 * `CorroborationCensusCounts.uncorroborated` tallies them.
 *
 * The reason names the uncorroborated count and the ratio, so a log line
 * identifies the result without the reader re-deriving it.
 * @category Arbitration & Fallback
 */
export const rejectUncorroboratedCommitments = (ratio: number): CorroborationPolicy => {
  return (census) => {
    const uncorroborated = census.counts.uncorroborated;
    const committed = census.counts.committed;
    // A result with nothing committed has nothing to corroborate — a 0/0
    // division here would read as NaN, and NaN > ratio is false, but the
    // honest share of an empty denominator is 0, not an accident of IEEE.
    const share = committed === 0 ? 0 : uncorroborated / committed;
    if (share <= ratio) return { ok: true };
    return {
      reject:
        `corroboration rejected: ${uncorroborated} of ${committed} committed leaves are ` +
        `uncorroborated, above the ${ratio} ratio`,
    };
  };
};

/**
 * What a caller supplies to {@link corroborateExtractor}.
 *
 * @category Arbitration & Fallback
 */
export interface CorroborateExtractorOptions<V extends Record<string, unknown>, P = NoProvenance> {
  /**
   * The field knowledge the inner extractor was built against. Only
   * `extractionSchema` is read here — the transcript for the census comes from
   * the `extract` call, not the target — and it is read ONCE, at construction:
   * {@link assertLeafGranularity} refuses a `"row"` or `"none"` group before
   * any call is made, because this combinator walks per-leaf envelopes and
   * would otherwise count nothing while returning a result that looks judged.
   */
  readonly target: ExtractionTarget<V, P>;
  /** The System One client to ask — the host's proxied, credential-attaching one. */
  readonly client: SystemOneClient;
  /**
   * The caller-supplied policy the census is handed to. Required, with no
   * default: the shipped {@link rejectUncorroboratedCommitments} itself demands
   * a ratio no measurement justifies, so there is no default to inherit —
   * choosing a policy AND its ratio are imports, not flags.
   */
  readonly policy: CorroborationPolicy;
  /**
   * The most corroboration questions one `ask` call carries. Unset means one
   * call — the client batches internally anyway.
   */
  readonly batchSize?: number;
}

/**
 * Wrap an {@link Extractor} so its result is judged on whether the transcript
 * corroborates what it committed to, before anyone sees it.
 *
 * On each `extract` call the inner extractor runs first (the caller's options
 * bag forwarded whole — this combinator holds no budget of its own, so it
 * narrows nothing and replaces nothing); core's {@link groundingCensus} is
 * taken over the result's fields AND its `statedEmptyGroups`, on the
 * transcript's text; `corroborationCensus` extends it with one `choice`
 * verdict per committed leaf — a network call the census itself cannot make,
 * which is the asymmetry that makes this a sibling combinator rather than an
 * option on `validateExtractor` (ADR 0021); the policy decides. A rejected
 * result throws {@link CorroborationRejectedError} — terminal, so the shipped
 * default arbiter falls through to the next rung. A passing result is returned
 * **untouched, by identity** — the combinator judges, it does not transform.
 * (That identity does not survive an arbitration ladder, which returns a
 * stamped shallow copy of whichever result it accepted; that is the engine's
 * business.)
 *
 * **No observer — for now.** ADR 0004's rule ("a wrapper that delegates and
 * judges stays silent") does not cover this combinator: the verification calls
 * ARE work of its own, and ADR 0021 records whether it should report progress
 * units as an open question it does not settle. None are emitted until that
 * question is settled with a design, not by accident.
 * @category Arbitration & Fallback
 */
export function corroborateExtractor<F, V extends Record<string, unknown>, P = NoProvenance>(
  extractor: Extractor<F>,
  options: CorroborateExtractorOptions<V, P>,
): Extractor<F> {
  // Construction-time, before any call: a "row" or "none" group would make the
  // walk count nothing while the result looked judged — silently blind exactly
  // where hallucination is worst.
  assertLeafGranularity(options.target.extractionSchema, { combinator: "corroborateExtractor" });

  return {
    extract: async (
      transcript: AnnotatedTranscript,
      callerOptions?: ExtractOptions,
    ): Promise<ExtractionResult<F>> => {
      // No try/catch: an inner failure propagates unchanged, which is the
      // behaviour that matters and is pinned by a test. A transient inner
      // failure must stay transient so an arbiter gives up rather than trying
      // the next rung on the same downed transport, and a cancellation must
      // stay a cancellation. Catching to re-throw would add nothing but a place
      // for a future edit to convert one.
      const result = await extractor.extract(transcript, callerOptions);
      const census = groundingCensus(result.fields, result.statedEmptyGroups, transcript.text);
      const corroborated = await corroborationCensus(census, result.fields, transcript.text, {
        client: options.client,
        schema: options.target.extractionSchema,
        signal: callerOptions?.signal,
        batchSize: options.batchSize,
      });
      const verdict = options.policy(corroborated);
      if ("reject" in verdict) {
        throw new CorroborationRejectedError(corroborated, verdict.reject);
      }
      return result;
    },
  };
}
