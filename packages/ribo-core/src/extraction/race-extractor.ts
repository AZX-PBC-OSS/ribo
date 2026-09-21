import type { Extractor } from "./extractor.js";
import {
  createConcurrentExtractor,
  type ConcurrentExtractorCandidate,
  type ExtractionArbiter,
} from "./arbitration.js";

/**
 * @file `raceExtractor` — start every extraction strategy at once and let an arbiter decide
 * whether to accept an outcome as it lands, wait for more, or give up.
 *
 * This is the concurrent public combinator over the shared engine. It has no admission
 * gate (every candidate is admitted) and stamps the accepted strategy id onto
 * `result.usage.strategy`. The policy is entirely in the caller-supplied arbiter: the engine
 * owns scheduling and stamping, the arbiter owns the accept/reject/give-up decision.
 *
 * Keeping `raceExtractor` a separate constructor rather than a flag on a shared one is the
 * same structural guarantee `hedged` provides: concurrency is opt-in by name, not a boolean
 * somebody can flip. See `docs/roadmap/design/extractor-arbitration-design.md` §3.1 and §4.5.
 */

/** One lane in the race: a strategy id and the extractor that implements it. */
export interface RaceCandidate<F> {
  readonly strategy: string;
  readonly extractor: Extractor<F>;
}

/**
 * Start every strategy at once and ask the arbiter after each one settles whether to accept,
 * continue waiting, or give up.
 *
 * The accepted result's `usage.strategy` is set to the winning strategy id, preserving all other
 * usage fields. `outcomes` reaches the arbiter in settlement order, and `exhausted` is true only
 * once every candidate has settled. The duplicate-identifier and empty-list guards live in the
 * shared engine, so every combinator built over it inherits them.
 */
export function raceExtractor<F>(
  candidates: readonly RaceCandidate<F>[],
  arbiter: ExtractionArbiter<F>,
): Extractor<F> {
  return createConcurrentExtractor({
    candidates: candidates.map(({ strategy, extractor }): ConcurrentExtractorCandidate<F> => ({
      id: strategy,
      extractor,
    })),
    arbiter,
    stampKey: "strategy",
  });
}
