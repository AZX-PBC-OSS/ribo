/**
 * @file How big the prompts a run will send are — measured, not guessed.
 *
 * The spend guard prices a run on what the run will actually send, so the
 * per-call token bound is measured from the messages the strategies really
 * build: core's own `buildMessages` and `buildGroupMessages`, over the run's
 * real target, its real instructions and its real examples, and the longest
 * transcript the corpus holds.
 *
 * The bound is an UPPER bound, and it is built that way on purpose:
 *
 * - the ordinary per-group calls are measured over the WHOLE group, while the
 *   real call is pinned to a projected group or a partitioned piece — a
 *   narrowing, so the whole group is the larger measurement;
 * - planned calls are measured over core's actual projected dry-run targets,
 *   including each target's own semantic instructions and wire schema;
 * - the ordinary group-shaped wire measurement uses the WHOLE extraction
 *   schema, again the larger one;
 * - the transcript is the corpus's longest, while a case carries its own.
 *
 * ONE prompt is not core's to give: the presence phase's two-message shape is
 * built by a module-private builder (`buildPresenceMessages`, in
 * `packages/ribo-core/src/phases/presence-phase.ts`), so it is mirrored here.
 * The mirror is small and fixed, and it is the one place where core's wording
 * and this package's measurement could drift — the call COUNTS, which is where
 * the guard's teeth are, are read from `describeCalls` and cannot drift. If
 * the mirror proves fragile, exporting the builder from core is a separate
 * decision, not this file's.
 */
import { buildGroupMessages, buildMessages, toJsonSchemaForWire } from "@azx/ribo-core";
import type { ChatMessage, ExtractionTarget, FieldDescriptionsMode, Group } from "@azx/ribo-core";

import { EvalError } from "./error.js";
import type { EvalStrategyId } from "./types.js";

/**
 * What the measurement needs: the target the run drives, the groups the
 * presence phase walks, the prompt's own options, and the longest transcript
 * the corpus holds.
 */
export interface PromptSizeInput {
  /** The extraction target every call is built from. */
  readonly target: ExtractionTarget<Record<string, unknown>>;
  /** The walked groups, for the group-shaped calls. */
  readonly groups: readonly Group[];
  /** Where the field descriptions travel, as the manifest declares. */
  readonly fieldDescriptions?: FieldDescriptionsMode;
  /** The per-group instructions, as core's hook takes them. */
  readonly groupInstructions?: (groupKey: string) => string;
  /** The longest transcript the corpus holds. */
  readonly transcript: string;
  /** Core's actual packed planned targets, when a rung is planned. */
  readonly plannedTargets?: readonly ExtractionTarget<Record<string, unknown>>[];
}

/**
 * The presence phase's two messages, mirrored from core's private
 * `buildPresenceMessages` (`packages/ribo-core/src/phases/presence-phase.ts`).
 *
 * The wording is copied verbatim, so the measurement matches the prompt the
 * phase really sends; the file header names the source of truth.
 */
const buildPresenceMessages = (group: Group, transcript: string): ChatMessage[] => [
  {
    role: "system",
    content:
      `For the ${group.key} group, determine which of the following fields are discussed in the auditor's spoken field notes.\n\n` +
      `Return a single JSON object with exactly these keys: ${group.leaves.map((leaf) => leaf.key).join(", ")}. ` +
      `Each value must be a boolean: true if the transcript explicitly discusses the field, ` +
      `false if it is not mentioned, only implied, or unrelated. ` +
      `A field merely implied is false. No extra keys, no commentary, no markdown fences.`,
  },
  { role: "user", content: transcript },
];

/**
 * The characters a message list carries.
 *
 * Each message's content is counted, plus a small constant per message for
 * the role and the framing the wire adds — a few characters per call, which
 * the token conversion dwarfs anyway.
 */
const charsOf = (messages: readonly ChatMessage[]): number =>
  messages.reduce((total, message) => total + message.content.length + 8, 0);

/**
 * The characters of the wire schema every call carries.
 *
 * The whole extraction schema is measured, while a group-shaped call carries
 * its own group's schema: the whole is the larger measurement, and the guard
 * prices the larger one.
 */
const targetWireChars = (
  target: ExtractionTarget<Record<string, unknown>>,
  fieldDescriptions: FieldDescriptionsMode | undefined,
): number => {
  const rendered = toJsonSchemaForWire(target.extractionSchema, {
    keepDescriptions: fieldDescriptions !== "prompt",
  });
  return JSON.stringify(rendered).length;
};

const wireChars = (input: PromptSizeInput): number =>
  targetWireChars(input.target, input.fieldDescriptions);

/**
 * The characters of the group-shaped calls' messages: the per-group builder,
 * over every group, keeping the largest.
 *
 * The group instructions are core's hook, exactly as the runner passes them,
 * so a group with its own instructions is measured with them.
 */
const groupMessageChars = (input: PromptSizeInput): number => {
  let largest = 0;
  for (const group of input.groups) {
    const messages = buildGroupMessages(
      input.target,
      group.key,
      input.transcript,
      input.groupInstructions,
      undefined,
      undefined,
      input.fieldDescriptions === undefined
        ? undefined
        : { fieldDescriptions: input.fieldDescriptions },
    );
    largest = Math.max(largest, charsOf(messages));
  }
  return largest;
};

/**
 * The characters of the presence phase's messages: the mirrored two-message
 * shape, over every group, keeping the largest.
 */
const presenceMessageChars = (input: PromptSizeInput): number => {
  let largest = 0;
  for (const group of input.groups) {
    largest = Math.max(largest, charsOf(buildPresenceMessages(group, input.transcript)));
  }
  return largest;
};

/** The largest actual planned request, with messages and wire schema kept as one target. */
const plannedPromptChars = (input: PromptSizeInput): number => {
  if (input.plannedTargets === undefined) {
    throw new EvalError(
      "the planned strategy has no dry-run targets for prompt measurement " +
        "(fix: supply the reviewed plan used by the run)",
    );
  }
  let largest = 0;
  for (const target of input.plannedTargets) {
    const messages = buildMessages(
      target,
      input.transcript,
      input.fieldDescriptions === undefined
        ? undefined
        : { fieldDescriptions: input.fieldDescriptions },
    );
    largest = Math.max(
      largest,
      charsOf(messages) + targetWireChars(target, input.fieldDescriptions),
    );
  }
  return largest;
};

/**
 * Measure the largest prompt a run over these strategies would send.
 *
 * The measurement is per STRATEGY: a run that never asks a presence question
 * is not charged for one. The result is the largest of the strategies' own
 * measurements — the per-call bound every call of the run is under.
 * @param input - The target, the groups, the prompt options and the transcript.
 * @param strategies - The strategies the run's arms may use.
 * @returns The measured characters, over the prompt and the wire schema.
 */
export function measurePromptChars(
  input: PromptSizeInput,
  strategies: readonly EvalStrategyId[],
): number {
  let largest = 0;
  for (const strategy of strategies) {
    if (strategy === "single-shot") {
      const messages = buildMessages(
        input.target,
        input.transcript,
        input.fieldDescriptions === undefined
          ? undefined
          : { fieldDescriptions: input.fieldDescriptions },
      );
      largest = Math.max(largest, charsOf(messages) + wireChars(input));
      continue;
    }
    if (strategy === "per-group") {
      largest = Math.max(largest, groupMessageChars(input) + wireChars(input));
      continue;
    }
    if (strategy === "planned") {
      largest = Math.max(largest, plannedPromptChars(input));
      continue;
    }
    // The presence-narrowed arm makes both kinds of call: the presence phase's
    // own question, and the fill's group-shaped extraction.
    largest = Math.max(
      largest,
      Math.max(presenceMessageChars(input), groupMessageChars(input)) + wireChars(input),
    );
  }
  return largest;
}
