/**
 * @file The spend guard: what a run will cost, at most, and whether that is
 * allowed.
 *
 * Nothing stands between a typo and a large bill, so every run that reaches
 * this module is priced BEFORE the first model call. The estimate is an UPPER
 * bound, and the direction of its error is fixed: it may overcount, never
 * undercount. An estimate that undercounts refuses too late — after the money
 * is spent — while an estimate that overcounts costs the operator one flag.
 *
 * The call model is READ, never restated. The guard calls inspect's own
 * `describeCalls` (`packages/ribo-cli/src/inspect/calls.ts`) once per run,
 * under the run's own split caps, and reads the rung counts off the report it
 * returns. The guard contains no second copy of that arithmetic: no re-counted
 * groups, no re-split schema, no copied plan.
 *
 * A bound that does not exist is a REFUSAL, never a zero and never another
 * strategy's count. `presenceNarrowedAtMost` is `number | null`, and a null
 * means the guard cannot state an upper bound for this run — the only safe
 * reading of "no bound" is to refuse, and no flag conjures one.
 *
 * The arm's worst case counts EVERY rung of its ladder, because each rung can
 * run and fail before the next starts; the consensus modifier multiplies the
 * whole ladder, because each candidate runs the whole ladder; and the retry
 * budget multiplies the whole thing again, because every call can be attempted
 * `1 + maxRetries` times.
 */
import { describeExtraction } from "@azx/ribo-core";
import type { SchemaPlan } from "@azx/ribo-core";

import type { LoadedCorpus } from "../corpus.js";
import { describeCalls } from "../inspect/calls.js";
import type { CallsReport, SplitCapOptions } from "../inspect/calls.js";
import { CHARS_PER_TOKEN, DEFAULT_COMPLETION_TOKENS } from "../operator/spend.js";
import type { EvalBackendName } from "./backend.js";
import { caseTextOf } from "./case-text.js";
import type { DocumentTexts } from "./documents.js";
import { EvalError } from "./error.js";
import { plannedEvalDryRunTargets } from "./plan.js";
import type { PlannedEvalTarget } from "./plan.js";
import { measurePromptChars } from "./prompt-size.js";
import { priceFor, priceTokens } from "./pricing.js";
import type { PriceResolution } from "./pricing.js";
import { buildEvalTarget } from "./target.js";
import type { EvalSettingsInput, EvalStrategyId } from "./types.js";

export {
  CHARS_PER_TOKEN,
  DEFAULT_COMPLETION_TOKENS,
  DEFAULT_MAX_SPEND_USD,
} from "../operator/spend.js";

/**
 * One rung of an arm's ladder, and the calls it can make per case.
 */
export interface RungEstimate {
  /** The strategy the rung names. */
  readonly strategy: EvalStrategyId;
  /** The calls the rung makes per case, before the multipliers. */
  readonly calls: number;
}

/**
 * One arm's estimate.
 */
export interface ArmEstimate {
  /** The arm's ordered ladder. */
  readonly strategies: readonly EvalStrategyId[];
  /** The arm's rungs and their call counts. */
  readonly rungs: readonly RungEstimate[];
  /** The consensus modifier's candidate count — 1 when the modifier is off. */
  readonly consensusCandidates: number;
  /** The retry multiplier — `1 + maxRetries`. */
  readonly retryMultiplier: number;
  /** The calls the arm makes per case, with every multiplier applied. */
  readonly callsPerCase: number;
  /** The prompt tokens one call of the arm carries. */
  readonly promptTokensPerCall: number;
  /** The completion tokens one call of the arm may generate. */
  readonly completionTokensPerCall: number;
  /** The arm's own cost, for the whole corpus. */
  readonly usd: number;
}

/**
 * A run's estimate: the upper bound on what the run can cost.
 */
export interface SpendEstimate {
  /** The backend the run would spend against. */
  readonly backend: EvalBackendName;
  /**
   * The price the estimate was computed under: the model's own dated row,
   * or the backend's reference row with the fallback stated — the resolution
   * says which, and names the row.
   */
  readonly price: PriceResolution;
  /** How many cases the corpus holds. */
  readonly caseCount: number;
  /** One estimate per arm. */
  readonly arms: readonly ArmEstimate[];
  /** The calls the run makes per case, summed over its arms. */
  readonly callsPerCase: number;
  /** The calls the run makes at most, over the whole corpus. */
  readonly worstCaseCalls: number;
  /** The prompt tokens the run spends at most. */
  readonly worstCasePromptTokens: number;
  /** The completion tokens the run generates at most. */
  readonly worstCaseCompletionTokens: number;
  /** The cost the run can reach, at most, in US dollars. */
  readonly usd: number;
}

/**
 * What the estimate is computed from: the corpus, the run's arms and the
 * backend.
 */
export interface SpendEstimateInput {
  /** The loaded corpus the run measures. */
  readonly corpus: LoadedCorpus;
  /** One caller-supplied settings object per arm, in flag order. */
  readonly arms: readonly EvalSettingsInput[];
  /** The backend the run spends against. */
  readonly backend: EvalBackendName;
  /**
   * The model id every call carries — the run's `--model`, the same one
   * every arm's settings carry. The estimate prices it: the model's own
   * dated row when the price table has one, the backend's reference row
   * otherwise, with the fallback stated rather than silent.
   */
  readonly model: string;
  /**
   * The document inputs' transcribed text, keyed by case id and file name —
   * the same map the run itself is driven with. A document input with no
   * entry is a REFUSAL, never a zero: the guard prices the text the run will
   * send, and a skipped document would undercount — the one direction the
   * estimate may not err in. Transcription is free and local and happens
   * before the estimate, so the text is always there to price.
   */
  readonly documents?: DocumentTexts;
  /** The one parsed semantic plan shared by every planned arm. */
  readonly plan?: SchemaPlan;
}

/**
 * The run's split caps — the ones the estimate's call model is described
 * under.
 *
 * The caps are run-wide: they come from the command's flags, so every arm
 * packs under the same caps. The estimate therefore describes the call model
 * once, under the caps the run will actually use.
 */
const splitCapsOf = (arms: readonly EvalSettingsInput[]): SplitCapOptions =>
  arms[0]?.splitCaps ?? {};

/**
 * The longest transcript the corpus holds.
 *
 * A case carries its own combined text — its inputs joined by core's
 * combiner, in `case-text.ts` — and the longest one is the largest prompt the
 * run can send: the measurement the guard prices. Markers and all: the
 * estimate prices the text the model will actually read.
 */
const longestTranscript = (corpus: LoadedCorpus, documents: DocumentTexts | undefined): string => {
  let longest = "";
  for (const entry of corpus.cases) {
    const text = caseTextOf(corpus, entry, documents);
    if (text.length > longest.length) longest = text;
  }
  return longest;
};

/**
 * Refuse a rung whose bound the report cannot state.
 *
 * The message names the strategy, the bound that is missing and why it is
 * missing, because "the estimate could not be derived" without a cause is a
 * dead end for the operator.
 */
const refuseMissingBound = (strategy: EvalStrategyId, reason: string, fix: string): never => {
  throw new EvalError(
    `the ${strategy} strategy has no call bound for this corpus — the estimate could not be ` +
      `derived, because ${reason} (fix: ${fix})`,
  );
};

/**
 * The calls one rung makes per case, read off the report.
 *
 * The single-shot rung makes exactly one request per attempt whatever the
 * schema's shape, so its count is one; the report's `singleShot` field is the
 * SCHEMA's classification and is null for a grouped schema, which is not a
 * missing bound but a different shape. The per-group and presence-narrowed
 * rungs read their own fields, and a null there is a refusal.
 */
const rungCalls = (
  strategy: EvalStrategyId,
  calls: CallsReport,
  plannedTargets: readonly PlannedEvalTarget[] | undefined,
): number => {
  if (strategy === "single-shot") return calls.singleShot ?? 1;
  if (strategy === "planned") {
    if (plannedTargets !== undefined) return plannedTargets.length;
    return refuseMissingBound(
      strategy,
      "no parsed semantic plan was supplied",
      "pass the reviewed plan shared by the planned arms",
    );
  }
  if (strategy === "per-group") {
    if (calls.perGroup !== null) return calls.perGroup;
    return refuseMissingBound(
      strategy,
      calls.perGroupReason === undefined
        ? "the per-group plan could not be built over this schema"
        : `the per-group plan could not be built: ${calls.perGroupReason}`,
      "narrow the schema, or drop per-group from the arm",
    );
  }
  if (calls.presenceNarrowedAtMost !== null) return calls.presenceNarrowedAtMost;
  // The report states the reason — the same text the calls row carries —
  // never a second derivation that could drift from it.
  return refuseMissingBound(
    strategy,
    calls.presenceNarrowedReason ?? "the calls report stated no reason for the missing bound",
    "use a schema with groups, or drop presence-narrowed from the arm",
  );
};

/**
 * Estimate what a run will cost, at most.
 *
 * The estimate is computed once for the whole run: one `describeCalls` call
 * serves every arm, because the split caps are run-wide.
 * @param input - The corpus, the run's arms and the backend.
 * @returns The estimate.
 * @throws {@link EvalError} when a rung's call bound cannot be stated.
 */
export function estimateSpend(input: SpendEstimateInput): SpendEstimate {
  const { corpus, arms, backend, model, documents } = input;
  const splitCaps = splitCapsOf(arms);

  const planned = arms.some((arm) => arm.strategies.includes("planned"));
  if (planned && input.plan === undefined) {
    throw new EvalError(
      "the planned strategy requires the run's parsed semantic plan before its calls can be " +
        "estimated (fix: pass --plan with the reviewed schema-plan artifact)",
    );
  }
  if (!planned && input.plan !== undefined) {
    throw new EvalError(
      "a semantic plan was supplied to an eval estimate with no planned rung — the plan would " +
        "be silently ignored (fix: remove the plan, or name the planned strategy)",
    );
  }

  const description = describeExtraction({
    schema: corpus.schema,
    ...(splitCaps.maxNullableUnionsPerGroup === undefined
      ? {}
      : { maxNullableUnionsPerGroup: splitCaps.maxNullableUnionsPerGroup }),
    ...(splitCaps.maxSerializedCharsPerGroup === undefined
      ? {}
      : { maxSerializedCharsPerGroup: splitCaps.maxSerializedCharsPerGroup }),
  });
  const calls = describeCalls(description, splitCaps);

  // A planned bound needs core's projected targets. Ordinary rungs keep the
  // guard's original bound-first ordering, including its named no-group refusal.
  const plannedArm = arms.find((arm) => arm.strategies.includes("planned"));
  const targetBundle =
    plannedArm === undefined
      ? undefined
      : buildEvalTarget(corpus.schema, corpus.manifest.prompt, corpus.manifest.name, splitCaps);
  const plannedTargets =
    input.plan === undefined || plannedArm === undefined || targetBundle === undefined
      ? undefined
      : plannedEvalDryRunTargets({
          target: targetBundle.target,
          plan: input.plan,
          settings: plannedArm,
          ...(corpus.manifest.prompt.fieldDescriptions === undefined
            ? {}
            : { fieldDescriptions: corpus.manifest.prompt.fieldDescriptions }),
        });

  // The bounds FIRST: a rung whose bound the call model cannot state refuses
  // the run before anything is measured or priced.
  const rungsByArm = arms.map((arm) =>
    arm.strategies.map((strategy) => ({
      strategy,
      calls: rungCalls(strategy, calls, plannedTargets),
    })),
  );

  // The target the prompts are measured from — the runner's own derivation, so
  // the measured prompts are the prompts the run will send.
  const { target, groups } =
    targetBundle ??
    buildEvalTarget(corpus.schema, corpus.manifest.prompt, corpus.manifest.name, splitCaps);
  const transcript = longestTranscript(corpus, documents);
  const groupInstructions = (groupKey: string): string =>
    corpus.manifest.prompt.groupInstructions?.[groupKey] ?? corpus.manifest.prompt.instructions;

  const price = priceFor(backend, model);
  const caseCount = corpus.cases.length;

  const armEstimates: ArmEstimate[] = arms.map((arm, index) => {
    const rungs = rungsByArm[index] ?? [];
    const retryMultiplier = 1 + (arm.maxRetries ?? calls.maxRetriesDefault);
    const consensusCandidates = arm.consensusCandidates ?? 1;
    const rungCallsTotal = rungs.reduce((total, rung) => total + rung.calls, 0);
    const callsPerCase = rungCallsTotal * retryMultiplier * consensusCandidates;

    const promptChars = measurePromptChars(
      {
        target,
        groups,
        ...(corpus.manifest.prompt.fieldDescriptions === undefined
          ? {}
          : { fieldDescriptions: corpus.manifest.prompt.fieldDescriptions }),
        groupInstructions,
        transcript,
        ...(plannedTargets === undefined ? {} : { plannedTargets }),
      },
      arm.strategies,
    );
    const promptTokensPerCall = Math.ceil(promptChars / CHARS_PER_TOKEN);
    const completionTokensPerCall = arm.responseCap ?? DEFAULT_COMPLETION_TOKENS;

    const armPromptTokens = callsPerCase * caseCount * promptTokensPerCall;
    const armCompletionTokens = callsPerCase * caseCount * completionTokensPerCall;

    return {
      strategies: arm.strategies,
      rungs,
      consensusCandidates,
      retryMultiplier,
      callsPerCase,
      promptTokensPerCall,
      completionTokensPerCall,
      usd: priceTokens(price, armPromptTokens, armCompletionTokens),
    };
  });

  const callsPerCase = armEstimates.reduce((total, arm) => total + arm.callsPerCase, 0);
  const worstCaseCalls = callsPerCase * caseCount;
  const worstCasePromptTokens = armEstimates.reduce(
    (total, arm) => total + arm.callsPerCase * caseCount * arm.promptTokensPerCall,
    0,
  );
  const worstCaseCompletionTokens = armEstimates.reduce(
    (total, arm) => total + arm.callsPerCase * caseCount * arm.completionTokensPerCall,
    0,
  );

  return {
    backend,
    price,
    caseCount,
    arms: armEstimates,
    callsPerCase,
    worstCaseCalls,
    worstCasePromptTokens,
    worstCaseCompletionTokens,
    usd: priceTokens(price, worstCasePromptTokens, worstCaseCompletionTokens),
  };
}
