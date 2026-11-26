/**
 * @file The settings' validation: the refusals that fire before any model
 * call.
 *
 * The runner builds its arm eagerly — the strategies are constructed, and the
 * schema they would drive is derived, before the first case runs — so an
 * invalid settings object is refused with zero requests spent. Every refusal
 * names the offending setting.
 */
import { EvalError } from "./error.js";
import type {
  EvalConsensusArbiter,
  EvalSettings,
  EvalSettingsInput,
  EvalStrategyId,
} from "./types.js";

/** The strategy ids an arm's ladder may name. */
export const EVAL_STRATEGY_IDS: readonly EvalStrategyId[] = [
  "single-shot",
  "per-group",
  "presence-narrowed",
  "planned",
];

/** The consensus policies the modifier may arbitrate with. */
export const EVAL_CONSENSUS_ARBITERS: readonly EvalConsensusArbiter[] = ["unanimous", "majority"];

/**
 * The strategy ids a settings object names.
 *
 * Read through a helper rather than `Array.isArray` at the call site: the
 * guard's own narrowing widens a readonly array's elements to `any`, and the
 * ladder's ids are checked against the known vocabulary below.
 */
const strategyIds = (value: unknown): readonly EvalStrategyId[] =>
  Array.isArray(value) ? (value as EvalStrategyId[]) : [];

/**
 * The cross-field plan-identity rule, shared by effective-settings validation
 * and the persisted document wrapper. A returned problem is phrased for either
 * an EvalError or a zod issue at `settings.planFingerprint`.
 */
export function evalPlanIdentityProblem(
  settings: Pick<EvalSettings, "strategies" | "planFingerprint">,
): string | undefined {
  const planned = settings.strategies.includes("planned");
  if (planned && settings.planFingerprint === undefined) {
    return (
      '"planFingerprint" is required when "strategies" contains "planned" — the runner derives ' +
      "it from core's semantic plan (fix: use the runner-issued effective settings)"
    );
  }
  if (!planned && settings.planFingerprint !== undefined) {
    return (
      '"planFingerprint" is forbidden unless "strategies" contains "planned" — a non-planned ' +
      "run has no semantic plan identity (fix: remove the fingerprint)"
    );
  }
  return undefined;
}

/**
 * Refuse caller input carrying the runner-owned plan identity, then apply the
 * effective-settings rules. The property's presence is refused even when its
 * runtime value is undefined.
 */
export function validateEvalSettingsInput(settings: EvalSettingsInput): void {
  if ("planFingerprint" in settings) {
    throw new EvalError(
      'eval settings: "planFingerprint" is runner-issued and cannot be supplied by a caller — ' +
        "the runner derives planned identity from core's plan (fix: remove the fingerprint)",
    );
  }
  validateEvalSettings(settings);
}

/**
 * Refuse a settings object the runner cannot drive.
 *
 * The refusals cover malformed ladders and models, modifier mismatches and
 * plan identity. A repeated rung is refused because core's sequential engine
 * refuses duplicate candidate ids, and a repeated rung is an authoring mistake
 * worth naming.
 * @param settings - The settings the caller passed in.
 * @throws {@link EvalError} when the settings cannot drive an arm.
 * @category Eval
 */
export function validateEvalSettings(settings: EvalSettings): void {
  const strategies = strategyIds(settings.strategies);
  if (strategies.length === 0) {
    throw new EvalError(
      `eval settings: "strategies" must name at least one strategy (${EVAL_STRATEGY_IDS.join(", ")}) ` +
        "— an arm with no rung drives nothing (fix: name the strategies the arm should try, in order)",
    );
  }
  const seen = new Set<EvalStrategyId>();
  for (const id of strategies) {
    if (!EVAL_STRATEGY_IDS.includes(id)) {
      throw new EvalError(
        `eval settings: "strategies" names "${String(id)}", which is not a strategy — the known ` +
          `strategies are: ${EVAL_STRATEGY_IDS.join(", ")} (fix: name one of those)`,
      );
    }
    if (seen.has(id)) {
      throw new EvalError(
        `eval settings: "strategies" names "${id}" twice — a ladder's rungs are distinct, and the ` +
          "engine refuses a repeated candidate id (fix: name each strategy once)",
      );
    }
    seen.add(id);
  }
  const planIdentityProblem = evalPlanIdentityProblem(settings);
  if (planIdentityProblem !== undefined) {
    throw new EvalError(`eval settings: ${planIdentityProblem}`);
  }
  if (typeof settings.model !== "string" || settings.model.length === 0) {
    throw new EvalError(
      `eval settings: "model" must be a non-empty string — it is the model id the endpoint is ` +
        "asked for (fix: name the model the arm runs on)",
    );
  }
  if (
    settings.consensusCandidates !== undefined &&
    (!Number.isInteger(settings.consensusCandidates) || settings.consensusCandidates < 2)
  ) {
    throw new EvalError(
      `eval settings: "consensusCandidates" must be an integer of at least two — agreement between ` +
        "one sample and nothing is not consensus (fix: raise the candidate count, or drop the " +
        "modifier)",
    );
  }
  if (settings.consensusArbiter !== undefined && settings.consensusCandidates === undefined) {
    throw new EvalError(
      `eval settings: "consensusArbiter" is set without "consensusCandidates" — the policy ` +
        "arbitrates between candidates, and there are none (fix: name the candidate count, or drop " +
        "the policy)",
    );
  }
  if (
    settings.consensusArbiter !== undefined &&
    !EVAL_CONSENSUS_ARBITERS.includes(settings.consensusArbiter)
  ) {
    throw new EvalError(
      `eval settings: "consensusArbiter" names "${String(settings.consensusArbiter)}", which is not ` +
        `a policy — the known policies are: ${EVAL_CONSENSUS_ARBITERS.join(", ")} (fix: name one ` +
        "of those)",
    );
  }
}
