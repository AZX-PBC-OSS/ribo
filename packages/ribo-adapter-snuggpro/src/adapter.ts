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

import type { ToolAdapter, WriteMetadata } from "@azx/ribo-core";
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
   * What Snugg Pro refuses to create an HVAC system without.
   *
   * `POST /jobs/{jobId}/hvac` is the **only** component endpoint with required
   * capture fields — every other component (attic, wall, window, DHW, health,
   * and the base-data singleton) has none, which is why a partial dictation
   * writes cleanly (doc 17 §"The required-field surface").
   *
   * That endpoint requires two: `hvacSystemEquipmentType`, which is this leaf,
   * and `hvacUpgradeAction`, which **we do not extract yet**. The second joins
   * this list the moment it exists in `snuggValuesSchema` — doc 15 ranks it
   * blocking (B2) and recommends hard-coding a constant, but that recommendation
   * is superseded: auditors narrate recommendations, so "there's an oil boiler
   * here, we should get rid of it" carries the upgrade action as plainly as it
   * carries the equipment type (doc 17, correction of 2026-08-06).
   */
  requiredOnCreate: ["heatingEquipmentType"],

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
