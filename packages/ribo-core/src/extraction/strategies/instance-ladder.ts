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

import { fallbackExtractor } from "../fallback-extractor.js";
import { stampStrategy } from "../extraction-observer.js";
import type { Enveloped, NoProvenance } from "../../provenance/enveloped.js";
import type { ExtractionArbiter } from "../arbitration.js";
import type { ExtractionObserver, ExtractionUnit } from "../extraction-observer.js";
import type { Extractor } from "../extractor.js";

import { perGroupArrayExtractor, perGroupSingletonExtractor } from "./per-group.js";
import type { PerGroupOptions } from "./per-group.js";
import { scopedInstanceExtractor } from "../scoped-instance/instance-fill.js";
import type { ScopedFillOptions } from "../scoped-instance/instance-fill.js";

/** Options for {@link instanceLadder}. */
export interface InstanceLadderOptions<
  V extends Record<string, unknown>,
  P = NoProvenance,
> extends ExtractionObserver {
  /** Arbiter that decides, after each tier settles, whether to accept, continue, or give up. */
  readonly arbiter: ExtractionArbiter<Enveloped<V, P>>;
  /** Tier 1 — house-wide inventory pass followed by scoped per-instance fills. */
  readonly tier1: ScopedFillOptions<V, P>;
  /** Tier 2 — per-group calls with array responses (weaker isolation, still multi-instance). */
  readonly tier2: PerGroupOptions<V, P>;
  /** Tier 3 — per-group calls with singleton responses (cannot represent a second instance). */
  readonly tier3: PerGroupOptions<V, P>;
}

/**
 * Compose a tier's own `onUnit` with the ladder's stamped copy. Both fire on
 * every event: the tier's handler sees the raw event, the ladder's sees it
 * stamped with the tier id. Returns the tier's own handler unchanged when the
 * ladder has no observer, so an absent ladder observer stays absent.
 */
function mergeTierObserver<U extends ExtractionUnit>(
  own: ((event: U) => void) | undefined,
  stamped: ((event: ExtractionUnit) => void) | undefined,
): ((event: U) => void) | undefined {
  if (stamped === undefined) return own;
  if (own === undefined) return stamped;
  return (event: U) => {
    own(event);
    stamped(event);
  };
}

/**
 * Build the R1.6 instance-modeling extraction ladder.
 *
 * Returns an {@link Extractor} that tries the tiers in order, asks the arbiter
 * after each one settles, and stamps the accepted tier's name onto
 * `result.usage.strategy`. The arbiter is the host's policy hook: it decides
 * whether a degraded result is acceptable and what to do at exhaustion.
 *
 * The ladder's `onUnit` is threaded into every tier, wrapped in
 * {@link stampStrategy} so each unit arrives carrying `strategy: "tier1" |
 * "tier2" | "tier3"` and is attributable without the consumer tracking state.
 * A tier's own `onUnit` is not dropped — both fire, and the ladder's copy is
 * the stamped one.
 */
export function instanceLadder<V extends Record<string, unknown>, P = NoProvenance>(
  options: InstanceLadderOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  const { arbiter, tier1, tier2, tier3, onUnit } = options;
  return fallbackExtractor(
    [
      {
        strategy: "tier1",
        extractor: scopedInstanceExtractor({
          ...tier1,
          onUnit: mergeTierObserver(tier1.onUnit, stampStrategy("tier1", onUnit)),
        }),
      },
      {
        strategy: "tier2",
        extractor: perGroupArrayExtractor({
          ...tier2,
          onUnit: mergeTierObserver(tier2.onUnit, stampStrategy("tier2", onUnit)),
        }),
      },
      {
        strategy: "tier3",
        extractor: perGroupSingletonExtractor({
          ...tier3,
          onUnit: mergeTierObserver(tier3.onUnit, stampStrategy("tier3", onUnit)),
        }),
      },
    ],
    arbiter,
  );
}
