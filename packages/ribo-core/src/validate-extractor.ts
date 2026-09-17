import { assertLeafGranularity } from "./assert-leaf-granularity.js";
import { groundingCensus } from "./grounding-census.js";
import type { GroundingCensus } from "./grounding-census.js";
import type { LeafPath } from "./extracted-leaves.js";
import type { ExtractOptions, Extractor, ExtractionResult, ExtractionTarget } from "./extractor.js";
import type { NoProvenance } from "./enveloped.js";
import type { AnnotatedTranscript } from "./annotated-transcript.js";
import { TerminalError } from "./storage/backoff.js";

/**
 * @file `validateExtractor` — the first judging combinator
 * (`sp2-judging-combinators-design.md` §4.2, wave-2 plan Task 2). It wraps any
 * {@link Extractor}, tallies how well the result is cited ({@link groundingCensus}),
 * hands that tally to a caller-supplied policy, and either returns the result
 * untouched or throws an error an arbitration ladder falls through on.
 *
 * The two decisions most worth restating here, because an obvious-looking
 * "fix" inverts each of them:
 *
 * - **The rejection is terminal, not transient.** `terminalFallsThrough` — the
 *   conservative default arbiter — CONTINUES on a terminal error and gives up on
 *   a transient one, because a transient failure means the transport is down and
 *   the next strategy shares it. A transient rejection would make the ladder give
 *   up, the relay classify the step failure transient, and re-run the whole
 *   extract step including the hallucinating rung, on backoff, until `dead` — a
 *   hallucination detector that becomes a full-price retry loop. Terminal is also
 *   the honest reading: ungrounded output is a property of the strategy, not a
 *   blip. The design's earlier draft had this exactly backwards; the end-to-end
 *   ladder test in `validate-extractor.test.ts` is the pin.
 * - **A null (or blank) span is not a bad citation.** `spanGroundedness` answers
 *   `"ungrounded"` for both, so a leaf that honestly abstained looks identical,
 * by that function alone, to one citing text absent from the transcript. The
 *   census keeps them apart and the default policy acts only on the second.
 */

/** What a {@link ValidationPolicy} returns: accept the census, or reject with a reason. */
export type ValidationVerdict = { readonly ok: true } | { readonly reject: string };

/**
 * The caller-supplied decision a {@link GroundingCensus} is handed to.
 *
 * The policy owns the judgement; the combinator owns the tally and the throw.
 * A policy that wants something the census's counts do not offer walks `leaves` —
 * the three facts per leaf (committed / cited / groundedness) are the complete
 * measurement, and the counts are a convenience over them.
 */
export type ValidationPolicy = (census: GroundingCensus) => ValidationVerdict;

/**
 * A validation policy rejected the extraction result.
 *
 * Extends {@link TerminalError} DELIBERATELY — see the file header for why the
 * opposite classification produces the opposite of the intended behaviour plus a
 * relay retry loop. Under the shipped default arbiter this error makes a ladder
 * fall through to the next rung, which is the entire point.
 */
export class ValidationRejectedError extends TerminalError {
  override readonly name = "ValidationRejectedError";

  /** The tally the policy decided from — so a log reader can re-derive the decision. */
  readonly census: GroundingCensus;

  /** The human-readable rejection reason — the policy's own words. */
  readonly reason: string;

  constructor(census: GroundingCensus, reason: string) {
    super(reason);
    this.census = census;
    this.reason = reason;
  }
}

/** The leaf path as a log-friendly dotted string — for a reason line, not an address. */
const formatLeafPath = (path: LeafPath): string => path.map(String).join(".");

/**
 * The shipped default {@link ValidationPolicy}: reject a committed, cited,
 * ungrounded leaf — and an ungrounded stated-empty group span, which is the same
 * claim at group scale. "There are none of these, and here is the sentence saying
 * so" is a commitment with a citation; a quote absent from the transcript makes it
 * a fabrication whether it decorates a leaf or a group.
 *
 * It rejects nothing else. Specifically it does NOT reject:
 *
 * - a `"near-miss"` — a citation the model reformatted rather than invented, which
 *   the repo's loosened comparison exists to recognise;
 * - an honest abstention;
 * - a committed leaf with no citation at all. That is a real and arguably worse
 *   failure, but it is a DIFFERENT one, no measurement here says how common it is,
 *   and a default that rejects two things is harder to reason about than one that
 *   rejects the thing it is named for. The census surfaces it; a host that wants
 *   it rejected writes four lines.
 *
 * The reason names how many leaves failed and the path of the first, so a log
 * line identifies the result without the reader re-deriving it.
 */
export const rejectUngroundedCommitments = (census: GroundingCensus): ValidationVerdict => {
  const rejectedLeaves = census.leaves.filter(
    (leaf) => leaf.committed && leaf.cited && leaf.groundedness === "ungrounded",
  );
  const rejectedGroups = census.emptyGroups.filter((group) => group.groundedness === "ungrounded");
  if (rejectedLeaves.length === 0 && rejectedGroups.length === 0) return { ok: true };

  const parts: string[] = [];
  const first = rejectedLeaves[0];
  if (first !== undefined) {
    parts.push(
      `${rejectedLeaves.length} of ${census.counts.leaves} committed leaves cite text absent ` +
        `from the transcript (first: "${formatLeafPath(first.path)}")`,
    );
  }
  for (const group of rejectedGroups) {
    parts.push(
      `the stated-empty span for group "${group.group}" cites text absent from the transcript`,
    );
  }
  return { reject: `validation rejected: ${parts.join("; ")}` };
};

/** What a caller supplies to {@link validateExtractor}. */
export interface ValidateExtractorOptions<V extends Record<string, unknown>, P = NoProvenance> {
  /**
   * The field knowledge the inner extractor was built against. Only
   * `extractionSchema` is read here — the transcript for the census comes from
   * the `extract` call, not the target — and it is read ONCE, at construction:
   * {@link assertLeafGranularity} refuses a `"row"` or `"none"` group before any
   * call is made, because this combinator walks per-leaf envelopes and would
   * otherwise count nothing while returning a result that looks judged.
   */
  readonly target: ExtractionTarget<V, P>;
  /**
   * The caller-supplied policy the census is handed to. Defaults to
   * {@link rejectUngroundedCommitments} — choosing a policy is an import, not a flag.
   */
  readonly policy?: ValidationPolicy;
}

/**
 * Wrap an {@link Extractor} so its result is judged on how well it is cited
 * before anyone sees it.
 *
 * On each `extract` call the inner extractor runs first (the caller's options bag
 * forwarded whole — this combinator holds no budget of its own, so it narrows
 * nothing and replaces nothing); the census is taken over the result's fields AND
 * its `statedEmptyGroups`; the policy decides. A rejected result throws
 * {@link ValidationRejectedError} — terminal, so the shipped default arbiter
 * falls through to the next rung. A passing result is returned **untouched, by
 * identity** — the combinator judges, it does not transform. (That identity does
 * not survive an arbitration ladder, which returns a stamped shallow copy of
 * whichever result it accepted; that is the engine's business.)
 *
 * **No observer.** An earlier draft reported a `WholeUnit` per delegated run;
 * this combinator delegates exactly one run and does no work of its own, so its
 * units would duplicate the inner extractor's own stream unit-for-unit and a
 * host wiring both would double-count. A wrapper that delegates and judges stays
 * silent; a combinator that runs candidates of its own reports them. The absence
 * is pinned in the test file, not merely described here.
 */
export function validateExtractor<F, V extends Record<string, unknown>, P = NoProvenance>(
  extractor: Extractor<F>,
  options: ValidateExtractorOptions<V, P>,
): Extractor<F> {
  // Construction-time, before any call: a "row" or "none" group would make the
  // walk count nothing while the result looked judged — silently blind exactly
  // where hallucination is worst.
  assertLeafGranularity(options.target.extractionSchema, { combinator: "validateExtractor" });

  const policy = options.policy ?? rejectUngroundedCommitments;

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
      const verdict = policy(census);
      if ("reject" in verdict) {
        const rejected = new ValidationRejectedError(census, verdict.reject);
        throw rejected;
      }
      return result;
    },
  };
}
