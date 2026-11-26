/**
 * @file Execute a reviewed static schema plan through core's existing grouped engine. The plan is
 * data supplied by the host: no production model interprets or revises it, and no CLI or Node API
 * enters this path. ADR 0043 records the core-owned partition and planned-only merge.
 */

import type { Enveloped, NoProvenance } from "../../provenance/enveloped.js";
import type { Extractor } from "../extractor.js";
import { groupedExtractor } from "../grouped-extractor.js";
import { createPlannedMerge } from "../planned-merge.js";
import { compilePlannedGroups } from "../schema/planned-groups.js";
import type { PlannedGroups, PlannedGroupsOptions } from "../schema/planned-groups.js";

/**
 * Construction inputs for {@link plannedPerGroupPlan} and {@link plannedExtractor}: the ordinary
 * target, a parsed reviewed plan, injected chat and model, and the existing per-group packing,
 * guidance, timing, retry, observer and normalization options. Semantic instructions come from the
 * plan, so the free-form group-instruction and shape-partition overrides are deliberately absent.
 * @category Extraction
 */
export type PlannedExtractorOptions<
  V extends Record<string, unknown>,
  P = NoProvenance,
> = PlannedGroupsOptions<V, P>;

/**
 * The static compiled plan: named grouped entries and their projected targets, index-aligned in
 * reviewed semantic-piece order after the existing union/byte packers run. No chat call has happened.
 * @category Extraction
 */
export type PlannedPerGroupPlan<
  V extends Record<string, unknown>,
  P = NoProvenance,
> = PlannedGroups<V, P>;

/**
 * Compile a reviewed schema plan into the existing grouped entries and projected targets. This is a
 * pure dry run over the schema and plan; it neither schedules work nor calls the supplied chat.
 * @category Extraction
 */
export function plannedPerGroupPlan<V extends Record<string, unknown>, P = NoProvenance>(
  options: PlannedExtractorOptions<V, P>,
): PlannedPerGroupPlan<V, P> {
  return compilePlannedGroups(options);
}

/**
 * Execute a reviewed schema plan with the grouped engine's scheduling, retries, cancellation, usage,
 * normalization and closing full-schema parse. Only same-key merging changes: a schema-bound merger
 * recombines nested branches while keeping envelopes and citations atomic (ADR 0043).
 * @category Extraction
 */
export function plannedExtractor<V extends Record<string, unknown>, P = NoProvenance>(
  options: PlannedExtractorOptions<V, P>,
): Extractor<Enveloped<V, P>> {
  const compiled = plannedPerGroupPlan(options);
  return groupedExtractor({
    target: options.target,
    groups: compiled.groups,
    mergeSameKey: createPlannedMerge(options.target.extractionSchema),
    normalize: options.normalize,
    concurrency: options.concurrency,
    maxRetries: options.maxRetries,
    stepTimeoutMs: options.stepTimeoutMs,
    perCallCeilingMs: options.perCallCeilingMs,
    delay: options.delay,
    baseMs: options.baseMs,
    capMs: options.capMs,
    random: options.random,
    onUnit: options.onUnit,
    onRetryBudget: options.onRetryBudget,
    requireRetryBudget: options.requireRetryBudget,
  });
}
