import type { Extractor } from "./extractor.js";
import {
  createSequentialExtractor,
  type ExtractionArbiter,
  type ExtractorEngineCandidate,
} from "./arbitration.js";

/**
 * @file `fallbackExtractor` — try extraction strategies in order and let an arbiter decide
 * whether to accept the outcome, try the next strategy, or give up.
 *
 * This is the first public combinator over the shared sequential engine. It has no admission
 * gate (every candidate is admitted) and stamps the accepted strategy id onto
 * `result.usage.strategy`. The policy is entirely in the caller-supplied arbiter: the engine
 * owns iteration and stamping, the arbiter owns the accept/reject/give-up decision.
 *
 * A fallback belongs *inside* each `compositeExtractor` entry, not around the composite. That
 * keeps "this strategy failed" (the arbiter's concern) separate from "this engine is unavailable"
 * (the composite's concern). See `docs/roadmap/design/extractor-arbitration-design.md` §4.4.
 */

/** One rung on the strategy ladder: a strategy id and the extractor that implements it. */
export interface FallbackCandidate<F> {
  readonly strategy: string;
  readonly extractor: Extractor<F>;
}

/**
 * Try a list of strategies in order, asking the arbiter after each one settles whether to
 * accept, continue, or give up.
 *
 * The accepted result's `usage.strategy` is set to the winning strategy id, preserving all other
 * usage fields. The duplicate-identifier and empty-list guards live in the shared engine, so
 * every combinator built over it inherits them.
 */
export function fallbackExtractor<F>(
  candidates: readonly FallbackCandidate<F>[],
  arbiter: ExtractionArbiter<F>,
): Extractor<F> {
  return createSequentialExtractor({
    candidates: candidates.map(({ strategy, extractor }): ExtractorEngineCandidate<F> => ({
      id: strategy,
      extractor,
    })),
    arbiter,
    stampKey: "strategy",
    buildNoAdmissionError: () => new Error("fallbackExtractor: no candidate was admitted"),
  });
}
