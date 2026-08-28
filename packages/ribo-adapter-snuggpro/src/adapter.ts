/**
 * The Snugg Pro `ToolAdapter` — the one place Snugg Pro field knowledge lives.
 *
 * Ties together the spike-proven artifacts: the `schema` (the writable patch, and
 * the trust boundary a reviewed submission is parsed through before a write), the
 * derived `extractionSchema` (what the model is constrained to and what its
 * response is parsed with), the `ctxSchema` (what a persisted `Recording.ctx` is
 * parsed into), the `instructions` (the normalization intent the extractor
 * assembles into its prompt), and the optional few-shot `examples`. `write` is the
 * write-back seam, typed with a real Snugg Pro context.
 *
 * Two field schemas, not one, and the second is derived from the first — see
 * `ribo-core`'s `adapter.ts` for why one type parameter could not be both, and
 * `schema.ts` for the Snugg-specific shape of each.
 */

import type { ExistingRecord, RankedCandidate, ToolAdapter, WriteMetadata } from "@azx/ribo-core";
import { snuggCtxSchema, type SnuggWriteContext } from "./context.js";
import { snuggExamples } from "./examples.js";
import { snuggProInstructions } from "./instructions.js";
import { snuggExtractionSchema, snuggValuesSchema, type SnuggValues } from "./schema.js";

/** Stable identifier for this adapter: the bounded Snugg Pro pilot field set. */
export const SNUGGPRO_ADAPTER_NAME = "snuggpro-bounded";

export const snuggProAdapter: ToolAdapter<SnuggValues, SnuggWriteContext> = {
  name: SNUGGPRO_ADAPTER_NAME,
  schema: snuggValuesSchema,
  extractionSchema: snuggExtractionSchema,
  ctxSchema: snuggCtxSchema,

  /**
   * What Snugg Pro refuses to create an HVAC system without — declared per group
   * so the same leaves apply to every emitted instance.
   *
   * `POST /jobs/{jobId}/hvac` is the **only** component endpoint with required
   * capture fields — every other component (attic, wall, window, DHW, health,
   * and the base-data singleton) has none, which is why a partial dictation
   * writes cleanly (doc 17 §"The required-field surface"). It requires exactly
   * two, and both are now extracted.
   *
   * Declared per group rather than as full paths because `hvac` is a collection:
   * a house with N systems has N × 2 required fields, and the instance keys
   * (`hvac[k1]`, `hvac[k2]`, …) are not known until extraction. Core applies this
   * declaration to every instance of the group as it builds the review request.
   *
   * `hvacUpgradeAction` is here rather than hard-coded. Doc 15 ranks it blocking
   * (B2) and recommends a write-layer constant, but that recommendation is
   * superseded: auditors narrate recommendations, so "there's an oil boiler here,
   * we should get rid of it" carries the upgrade action as plainly as it carries
   * the equipment type (doc 17, owner correction of 2026-08-06). A constant would
   * have written a retrofit decision nobody made.
   *
   * Requiredness is a review-card concern, not a write-time one: the auditor is
   * asked while they are still standing in the basement, rather than the write
   * failing at the API hours later.
   */
  requiredOnCreate: {
    hvac: ["hvacSystemEquipmentType", "hvacUpgradeAction"],
  },

  instructions: snuggProInstructions,
  examples: snuggExamples,

  /**
   * Write-back is SCAFFOLDED, not implemented. The real egress lands in Phase 4
   * Task 6 and is gated on Kyle's A1 — the Helix egress layer HMAC-SHA256-signs
   * the request server-side (Snugg Pro uses AWS-style signed requests, not a
   * static key). Faking an unsigned write to green a demo teaches the wrong thing
   * (plan §"Split"), so this rejects rather than resolving. The SIGNATURE is
   * honest now — `(fields, ctx, meta) => Promise<void>`, where `fields` is the
   * PATCH (rejected keys absent, an accepted `null` present and meaning Snugg's
   * `Not Tested`) and `meta.idempotencyKey` is what Task 6 sends as
   * `Idempotency-Key` — so Task 6 is a wiring change, not a redesign.
   */
  write: async (
    _fields: SnuggValues,
    _ctx: SnuggWriteContext,
    _meta: WriteMetadata,
  ): Promise<void> => {
    throw new Error(
      "snuggProAdapter.write is not implemented yet: Snugg Pro egress lands in Phase 4 Task 6, " +
        "gated on A1 (HMAC-SHA256 request signing at the Helix egress layer).",
    );
  },
};

/**
 * Fields that identify an HVAC record well enough for the contradiction check.
 *
 * The auto-link draft used these four; a disagreement on any one of them, when both sides
 * have a captured value, demotes the candidate. Duct leakage, insulation, location and
 * capacities are intentionally excluded — they describe the wrong-record problem the plan
 * documents (furnace identity with AC duct data) and must not be allowed to override it.
 */
export const HVAC_IDENTIFYING_FIELDS = [
  "hvacSystemEquipmentType",
  "hvacHeatingSystemManufacturer",
  "hvacHeatingSystemModel",
  "hvacHeatingSystemModelYear",
] as const;

const IDENTIFYING_FIELDS: Record<string, readonly string[]> = {
  hvac: HVAC_IDENTIFYING_FIELDS,
};

/**
 * Order existing records of a collection group by how strongly they match a dictated instance.
 *
 * A candidate is demoted to the "contradicts" tier if any captured identifying field
 * disagrees with the instance. Within each tier the original order is preserved so the host
 * tool's own ordering (e.g., creation order) survives. The strongest non-contradicting
 * candidate may be pre-highlighted, but it is never linked automatically.
 */
export function rankCandidates(
  group: string,
  instance: Record<string, unknown>,
  existing: readonly ExistingRecord[],
): RankedCandidate[] {
  const identifying = IDENTIFYING_FIELDS[group] ?? [];
  const scored = existing.map((record): RankedCandidate => {
    let contradicts = false;
    for (const field of identifying) {
      const extractedValue = instance[field];
      const existingValue = record.fields[field];
      // A captured identifying field on both sides that disagrees is a veto. Null or
      // undefined on either side is not a disagreement — it is missing information.
      if (
        extractedValue !== null &&
        extractedValue !== undefined &&
        existingValue !== null &&
        existingValue !== undefined &&
        extractedValue !== existingValue
      ) {
        contradicts = true;
        break;
      }
    }
    return { ...record, contradicts };
  });
  return [
    ...scored.filter((candidate) => !candidate.contradicts),
    ...scored.filter((candidate) => candidate.contradicts),
  ];
}

/**
 * Produce an empty reader for existing records.
 *
 * The real read of `GET /jobs/{jobId}/<group>` is host transport code that lives outside the
 * SDK (it needs the session and HMAC signing). This stub is the adapter-side seam: it
 * declares the Snugg Pro shape a host must return, so `rankCandidates` can be tested against
 * injected records without a network call.
 */
export function readExistingRecords(_ctx: SnuggWriteContext, _group: string): ExistingRecord[] {
  return [];
}
