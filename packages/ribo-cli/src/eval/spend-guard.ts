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
import type { ExtractionDescription } from "@azx/ribo-core";

import type { LoadedCase, LoadedCorpus } from "../corpus.js";
import { describeCalls } from "../inspect/calls.js";
import type { CallsReport, SplitCapOptions } from "../inspect/calls.js";
import type { EvalBackendName } from "./backend.js";
import type { DocumentTexts } from "./documents.js";
import { EvalError } from "./error.js";
import { measurePromptChars } from "./prompt-size.js";
import { priceFor, priceTokens } from "./pricing.js";
import type { PriceResolution } from "./pricing.js";
import { buildEvalTarget } from "./target.js";
import type { EvalSettings, EvalStrategyId } from "./types.js";

/**
 * The ceiling the guard applies when the operator names none: USD 10.00.
 *
 * A guard that only guards when configured does not fix the problem it was
 * built for, so the ceiling has a default and the flag tunes it.
 */
export const DEFAULT_MAX_SPEND_USD = 10;

/**
 * The completion tokens a call is assumed to generate when the run sets no
 * response cap: 4,096.
 *
 * An unset cap puts no `maxTokens` on the wire, so the estimate has to bound
 * the completion side some other way — and a stated assumption is the honest
 * way to bound it. The number is one constant, not a table.
 */
export const DEFAULT_COMPLETION_TOKENS = 4096;

/**
 * The characters one token is assumed to be worth: 2.
 *
 * Deliberately conservative — real tokenizers land nearer four characters per
 * token for English prose, so the estimate's prompt side is roughly twice the
 * tokens the run will really spend.
 */
export const CHARS_PER_TOKEN = 2;

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
  /** One settings object per arm, in flag order. */
  readonly arms: readonly EvalSettings[];
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
   * The document cases' transcribed text, keyed by case id — the same map the
   * run itself is driven with. A document case with no entry is a REFUSAL,
   * never a zero: the guard prices the text the run will send, and a skipped
   * document would undercount — the one direction the estimate may not err
   * in. Transcription is free and local and happens before the estimate, so
   * the text is always there to price.
   */
  readonly documents?: DocumentTexts;
}

/**
 * The run's split caps — the ones the estimate's call model is described
 * under.
 *
 * The caps are run-wide: they come from the command's flags, so every arm
 * packs under the same caps. The estimate therefore describes the call model
 * once, under the caps the run will actually use.
 */
const splitCapsOf = (arms: readonly EvalSettings[]): SplitCapOptions => arms[0]?.splitCaps ?? {};

/** The description's group count — the groups the presence phase would walk. */
const groupCountOf = (description: ExtractionDescription): number =>
  (description.keys ?? []).filter((key) => key.kind === "group").length;

/**
 * The text one case's prompt carries: the loaded text of a transcript or text
 * case, the transcribed text of a document case.
 *
 * A document case with no transcribed text is a REFUSAL, never an empty
 * string: the guard may overcount, never undercount, and a document priced at
 * zero characters is an undercount with the case still counted.
 */
const caseText = (entry: LoadedCase, documents: DocumentTexts | undefined): string => {
  if (entry.input.kind !== "document") return entry.input.text;
  const text = documents?.get(entry.id);
  if (text === undefined) {
    throw new EvalError(
      `eval: the corpus case "${entry.id}" is a "document" case, but no transcribed text was ` +
        "supplied for it — the estimate prices a document case on its transcribed text, exactly " +
        "as it prices a transcript case's text, and a skipped document would understate the " +
        "run's cost (fix: transcribe the corpus's document cases with transcribeDocumentCases " +
        "before estimating, and pass the result in)",
    );
  }
  return text;
};

/**
 * The longest transcript the corpus holds.
 *
 * A case carries its own transcript, and the longest one is the largest
 * prompt the run can send — the measurement the guard prices. A document
 * case's text is its transcription, priced exactly like a transcript case's.
 */
const longestTranscript = (corpus: LoadedCorpus, documents: DocumentTexts | undefined): string => {
  let longest = "";
  for (const entry of corpus.cases) {
    const text = caseText(entry, documents);
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
  description: ExtractionDescription,
): number => {
  if (strategy === "single-shot") return calls.singleShot ?? 1;
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
  const reason =
    description.refusal !== undefined
      ? `core's derivation refused the schema: ${description.refusal.message}`
      : groupCountOf(description) === 0
        ? "the schema declares no groups, so the presence phase has nothing to ask about"
        : (calls.perGroupReason ?? "the fill's split could not be derived over this schema");
  return refuseMissingBound(
    strategy,
    reason,
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

  // The bounds FIRST: a rung whose bound the call model cannot state refuses
  // the run before anything is measured or priced.
  const rungsByArm = arms.map((arm) =>
    arm.strategies.map((strategy) => ({
      strategy,
      calls: rungCalls(strategy, calls, description),
    })),
  );

  // The target the prompts are measured from — the runner's own derivation, so
  // the measured prompts are the prompts the run will send.
  const { target, groups } = buildEvalTarget(
    corpus.schema,
    corpus.manifest.prompt,
    corpus.manifest.name,
    splitCaps,
  );
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
