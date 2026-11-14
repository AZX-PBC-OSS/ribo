/**
 * @file One strategy, one extractor: the three rungs an arm's ladder is built
 * from.
 *
 * Each rung is core's own constructor — `singleShotExtractor`,
 * `perGroupExtractor`, and the presence-narrowed arm hand-assembled through
 * `phasedExtractor` over `presencePhase` and `presenceFillPhase`, so the
 * settings' retry budget reaches it. Nothing here re-implements a strategy;
 * the runner only wires the options the settings carry.
 *
 * The group instructions are core's hook: a function of the group key, not a
 * map. The runner adapts the manifest's map onto it, and a group with no
 * entry falls back to the main instructions — which is also what makes every
 * group-shaped call project its examples to its own group.
 */
import {
  perGroupExtractor,
  phasedExtractor,
  presenceFillPhase,
  presencePhase,
  singleShotExtractor,
} from "@azx/ribo-core";
import type {
  CapableChatClient,
  Enveloped,
  Extractor,
  ExtractionTarget,
  FieldDescriptionsMode,
  Group,
  NoProvenance,
} from "@azx/ribo-core";

import type { EvalSettings, EvalStrategyId } from "./types.js";

/**
 * What one strategy needs to be built: the target, the walked groups, the
 * transport, and the settings' options.
 */
export interface EvalStrategyContext {
  /** The extraction target every strategy runs against. */
  readonly target: ExtractionTarget<Record<string, unknown>>;
  /** The walked groups, for the presence-narrowed arm. */
  readonly groups: readonly Group[];
  /** The capable transport. */
  readonly chat: CapableChatClient;
  /** The model id the calls carry. */
  readonly model: string;
  /** The arm's settings. */
  readonly settings: EvalSettings;
  /** The per-group instructions, as core's hook takes them. */
  readonly groupInstructions?: (groupKey: string) => string;
  /** Where the field descriptions travel, as the manifest declares. */
  readonly fieldDescriptions?: FieldDescriptionsMode;
  /** The injectable sleep between retry attempts. */
  readonly delay?: (ms: number) => Promise<void>;
}

/**
 * Build one rung of the ladder.
 *
 * An absent option is not forwarded: the strategies' own defaults apply, and
 * the runner invents no numbers of its own.
 * @param id - The strategy to build.
 * @param context - The target, the transport and the settings.
 * @returns The strategy's extractor.
 * @category Eval
 */
export function buildStrategy(
  id: EvalStrategyId,
  context: EvalStrategyContext,
): Extractor<Enveloped<Record<string, unknown>, NoProvenance>> {
  const { settings } = context;
  const maxTokens = settings.responseCap === undefined ? {} : { maxTokens: settings.responseCap };
  const guidance =
    context.fieldDescriptions === undefined ? {} : { fieldDescriptions: context.fieldDescriptions };

  if (id === "single-shot") {
    return singleShotExtractor({
      target: context.target,
      chat: context.chat,
      model: context.model,
      ...maxTokens,
      ...guidance,
    });
  }

  if (id === "per-group") {
    return perGroupExtractor({
      target: context.target,
      chat: context.chat,
      model: context.model,
      ...maxTokens,
      ...(settings.maxRetries === undefined ? {} : { maxRetries: settings.maxRetries }),
      ...(context.groupInstructions === undefined
        ? {}
        : { groupInstructions: context.groupInstructions }),
      ...(settings.splitCaps?.maxNullableUnionsPerGroup === undefined
        ? {}
        : { maxNullableUnionsPerGroup: settings.splitCaps.maxNullableUnionsPerGroup }),
      ...(settings.splitCaps?.maxSerializedCharsPerGroup === undefined
        ? {}
        : { maxSerializedCharsPerGroup: settings.splitCaps.maxSerializedCharsPerGroup }),
      ...guidance,
      ...(context.delay === undefined ? {} : { delay: context.delay }),
    });
  }

  return phasedExtractor({
    target: context.target,
    phases: [
      presencePhase({ groups: context.groups, chat: context.chat, model: context.model }),
      presenceFillPhase({
        target: context.target,
        groups: context.groups,
        chat: context.chat,
        model: context.model,
        ...maxTokens,
        ...(context.groupInstructions === undefined
          ? {}
          : { groupInstructions: context.groupInstructions }),
        ...(settings.splitCaps?.maxNullableUnionsPerGroup === undefined
          ? {}
          : { maxNullableUnionsPerGroup: settings.splitCaps.maxNullableUnionsPerGroup }),
        ...(settings.splitCaps?.maxSerializedCharsPerGroup === undefined
          ? {}
          : { maxSerializedCharsPerGroup: settings.splitCaps.maxSerializedCharsPerGroup }),
      }),
    ],
    ...(settings.maxRetries === undefined ? {} : { maxRetries: settings.maxRetries }),
    ...(context.delay === undefined ? {} : { delay: context.delay }),
  });
}
