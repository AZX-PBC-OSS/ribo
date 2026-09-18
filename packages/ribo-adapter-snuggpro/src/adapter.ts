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

import type { ExistingRecord, InstanceFacts, RankedCandidate, ToolAdapter, WriteMetadata } from "@azx/ribo-core";
import { contradictionMatcher } from "@azx/ribo-core";
import { snuggCtxSchema, type SnuggWriteContext } from "./context.js";
import { snuggExamples } from "./examples.js";
import { snuggProInstructions } from "./instructions.js";
import { snuggExtractionSchema, snuggValuesSchema, type SnuggValues } from "./schema.js";

/** Stable identifier for this adapter: the bounded Snugg Pro pilot field set. */
export const SNUGGPRO_ADAPTER_NAME = "snuggpro-bounded";

/**
 * Fields that identify an HVAC record well enough for the sameness judgement.
 *
 * The auto-link draft used these four; a disagreement on any one of them, when both sides
 * have a captured value, is a veto. Duct leakage, insulation, location and capacities are
 * intentionally excluded — they describe the wrong-record problem the plan documents
 * (furnace identity with AC duct data) and must not be allowed to override it.
 */
export const HVAC_IDENTIFYING_FIELDS = [
  "hvacSystemEquipmentType",
  "hvacHeatingSystemManufacturer",
  "hvacHeatingSystemModel",
  "hvacHeatingSystemModelYear",
] as const;

export const snuggProAdapter: ToolAdapter<SnuggValues, SnuggWriteContext> = {
  name: SNUGGPRO_ADAPTER_NAME,
  schema: snuggValuesSchema,
  extractionSchema: snuggExtractionSchema,
  ctxSchema: snuggCtxSchema,

  /**
   * What Snugg Pro refuses a CREATE without — declared per group so the same
   * leaves apply to every emitted instance of a collection, and to the singleton
   * groups directly.
   *
   * `POST /jobs/{jobId}/hvac` is the **only** component endpoint with required
   * capture fields — every other component endpoint (attic, wall, window, DHW,
   * health, concern) has none, which is why a partial dictation of a component
   * writes cleanly (doc 17 §"The required-field surface", doc 20 §5.7). It
   * requires exactly two, and both are now extracted.
   *
   * `POST /jobs` is the exception among the singletons: creating the job itself
   * genuinely requires the customer's name and address, the state, zip, and the
   * assignee, stage, job-type and program references (doc 20 §4.6 — "a job
   * cannot be created from dictation alone", because the reference fields need
   * their name→id resolution first). Every one of those required fields that is
   * in the capture surface is declared here; the two required fields NOT here
   * are the ones doc 20 excludes from capture entirely (`fromTemplateId` is not
   * required, and `companyId` — the tenancy fk fixed per credential — is).
   * `PUT /jobs/{jobId}` requires nothing, so the update twin adds no leaves.
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
    job: [
      "firstName",
      "lastName",
      "address1",
      "city",
      "state",
      "zip",
      "accountId",
      "stageId",
      "jobType",
      "programId",
    ],
  },

  /**
   * What makes two HVAC descriptions certainly DIFFERENT real-world things — the
   * fields the sameness judgement may veto on, declared per group exactly like
   * `requiredOnCreate` beside it (a collection group has N instances and the same
   * leaves identify every one). Consumed through core's `contradictionMatcher` by
   * `rankCandidates` below.
   *
   * Only `hvac` declares fields: it is the only collection group in the pilot whose
   * records a dictation can plausibly duplicate (a house has several systems, often
   * the same model). The singleton groups describe the one job itself, where the
   * "another instance of the same thing" question cannot arise.
   *
   * The declaration names only what can make two records certainly different. It
   * deliberately cannot make them the same — agreement on all four fields is not
   * identity (an upstairs and a downstairs unit of the same model year agree on every
   * one), so the matcher below refuses to judge instead of merging. Saying "same" is
   * host judgement, and no host has asked for it.
   */
  identifyingFields: {
    hvac: HVAC_IDENTIFYING_FIELDS,
  },

  instructions: snuggProInstructions,
  examples: snuggExamples,

  /**
   * Write-back is SCAFFOLDED, not implemented. The real egress lands in Phase 4
   * Task 6 and is gated on Kyle's A1 — the Helix egress layer HMAC-SHA256-signs
   * the request server-side (Snugg Pro uses AWS-style signed requests, not a
   * static key). Faking an unsigned write to green a demo teaches the wrong thing
   * (plan §"Split"), so this rejects rather than resolving. The SIGNATURE is
   * honest now — `(fields, ctx, meta) => Promise<{ uuid }>`, where `fields` is
   * the PATCH (rejected keys absent, an accepted `null` present and meaning
   * Snugg's `Not Tested`) and `meta.idempotencyKey` is what Task 6 sends as
   * `Idempotency-Key` — so Task 6 is a wiring change, not a redesign.
   */
  write: async (_fields: SnuggValues, _ctx: SnuggWriteContext, _meta: WriteMetadata) => {
    throw new Error(
      "snuggProAdapter.write is not implemented yet: Snugg Pro egress lands in Phase 4 Task 6, " +
        "gated on A1 (HMAC-SHA256 request signing at the Helix egress layer).",
    );
  },
};

/**
 * Flatten plain field values into the core evidence shape `contradictionMatcher` reads.
 *
 * Both sides of a comparison arrive as plain values: the existing record never entered
 * extraction, and the dictated instance is already flattened by its caller
 * (`use-review.ts` reads `field.extracted.value`). This does NOT unwrap provenance
 * envelopes — a caller who passes one hits the matcher's throw naming the field,
 * which is the check that keeps the flattening contract honest.
 *
 * `sourceSpan` is null on every leaf: there is no producer for spans here yet. If a
 * caller ever has one (two chunks quoting the identical span is the one kind of
 * positive evidence a host matcher could read), the type already carries it.
 */
const toInstanceFacts = (group: string, values: Record<string, unknown>): InstanceFacts => ({
  group,
  leaves: Object.fromEntries(
    Object.entries(values).map(([field, value]) => [field, { value, sourceSpan: null }]),
  ),
});

/**
 * Order existing records of a collection group by how strongly they match a dictated instance.
 *
 * Expressed over core's `contradictionMatcher` with this adapter's `identifyingFields`
 * declaration — a candidate is demoted to the "contradicts" tier when the matcher says
 * `"different"`, and its `"unknown"` lands in the non-contradicting tier: a missing or
 * agreeing identifying field is missing information, not a disagreement, and review's
 * permissive reading is correct because a human is the backstop. The matcher is the
 * shared vocabulary, not a shared answer — a future consumer (cross-chunk instance
 * alignment) will share the evidence shapes and the veto, not this ranking.
 *
 * Within each tier the original order is preserved so the host tool's own ordering
 * (e.g., creation order) survives. The strongest non-contradicting candidate may be
 * pre-highlighted, but it is never linked automatically.
 */
export function rankCandidates(
  group: string,
  instance: Record<string, unknown>,
  existing: readonly ExistingRecord[],
): RankedCandidate[] {
  const matcher = contradictionMatcher(snuggProAdapter.identifyingFields);
  const dictated = toInstanceFacts(group, instance);
  const scored = existing.map((record): RankedCandidate => ({
    ...record,
    contradicts: matcher(dictated, toInstanceFacts(group, record.fields)) === "different",
  }));
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
