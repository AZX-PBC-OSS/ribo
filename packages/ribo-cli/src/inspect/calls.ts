import { perGroupPlan } from "@azx/ribo-core";
import type {
  ChatClient,
  ChatRequest,
  ExtractionDescription,
  ExtractionTarget,
} from "@azx/ribo-core";

/**
 * The report's per-strategy call counts (design §9). Each count is computed
 * from the symbol the real extraction path itself reads — never from a
 * CLI-side re-derivation — and retries are reported separately
 * (`maxRetriesDefault`), never multiplied into an attempt count.
 */
export interface CallsReport {
  /**
   * `1` when the schema's call shape is `"single-shot"` — the strategy makes
   * one request per attempt — else `null`.
   */
  singleShot: number | null;
  /**
   * The number of entries in the real `perGroupPlan`: one per group's piece
   * (a partitioned group contributes its part count) plus the unwrapped `""`
   * entry when present. `null` when the plan could not be built — with the
   * construction's thrown reason carried in {@link perGroupReason}.
   */
  perGroup: number | null;
  /** The reason `perGroupPlan` construction threw, verbatim, when it did. */
  perGroupReason?: string;
  /**
   * Upper bound, worded as one everywhere: the presence phase plans one item
   * per group, always, and the fill phase makes at most one call per group —
   * `2 × groupCount`. `null` when the schema has no groups (the presence
   * preset refuses a zero-group walk). The common case is cheaper: groups
   * presence found empty cost nothing in the fill.
   */
  presenceNarrowedAtMost: number | null;
  /**
   * One attempt's count per consensus candidate — the call-shape-selected
   * count: 1 single-shot, else the per-group count. The run's total is that
   * count SUMMED over the caller's candidates: choosing candidates IS
   * choosing a multiplier (`consensusExtractor` sums its candidates' usage).
   */
  consensusPerCandidate: number | null;
  /**
   * The phase engine's default retry budget (`2`) beside the stated worst-case
   * rule: a run's attempts multiply by `1 + maxRetries`. Never folded into any
   * attempt count above.
   */
  maxRetriesDefault: number;
}

/**
 * Thrown by the plan-construction stub chat if a call ever reaches it —
 * rethrown, never carried, so a plan that secretly dialled the model fails
 * loudly instead of producing a number (the suite pins this with a real run).
 */
class PlanConstructionChatInvoked extends Error {
  constructor(request: ChatRequest) {
    super(
      `perGroupPlan construction made a chat call it must never make ` +
        `(schema name "${request.responseFormat.json_schema.name}") — the plan is a dry run, ` +
        "and its entry count is read without a model.",
    );
    this.name = "PlanConstructionChatInvoked";
  }
}

/** A chat that must never be called: plan construction reads no model. */
const neverCalledChat = (): ChatClient => ({
  complete: (request: ChatRequest) => {
    throw new PlanConstructionChatInvoked(request);
  },
});

/**
 * The plan's entry count: one per group key (an array entry is a partitioned
 * key — its parts each make a call) plus the unwrapped `""` entry when the
 * schema is mixed or flat (ADR 0023). The same counting
 * `describe-extraction-agreement.test.ts` runs against the real extractor.
 */
const planCallCount = (plan: {
  readonly groups: Record<string, unknown>;
  readonly unwrapped?: unknown;
}): number => {
  let count = 0;
  for (const entry of Object.values(plan.groups)) {
    count += Array.isArray(entry) ? entry.length : 1;
  }
  if (plan.unwrapped !== undefined) {
    count += Array.isArray(plan.unwrapped) ? plan.unwrapped.length : 1;
  }
  return count;
};

/**
 * The split configuration `perGroupPlan` is built under — the same caps the
 * report's split was described under, so the count and the pieces cannot
 * disagree.
 */
export interface SplitCapOptions {
  readonly maxNullableUnionsPerGroup?: number;
  readonly maxSerializedCharsPerGroup?: number;
}

/**
 * Compute the report's per-strategy call counts off the real symbols (design
 * §9): the single-shot count from `describeExtraction`'s own `callShape`
 * classification, the per-group count from a real `perGroupPlan` entry map
 * built with a never-called stub chat and a fixed wire-safe placeholder name,
 * the presence-narrowed upper bound from the presence phase's one-item-per-group
 * plan plus the fill phase's one-call-per-present-group, and the consensus
 * per-candidate count from the call-shape selection.
 */
export function describeCalls(
  description: ExtractionDescription,
  splitCaps: SplitCapOptions,
): CallsReport {
  const groupCount = (description.keys ?? []).filter((key) => key.kind === "group").length;
  const singleShot = description.callShape === "single-shot" ? 1 : null;

  let perGroup: number | null = null;
  let perGroupReason: string | undefined;
  const extractionSchema = description.shape?.extractionSchema;
  if (extractionSchema !== undefined) {
    try {
      const plan = perGroupPlan({
        // The placeholder target: the plan reads the schema, name and
        // instructions off it and builds entries — it never dials. The cast is
        // the erased level the strategies' own implementations use, as in
        // `describe-extraction-agreement.test.ts`'s `targetFor`.
        target: {
          name: "ribo-inspect",
          extractionSchema,
          instructions: "",
          examples: [],
        } as ExtractionTarget<Record<string, unknown>>,
        chat: neverCalledChat(),
        model: "ribo-inspect",
        ...(splitCaps.maxNullableUnionsPerGroup === undefined
          ? {}
          : { maxNullableUnionsPerGroup: splitCaps.maxNullableUnionsPerGroup }),
        ...(splitCaps.maxSerializedCharsPerGroup === undefined
          ? {}
          : { maxSerializedCharsPerGroup: splitCaps.maxSerializedCharsPerGroup }),
      });
      perGroup = planCallCount(plan);
    } catch (error) {
      // The stub's own error is a construction bug, not a schema fact —
      // rethrow so it fails loudly; everything else is the plan's real
      // refusal (a wire-unsafe group key, a split that cannot fit a piece),
      // carried verbatim like `describeExtraction`'s refusals.
      if (error instanceof PlanConstructionChatInvoked) throw error;
      perGroup = null;
      perGroupReason = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    singleShot,
    perGroup,
    ...(perGroupReason === undefined ? {} : { perGroupReason }),
    presenceNarrowedAtMost: groupCount > 0 ? 2 * groupCount : null,
    consensusPerCandidate: description.callShape === "single-shot" ? 1 : perGroup,
    maxRetriesDefault: 2,
  };
}
