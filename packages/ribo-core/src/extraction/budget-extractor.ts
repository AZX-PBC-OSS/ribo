import type { AnnotatedTranscript } from "../capture/annotated-transcript.js";
import type { ExtractOptions, Extractor, ExtractionResult } from "./extractor.js";
import { TerminalError } from "../storage/backoff.js";

/**
 * @file `budgetExtractor` — the spend-ceiling detector over the `Extractor` seam
 * (`sp2-judging-combinators-design.md` §4.3, ADR 0006). It wraps any
 * {@link Extractor}, reads the returned result's `usage` against the caller's
 * ceilings, and either returns the result untouched or throws an error an
 * arbitration ladder falls through on.
 *
 * Two honesty requirements, both of which belong up here where a reader meets
 * them first:
 *
 * - **It detects; it cannot prevent.** A wrapper sees only what an `Extractor`
 *   returns, so by the time this reads `usage` the calls have been made and paid
 *   for. What it buys is the NEXT run: a ladder falls through to a cheaper
 *   strategy, and a host learns a strategy's cost profile moved. Real prevention
 *   needs a meter on `ExtractOptions` that every implementation honours — the
 *   design names it and declines to build it, because it is an advisory contract
 *   nothing enforces and its value is highest exactly where it is least
 *   verifiable. This is the detector, not the governor; nobody should ship a
 *   cost guarantee on top of it.
 * - **It is honest around one strategy and misleading around a ladder.** An
 *   error outcome carries no usage and an arbitration engine returns only the
 *   accepted candidate's result — so wrapped around a `fallbackExtractor`, this
 *   sees the winning rung's usage and none of the rejected candidates' calls.
 *   The ceiling then under-counts precisely when strategies are being skipped
 *   for cost, which is when a host most wants it. Put this INSIDE a ladder,
 *   around each rung — not around the ladder.
 */

/** What a caller supplies to {@link budgetExtractor}. */
export interface BudgetExtractorOptions {
  /**
   * The ceiling on `ExtractionUsage.calls`, which is the usage's one REQUIRED
   * member — so this is the member that works everywhere. Every extractor knows
   * how many calls it made, including retries; the token members below are
   * optional and several real paths never report them.
   *
   * A ceiling of zero is a ceiling: `0` permits no calls at all, and any result
   * breaches it. Presence is `!== undefined`, never truthiness — a falsy check
   * here would silently permit every call.
   */
  readonly maxCalls?: number;
  /**
   * The ceiling on `ExtractionUsage.promptTokens`. Checked only when the usage
   * reports prompt tokens: a strategy that reports none makes this ceiling
   * VACUOUS, not strict — a result sails through for want of a number to
   * compare, and the silence is documented here rather than converted into a
   * throw that would break those runs (`ExtractionUsage` documents absent as
   * "not reported", not zero).
   */
  readonly maxPromptTokens?: number;
  /**
   * The ceiling on `ExtractionUsage.completionTokens`. Vacuous exactly as
   * {@link maxPromptTokens} is when the usage does not report completion tokens.
   */
  readonly maxCompletionTokens?: number;
  /**
   * The ceiling on the run's total tokens — defined as `promptTokens +
   * completionTokens`, treating an absent member as zero. `ExtractionUsage`
   * carries two further token members, `cachedPromptTokens` and
   * `cacheCreationPromptTokens`; they describe WHERE the prompt tokens came
   * from, so summing all four would double-count the prompt and this ceiling
   * deliberately does not.
   *
   * The total is checked only when at least one of the two was reported; when
   * neither was, the same vacuous rule {@link maxPromptTokens} documents applies
   * to the total as well.
   */
  readonly maxTotalTokens?: number;
}

/**
 * A returned result's usage breached one of {@link BudgetExtractorOptions}'s
 * ceilings.
 *
 * Extends {@link TerminalError} DELIBERATELY — an overspend is a property of the
 * strategy, so retrying it overspends again. Under the shipped default arbiter
 * this error makes a ladder fall through to the next rung, which is the entire
 * point: the next run is a cheaper one. A transient classification would instead
 * make the ladder give up and the relay re-run the expensive rung, on backoff.
 */
export class BudgetExceededError extends TerminalError {
  override readonly name = "BudgetExceededError";

  /** Which ceiling member was breached — e.g. `"maxTotalTokens"`. */
  readonly member: keyof BudgetExtractorOptions;

  /** The ceiling that was breached. */
  readonly ceiling: number;

  /** The observed value that exceeded it — for `maxTotalTokens`, the prompt+completion sum. */
  readonly observed: number;

  constructor(member: keyof BudgetExtractorOptions, ceiling: number, observed: number) {
    super(
      `budgetExtractor: the result's usage breached ${member} — observed ${observed} ` +
        `against a ceiling of ${ceiling}`,
    );
    this.member = member;
    this.ceiling = ceiling;
    this.observed = observed;
  }
}

/**
 * Wrap an {@link Extractor} so a returned result whose `usage` exceeds a
 * ceiling is rejected before anyone acts on it.
 *
 * On each `extract` call the inner extractor runs first — the caller's options
 * bag forwarded whole, this combinator holds no budget of its own — then the
 * result's usage is read against the ceilings. A breach throws
 * {@link BudgetExceededError} — terminal, so the shipped default arbiter falls
 * through to the next rung. A result under every ceiling is returned
 * **untouched, by identity**.
 *
 * The forward-and-read order is the point, and it is the reason this combinator
 * is a detector: see the file header for what that does and does not buy.
 */
export function budgetExtractor<F>(
  extractor: Extractor<F>,
  options: BudgetExtractorOptions,
): Extractor<F> {
  return {
    extract: async (
      transcript: AnnotatedTranscript,
      callerOptions?: ExtractOptions,
    ): Promise<ExtractionResult<F>> => {
      // No try/catch: an inner failure propagates unchanged, which is the
      // behaviour that matters and is pinned by a test. A transient inner
      // failure must stay transient so an arbiter gives up rather than trying
      // the next rung on the same downed transport, and a cancellation must
      // stay a cancellation.
      const result = await extractor.extract(transcript, callerOptions);

      const usage = result.usage;
      const check = (
        member: keyof BudgetExtractorOptions,
        ceiling: number | undefined,
        observed: number | undefined,
      ): void => {
        // Presence is `!== undefined`, never truthiness — `maxCalls: 0` is a
        // ceiling. An absent observed value is the vacuous case: no number to
        // compare is not a breach.
        if (ceiling === undefined || observed === undefined) return;
        if (observed > ceiling) throw new BudgetExceededError(member, ceiling, observed);
      };

      check("maxCalls", options.maxCalls, usage.calls);
      check("maxPromptTokens", options.maxPromptTokens, usage.promptTokens);
      check("maxCompletionTokens", options.maxCompletionTokens, usage.completionTokens);
      // The total sums prompt + completion only (the cache members describe
      // where the prompt tokens came from — adding them double-counts the
      // prompt), treating an absent member as zero, and is checked only when at
      // least one of the two was reported.
      const { promptTokens, completionTokens } = usage;
      if (promptTokens !== undefined || completionTokens !== undefined) {
        check(
          "maxTotalTokens",
          options.maxTotalTokens,
          (promptTokens ?? 0) + (completionTokens ?? 0),
        );
      }

      return result;
    },
  };
}
