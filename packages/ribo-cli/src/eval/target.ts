/**
 * @file The extraction target the arm runs against: the corpus's schema
 * derived into the wire shape, the manifest's instructions, and the manifest's
 * examples translated into that shape.
 *
 * The derivation is core's own (`describeExtraction`), never a second
 * implementation: the same helper the inspect command reports under, so the
 * runner's call shape and the report's call shape cannot disagree. A schema
 * core's derivation refuses is refused here, before any model call, with
 * core's own message — the one that names the offending path.
 *
 * The target's wire name is a fixed safe constant (`"ribo-eval"`): the
 * corpus's name is free text for reports and records, while the wire name has
 * to satisfy core's `[A-Za-z0-9_-]+` guard.
 */
import { describeExtraction, extractGroups } from "@azx/ribo-core";
import type { ExtractionTarget, Group } from "@azx/ribo-core";
import { z } from "zod";

import type { CorpusPromptInputs } from "../corpus.js";
import { walkFieldInventory } from "../inspect/field-inventory.js";
import { EvalError } from "./error.js";
import { translateExample } from "./example.js";
import type { EvalSplitCaps, EvalStrategyId } from "./types.js";

/** The wire name every arm's calls carry — a constant, never the corpus's name. */
export const EVAL_TARGET_NAME = "ribo-eval";

/**
 * What the arm runs against: the extraction target, the groups the presence
 * phase walks, and the schema's leaf paths.
 */
export interface EvalTargetBundle {
  /** The target: the wire schema, the instructions and the translated examples. */
  readonly target: ExtractionTarget<Record<string, unknown>>;
  /**
   * The walked groups, for the presence-narrowed arm — empty unless the
   * selected strategies include it, because the walk refuses a schema any
   * other strategy can drive (a top-level scalar derives an envelope the
   * walk reads as a plain-leaf group).
   */
  readonly groups: readonly Group[];
  /** The schema's leaf paths, as the one field inventory reports them. */
  readonly leafPaths: ReadonlySet<string>;
}

/**
 * Walk the extraction schema's groups — the same walk the presence phase is
 * handed, over the same JSON Schema rendering core's own strategies use.
 *
 * The refusal names the strategy the operator selected, states the fix in
 * operator terms, and says other strategies can run the schema — the walk's
 * own refusal speaks core's phase vocabulary (`threePhaseExtractor`), which
 * an operator who asked for `--strategy presence-narrowed` has never heard of.
 */
const walkGroups = (extractionSchema: z.ZodType, manifestName: string): readonly Group[] => {
  let document: Record<string, unknown>;
  try {
    document = z.toJSONSchema(extractionSchema, { target: "draft-2020-12" });
  } catch (error) {
    throw new EvalError(
      `eval: the corpus's schema could not be rendered as a JSON Schema document — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return extractGroups(document);
  } catch (error) {
    throw new EvalError(
      `eval: the presence-narrowed strategy you selected cannot run the corpus ` +
        `"${manifestName}" — the presence walk refuses its schema: ` +
        `${error instanceof Error ? error.message : String(error)} (fix: wrap the scalar in an ` +
        "object group, or derive the group at leaf granularity — the single-shot, per-group and " +
        "planned strategies can run this schema as-is)",
    );
  }
};

/** The one strategy that runs the walked groups. */
const needsGroups = (strategies: readonly EvalStrategyId[]): boolean =>
  strategies.includes("presence-narrowed");

/**
 * Build the extraction target from the corpus's schema and the manifest's
 * prompt inputs.
 * @param schema - The corpus's schema, in plain values.
 * @param prompt - The manifest's prompt inputs.
 * @param manifestName - The corpus manifest's name, for the refusal's message.
 * @param splitCaps - The split caps the derivation packs under.
 * @param strategies - The strategies the arm will build; the group walk (and
 *   its refusal) runs only when they include the presence-narrowed strategy.
 *   Absent, no groups are walked — a direct caller that needs them names the
 *   strategies it builds.
 * @returns The target, the walked groups and the schema's leaf paths.
 * @throws {@link EvalError} when the schema cannot be driven, the
 *   presence-narrowed strategy is selected over an unwalkable schema, or an
 *   example names no leaf.
 * @category Eval
 */
export function buildEvalTarget(
  schema: z.ZodObject,
  prompt: CorpusPromptInputs,
  manifestName: string,
  splitCaps: EvalSplitCaps,
  strategies?: readonly EvalStrategyId[],
): EvalTargetBundle {
  const description = describeExtraction({
    schema,
    ...(splitCaps.maxNullableUnionsPerGroup === undefined
      ? {}
      : { maxNullableUnionsPerGroup: splitCaps.maxNullableUnionsPerGroup }),
    ...(splitCaps.maxSerializedCharsPerGroup === undefined
      ? {}
      : { maxSerializedCharsPerGroup: splitCaps.maxSerializedCharsPerGroup }),
  });
  if (description.shape === undefined) {
    throw new EvalError(
      `eval: the corpus "${manifestName}" declares a schema the arm cannot drive — ` +
        `${description.refusal?.message ?? "core's derivation refused it"} (fix: narrow the ` +
        "schema, or drop the offending path)",
    );
  }
  const extractionSchema = description.shape.extractionSchema;

  const leafPaths = new Set(walkFieldInventory(schema).map((entry) => entry.path));
  const examples = (prompt.examples ?? []).map((example) =>
    translateExample(schema, leafPaths, example, manifestName),
  );

  const target: ExtractionTarget<Record<string, unknown>> = {
    name: EVAL_TARGET_NAME,
    extractionSchema,
    instructions: prompt.instructions,
    examples,
  } as unknown as ExtractionTarget<Record<string, unknown>>;

  return {
    target,
    groups:
      strategies !== undefined && needsGroups(strategies)
        ? walkGroups(extractionSchema, manifestName)
        : [],
    leafPaths,
  };
}
