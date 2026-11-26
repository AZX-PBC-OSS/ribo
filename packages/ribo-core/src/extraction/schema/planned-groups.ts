/**
 * @file Compile semantic schema-plan pieces through the existing per-group plan and cap packers.
 * Internal until the planned extractor wires scheduling and merging.
 */

import { z } from "zod";

import type { GroupMap } from "../grouped-extractor.js";
import type { NoProvenance } from "../../provenance/enveloped.js";
import type { ExtractionTarget } from "../extractor.js";
import { walkFieldInventory } from "../field-inventory.js";
import type { SchemaPlan } from "../schema-plan.js";
import { perGroupPlan } from "../strategies/per-group.js";
import type { GroupTargets, PerGroupOptions } from "../strategies/per-group.js";

import { projectPlannedTargets } from "./planned-projection.js";
import {
  MAX_NULLABLE_UNIONS_PER_CALL,
  partitionLabelLine,
  splitExtractionSchema,
} from "./split-schema.js";

/** Construction inputs for the internal planned-group compiler. */
export type PlannedGroupsOptions<V extends Record<string, unknown>, P = NoProvenance> = Omit<
  PerGroupOptions<V, P>,
  "groupInstructions" | "partitions" | "singleton"
> & {
  readonly plan: SchemaPlan;
};

/** Existing grouped-extractor entries and their targets, concatenated in semantic plan order. */
export interface PlannedGroups<V extends Record<string, unknown>, P = NoProvenance> {
  readonly groups: GroupMap<V, P>;
  readonly targets: GroupTargets<V, P>;
}

const asList = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? (value as readonly unknown[]) : [value];

const semanticName = (targetName: string, pieceName: string, pieceIndex: number): string => {
  const slug = pieceName.replace(/[^A-Za-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `${targetName}-${pieceIndex}-${slug === "" ? "piece" : slug}`;
};

const underKey = (path: string, key: string): boolean => path === key || path.startsWith(`${key}.`);

/**
 * Compile each semantic piece independently, then concatenate pieces sharing a top-level key.
 * Construction is pure with respect to chat: entries are built, never extracted.
 */
export function compilePlannedGroups<V extends Record<string, unknown>, P = NoProvenance>(
  options: PlannedGroupsOptions<V, P>,
): PlannedGroups<V, P> {
  const {
    target,
    plan,
    chat,
    model,
    maxTokens,
    maxNullableUnionsPerGroup,
    maxSerializedCharsPerGroup,
    fieldDescriptions,
  } = options;
  if (!(target.extractionSchema instanceof z.ZodObject)) {
    throw new Error("compilePlannedGroups: the target extractionSchema must be a ZodObject.");
  }

  const originalPaths = walkFieldInventory(target.extractionSchema).map((entry) => entry.path);
  const projections = projectPlannedTargets(target, plan);
  const groups: Record<string, unknown[]> = {};
  const targets: Record<string, unknown[]> = {};

  for (const [pieceIndex, projection] of projections.entries()) {
    const { piece } = projection;
    const semanticTarget = {
      ...projection.target,
      name: semanticName(target.name, piece.name, pieceIndex),
    } as ExtractionTarget<V, P>;
    const splitOptions = {
      maxNullableUnionsPerGroup: maxNullableUnionsPerGroup ?? MAX_NULLABLE_UNIONS_PER_CALL,
      ...(maxSerializedCharsPerGroup === undefined ? {} : { maxSerializedCharsPerGroup }),
    };

    // Read the same packing that perGroupPlan derives so its instruction callback can name every
    // field outside the individual packed call, including fields from other semantic pieces.
    const packed = splitExtractionSchema(semanticTarget.extractionSchema, splitOptions);
    const elsewhereByCall = packed.map((entry) => {
      if (!(entry.schema instanceof z.ZodObject)) {
        throw new Error("compilePlannedGroups: a packed extraction schema must be a ZodObject.");
      }
      const own = new Set(walkFieldInventory(entry.schema).map((field) => field.path));
      return originalPaths.filter((path) => underKey(path, piece.key) && !own.has(path));
    });
    let callIndex = 0;
    const compiled = perGroupPlan({
      target: semanticTarget,
      chat,
      model,
      maxTokens,
      maxNullableUnionsPerGroup,
      maxSerializedCharsPerGroup,
      fieldDescriptions,
      groupInstructions: (key) => {
        const elsewhere = elsewhereByCall[callIndex];
        if (elsewhere === undefined) {
          throw new Error(
            `compilePlannedGroups: no packed layout for semantic piece "${piece.name}".`,
          );
        }
        callIndex += 1;
        return (
          `${target.instructions}\n\n${piece.description}\n\n` +
          partitionLabelLine(key, piece.name, elsewhere)
        );
      },
    });

    const namedGroups = compiled.groups as Readonly<Record<string, unknown>>;
    const namedTargets = compiled.targets as Readonly<Record<string, unknown>>;
    const entry = namedGroups[piece.key] ?? compiled.unwrapped;
    const pieceTargets = namedTargets[piece.key] ?? compiled.unwrappedTarget;
    if (entry === undefined || pieceTargets === undefined) {
      throw new Error(
        `compilePlannedGroups: semantic piece "${piece.name}" produced no grouped entry.`,
      );
    }
    groups[piece.key] = [...(groups[piece.key] ?? []), ...asList(entry)];
    targets[piece.key] = [...(targets[piece.key] ?? []), ...asList(pieceTargets)];
  }

  return {
    groups: groups as unknown as GroupMap<V, P>,
    targets: targets as unknown as GroupTargets<V, P>,
  };
}
