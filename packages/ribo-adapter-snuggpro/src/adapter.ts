/**
 * The Snugg Pro `ToolAdapter` — the one place Snugg Pro field knowledge lives.
 *
 * Ties together the spike-proven artifacts: the `schema` (the trust boundary that
 * parses extractor output into `SnuggFields`), the `instructions` (the
 * normalization intent the extractor assembles into its prompt), and the optional
 * few-shot `examples`. `write` is the write-back seam, typed with a real Snugg Pro
 * context.
 */

import type { ToolAdapter } from "@azx/ribo-core";
import type { SnuggWriteContext } from "./context.js";
import { snuggExamples } from "./examples.js";
import { snuggProInstructions } from "./instructions.js";
import { SnuggFieldsSchema, type SnuggFields } from "./schema.js";

/** Stable identifier for this adapter: the bounded Snugg Pro pilot field set. */
export const SNUGGPRO_ADAPTER_NAME = "snuggpro-bounded";

export const snuggProAdapter: ToolAdapter<SnuggFields, SnuggWriteContext> = {
  name: SNUGGPRO_ADAPTER_NAME,
  schema: SnuggFieldsSchema,
  instructions: snuggProInstructions,
  examples: snuggExamples,

  /**
   * Write-back is SCAFFOLDED, not implemented. The real egress lands in Phase 4
   * Task 6 and is gated on Kyle's A1 — the Helix egress layer HMAC-SHA256-signs
   * the request server-side (Snugg Pro uses AWS-style signed requests, not a
   * static key). Faking an unsigned write to green a demo teaches the wrong thing
   * (plan §"Split"), so this rejects rather than resolving. The SIGNATURE is
   * honest now — `(fields, ctx) => Promise<void>` — so Task 6 is a wiring change,
   * not a redesign.
   */
  write: async (_fields: SnuggFields, _ctx: SnuggWriteContext): Promise<void> => {
    throw new Error(
      "snuggProAdapter.write is not implemented yet: Snugg Pro egress lands in Phase 4 Task 6, " +
        "gated on A1 (HMAC-SHA256 request signing at the Helix egress layer).",
    );
  },
};
