/**
 * @file The eval runner's public data shapes: the settings a caller passes in
 * and the results it gets back.
 *
 * The settings are plain JSON-able data — string ids, numbers and nested plain
 * objects, nothing else — so a run record (T13b) can persist the object
 * verbatim and compare it as a unit. The results are JSON for the same reason:
 * the runner's public surface is corpus-in, JSON-out.
 */

/**
 * A JSON value — the shape the runner's results are made of.
 *
 * The runner's results carry the extraction's own values, which are JSON by
 * construction (the model's structured output, parsed). The type says so
 * explicitly rather than leaving the results untyped.
 * @category Eval
 */
export type EvalJsonValue =
  string | number | boolean | null | EvalJsonValue[] | { readonly [key: string]: EvalJsonValue };

/**
 * One strategy the runner can drive — a rung of an arm's ladder.
 *
 * The ids are the strategies' own names, spelled the way the corpus format
 * and the design doc spell them.
 * @category Eval
 */
export type EvalStrategyId = "single-shot" | "per-group" | "presence-narrowed";

/**
 * The consensus policies the runner can arbitrate with.
 *
 * `"unanimous"` is the default when the modifier is on; `"majority"` is the
 * other shipped policy.
 * @category Eval
 */
export type EvalConsensusArbiter = "unanimous" | "majority";

/**
 * The split caps the runner packs a group's schema under.
 *
 * The two caps are core's own split measures: nullable unions per call and
 * serialized JSON Schema characters per call. An absent cap is not forwarded —
 * the strategies' own defaults apply.
 * @category Eval
 */
export interface EvalSplitCaps {
  /** Max nullable unions per group call before a group is partitioned. */
  readonly maxNullableUnionsPerGroup?: number;
  /** Max serialized JSON Schema characters per group call. */
  readonly maxSerializedCharsPerGroup?: number;
}

/**
 * One arm's settings: the ladder, the model it runs on, and the modifier's
 * and strategies' options.
 *
 * The object is passed in by the caller and stored verbatim by the records
 * ticket; the runner invents no numbers of its own, so an absent option means
 * "the strategy's own default".
 * @category Eval
 */
export interface EvalSettings {
  /** The arm's ordered ladder of strategy ids — one or more, tried in order. */
  readonly strategies: readonly EvalStrategyId[];
  /** The model id sent to the endpoint. Required. */
  readonly model: string;
  /** How many candidates the consensus modifier runs the whole ladder as. */
  readonly consensusCandidates?: number;
  /** The consensus policy. Defaults to `"unanimous"` when the modifier is on. */
  readonly consensusArbiter?: EvalConsensusArbiter;
  /** The retry budget per call, for the strategies that have one. */
  readonly maxRetries?: number;
  /** The cap on generated tokens per call. */
  readonly responseCap?: number;
  /** The split caps the group-shaped calls pack under. */
  readonly splitCaps?: EvalSplitCaps;
}

/**
 * What one case's extraction cost.
 *
 * `calls` counts every model call the case's run made, retries included. The
 * other members are present exactly when the run reported them: absent means
 * "not reported", never zero.
 * @category Eval
 */
export interface EvalUsage {
  /** Model calls made, retries included. */
  readonly calls: number;
  /** Which transport produced the result. */
  readonly engine?: string;
  /** Which rung of the ladder produced the result. */
  readonly strategy?: string;
  /** Prompt tokens summed across every call. */
  readonly promptTokens?: number;
  /** Completion tokens summed across every call. */
  readonly completionTokens?: number;
  /** Prompt tokens served from the provider's prefix cache. */
  readonly cachedPromptTokens?: number;
  /** Prompt tokens written into the provider's prefix cache. */
  readonly cacheCreationPromptTokens?: number;
}

/**
 * One case's result: the extraction's own output, or the failure that ended
 * it.
 *
 * A failed case is a measurement, not an abort: the run continues past it and
 * resolves with both the successes and the failures.
 * @category Eval
 */
export interface EvalCaseResult {
  /** The case's id — the corpus case directory's name. */
  readonly caseId: string;
  /** Whether the case produced an extraction or failed. */
  readonly status: "extracted" | "failed";
  /** The structured fields, parsed at the trust boundary. */
  readonly fields?: EvalJsonValue;
  /** The raw model output, when the strategy reported one. */
  readonly raw?: EvalJsonValue;
  /** What the case's extraction cost. */
  readonly usage?: EvalUsage;
  /** The failure's message, on a failed case. */
  readonly error?: string;
}
