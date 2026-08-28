/**
 * @file The R1.6 instance-modeling strategy ladder (Task 16).
 *
 * Three extraction strategies are composed through `fallbackExtractor` so that a
 * failure in the strongest strategy falls through to a weaker one, and the
 * accepted tier is recorded on `usage.strategy`.
 *
 * | Tier | Strategy                                                  | Isolation |
 * | ---- | --------------------------------------------------------- | --------- |
 * | 1    | House-wide inventory → scoped per-instance fills          | Structural — one slot per call, siblings out of scope |
 * | 2    | Per-group call, model emits an array per collection group | Prose rules only, single undivided attention per group |
 * | 3    | Per-group call, model emits a flat singleton per group    | None — cannot represent a second instance |
 *
 * Tier 3 is deliberately included: for an auditor offline in a basement, a
 * single-instance record may be better than no record. Whether to accept that
 * degraded result is a host decision, expressed through the supplied arbiter's
 * exhaustion call — the SDK does not impose a policy.
 */

import { fallbackExtractor } from "@azx/ribo-core";
import type { Enveloped, ExtractionArbiter, Extractor } from "@azx/ribo-core";

import { perGroupArrayExtractor, perGroupSingletonExtractor } from "./per-group.js";
import type { PerGroupOptions } from "./per-group.js";
import { scopedInstanceExtractor } from "./instance-fill.js";
import type { ScopedFillOptions } from "./instance-fill.js";

/** Options for {@link instanceLadder}. */
export interface InstanceLadderOptions<V extends Record<string, unknown>> {
  /** Arbiter that decides, after each tier settles, whether to accept, continue, or give up. */
  readonly arbiter: ExtractionArbiter<Enveloped<V>>;
  /** Tier 1 — house-wide inventory pass followed by scoped per-instance fills. */
  readonly tier1: ScopedFillOptions<V>;
  /** Tier 2 — per-group calls with array responses (weaker isolation, still multi-instance). */
  readonly tier2: PerGroupOptions<V>;
  /** Tier 3 — per-group calls with singleton responses (cannot represent a second instance). */
  readonly tier3: PerGroupOptions<V>;
}

/**
 * Build the R1.6 instance-modeling extraction ladder.
 *
 * Returns an {@link Extractor} that tries the tiers in order, asks the arbiter
 * after each one settles, and stamps the accepted tier's name onto
 * `result.usage.strategy`. The arbiter is the host's policy hook: it decides
 * whether a degraded result is acceptable and what to do at exhaustion.
 */
export function instanceLadder<V extends Record<string, unknown>>(
  options: InstanceLadderOptions<V>,
): Extractor<Enveloped<V>> {
  const { arbiter, tier1, tier2, tier3 } = options;
  return fallbackExtractor(
    [
      { strategy: "tier1", extractor: scopedInstanceExtractor(tier1) },
      { strategy: "tier2", extractor: perGroupArrayExtractor(tier2) },
      { strategy: "tier3", extractor: perGroupSingletonExtractor(tier3) },
    ],
    arbiter,
  );
}
