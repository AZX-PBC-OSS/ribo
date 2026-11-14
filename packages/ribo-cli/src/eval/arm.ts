/**
 * @file The arm: the ladder, and the consensus modifier over it.
 *
 * The ladder is core's `fallbackExtractor` over `{ strategy, extractor }`
 * candidates with core's default arbiter (`terminalFallsThrough`) — the runner
 * holds no error-inspecting fall-through logic of its own, so a terminal
 * failure falls through to the next rung and a transient one does not, by
 * core's rule rather than the runner's.
 *
 * The consensus modifier wraps the WHOLE ladder: each candidate is the arm
 * itself, so the modifier's cost is the ladder's cost multiplied by the
 * candidate count. The candidates run on the same client and the same model.
 */
import {
  consensusExtractor,
  fallbackExtractor,
  majorityValues,
  terminalFallsThrough,
  unanimousValues,
} from "@azx/ribo-core";
import type { ConsensusArbiter, Enveloped, Extractor, NoProvenance } from "@azx/ribo-core";

import { buildStrategy } from "./strategy.js";
import type { EvalStrategyContext } from "./strategy.js";

/** The arm's extractor type — the enveloped shape every strategy returns. */
export type EvalExtractor = Extractor<Enveloped<Record<string, unknown>, NoProvenance>>;

/**
 * Build the arm the settings describe: the ladder, wrapped in the consensus
 * modifier when the settings ask for one.
 * @param context - The target, the transport and the settings.
 * @returns The arm's extractor.
 * @category Eval
 */
export function buildArm(context: EvalStrategyContext): EvalExtractor {
  const ladder = fallbackExtractor(
    context.settings.strategies.map((strategy) => ({
      strategy,
      extractor: buildStrategy(strategy, context),
    })),
    terminalFallsThrough,
  );

  const candidates = context.settings.consensusCandidates;
  if (candidates === undefined) return ladder;

  const arbiter: ConsensusArbiter =
    context.settings.consensusArbiter === "majority" ? majorityValues : unanimousValues;
  return consensusExtractor(
    Array.from({ length: candidates }, () => ladder),
    {
      target: context.target,
      arbiter,
    },
  );
}
