import { perGroupPlan } from "@azx/ribo-core";
import type {
  ChatClient,
  ChatRequest,
  ExtractionDescription,
  ExtractionTarget,
  SingleShotExclusion,
} from "@azx/ribo-core";

/**
 * The report's per-strategy call counts (design §9). Each count is computed
 * from the symbol the real extraction path itself reads — never from a
 * CLI-side re-derivation — and retries are reported separately
 * (`maxRetriesDefault`), never multiplied into an attempt count.
 *
 * Every nullable count carries a reason beside it, present exactly when the
 * count is `null`: a null count without its reason is an unreadable dead end
 * (the trial agent's "unavailable" with twenty unions against a cap of
 * sixteen), and a non-null count has nothing to explain. The reasons are
 * rendered from the report core's own description carries — the CLI states
 * no rule core did not report.
 */
export interface CallsReport {
  /**
   * `1` when the schema's call shape is `"single-shot"` — the strategy makes
   * one request per attempt — else `null`.
   */
  singleShot: number | null;
  /**
   * Why single-shot is not selected, present exactly when {@link singleShot}
   * is `null`: core's own exclusions (union cap, byte cap, forced partitions),
   * rendered with their measured values and limits — or, when the derivation
   * refused before any shape was selected, that fact.
   */
  singleShotReason?: string;
  /**
   * The number of entries in the real `perGroupPlan`: one per group's piece
   * (a partitioned group contributes its part count) plus the unwrapped `""`
   * entry when present. `null` when the plan could not be built — with the
   * construction's thrown reason carried in {@link perGroupReason}.
   */
  perGroup: number | null;
  /**
   * Why the per-group count is unavailable, present exactly when
   * {@link perGroup} is `null`: the plan's construction throw verbatim, or —
   * when nothing threw but no schema survived to build a plan from — the
   * derivation refusal that stood in its way.
   */
  perGroupReason?: string;
  /**
   * Upper bound, worded as one everywhere: the presence phase plans one item
   * per group, always, and the fill phase makes at most one call per piece of
   * every group's narrowed schema — the same split caps `perGroupPlan` packs
   * against, so the all-present worst case's piece count is the split's own
   * grouped-piece count (the unwrapped `""` pieces excluded: the fill only
   * walks groups). `groupCount` presence calls plus that many fill calls.
   * `null` when the bound cannot be derived: the schema has no groups (the
   * presence preset refuses a zero-group walk), or construction over the same
   * schema and caps refuses (a derive-, name- or split-stage refusal — the
   * fill would throw where `perGroupPlan` does). The common case is cheaper:
   * groups presence found empty cost nothing in the fill, and narrowing runs
   * before the split, so a group with few present leaves is never partitioned.
   */
  presenceNarrowedAtMost: number | null;
  /**
   * Why the presence-narrowed bound is unavailable, present exactly when
   * {@link presenceNarrowedAtMost} is `null`: the derivation's refusal, the
   * zero-group walk, or the split failure the fill would hit.
   */
  presenceNarrowedReason?: string;
  /**
   * One attempt's count per consensus candidate — the call-shape-selected
   * count: 1 single-shot, else the per-group count. The run's total is that
   * count SUMMED over the caller's candidates: choosing candidates IS
   * choosing a multiplier (`consensusExtractor` sums its candidates' usage).
   */
  consensusPerCandidate: number | null;
  /**
   * Why the consensus count is unavailable, present exactly when
   * {@link consensusPerCandidate} is `null`: the consensus count IS the
   * call-shape-selected per-group count, so it is unavailable exactly when
   * the per-group count is, for the same reason.
   */
  consensusReason?: string;
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

/**
 * The phase engine's default retry budget: a run's attempts multiply by
 * `1 + maxRetries`. The estimate, the flag help and the docs prose all read
 * this one value, so the stated default cannot drift from the applied one.
 */
export const MAX_RETRIES_DEFAULT = 2;

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
 * Core's exclusions rendered as one operator-readable sentence. Each cap
 * reason names the flag that sets that cap, so the reader knows which knob
 * to turn; the measured value and the limit are core's own numbers, never a
 * CLI-side re-derivation.
 */
const singleShotReasonOf = (exclusions: readonly SingleShotExclusion[]): string => {
  const parts = exclusions.map((exclusion) => {
    if (exclusion.kind === "union-cap") {
      return (
        `the whole schema carries ${exclusion.measured} nullable unions, over the cap of ` +
        `${exclusion.cap} (--max-nullable-unions-per-group)`
      );
    }
    if (exclusion.kind === "byte-cap") {
      return (
        `the whole schema serializes to ${exclusion.measured} characters, over the cap of ` +
        `${exclusion.cap} (--max-serialized-chars-per-group)`
      );
    }
    return "the schema's partitions force the per-group split";
  });
  return `single-shot was excluded: ${parts.join("; ")}`;
};

/**
 * Compute the report's per-strategy call counts off the real symbols (design
 * §9): the single-shot count from `describeExtraction`'s own `callShape`
 * classification, the per-group count from a real `perGroupPlan` entry map
 * built with a never-called stub chat and a fixed wire-safe placeholder name,
 * the presence-narrowed upper bound from the presence phase's one-item-per-group
 * plan plus the fill phase's per-piece cap partition (the split's own grouped
 * pieces, all-present worst case), and the consensus
 * per-candidate count from the call-shape selection.
 */
export function describeCalls(
  description: ExtractionDescription,
  splitCaps: SplitCapOptions,
): CallsReport {
  const groupCount = (description.keys ?? []).filter((key) => key.kind === "group").length;
  const singleShot = description.callShape === "single-shot" ? 1 : null;
  const singleShotReason =
    singleShot === null
      ? description.singleShotExclusions === undefined
        ? // No shape survived to select: the derivation refused the schema.
          "the derivation refused the schema, so no call shape was selected"
        : singleShotReasonOf(description.singleShotExclusions)
      : undefined;

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
  } else {
    // No schema survived to build a plan from: the derivation refused before
    // any construction could throw. A stated reason, never a bare null.
    perGroupReason = "the derivation refused the schema, so the per-group plan could not be built";
  }

  // The presence-narrowed bound: groupCount presence calls plus the fill's
  // worst-case piece count. The worst case is every leaf of every group
  // present, where each group's narrowed schema is the whole group — so the
  // fill's pieces per group are exactly the split's own grouped pieces, read
  // off the description rather than re-split. A single-shot schema fits whole,
  // so every group is one piece. A refusal means the fill would throw where
  // perGroupPlan does: no bound to report.
  const fillPieceCount =
    description.refusal !== undefined
      ? null
      : description.callShape === "single-shot"
        ? groupCount
        : (description.pieces ?? []).filter((piece) => piece.key !== "").length;

  const presenceNarrowedAtMost =
    groupCount > 0 && fillPieceCount !== null ? groupCount + fillPieceCount : null;
  // The reason pairs: present exactly when their count is null — the report
  // schema refines this, so the writer cannot ship a bare null.
  const presenceNarrowedReason =
    presenceNarrowedAtMost === null
      ? description.refusal !== undefined
        ? `core's derivation refused the schema: ${description.refusal.message}`
        : groupCount === 0
          ? "the schema declares no groups, so the presence phase has nothing to ask about"
          : (perGroupReason ?? "the fill's split could not be derived over this schema")
      : undefined;
  const consensusPerCandidate = description.callShape === "single-shot" ? 1 : perGroup;
  const consensusReason =
    consensusPerCandidate === null
      ? (perGroupReason ?? "the per-group plan could not be built over this schema")
      : undefined;

  return {
    singleShot,
    ...(singleShotReason === undefined ? {} : { singleShotReason }),
    perGroup,
    ...(perGroupReason === undefined ? {} : { perGroupReason }),
    presenceNarrowedAtMost,
    ...(presenceNarrowedReason === undefined ? {} : { presenceNarrowedReason }),
    consensusPerCandidate,
    ...(consensusReason === undefined ? {} : { consensusReason }),
    maxRetriesDefault: MAX_RETRIES_DEFAULT,
  };
}
