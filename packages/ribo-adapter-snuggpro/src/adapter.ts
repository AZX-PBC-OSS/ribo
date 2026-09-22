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

import type {
  ExistingRecord,
  InstanceFacts,
  RankedCandidate,
  ToolAdapter,
  WriteMetadata,
} from "@azx/ribo-core";
import { contradictionMatcher, TerminalError } from "@azx/ribo-core";
import { z } from "zod";
import { snuggCtxSchema, type SnuggWriteContext } from "./context.js";
import { snuggExamples } from "./examples.js";
import { SNUGG_ENDPOINTS } from "./endpoints.generated.js";
import { snuggProInstructions } from "./instructions.js";
import { snuggExtractionSchema, snuggValuesSchema, type SnuggValues } from "./schema.js";
import { createSnuggHttpWriter, type SnuggHttpWriter } from "./write/writer.js";

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

/**
 * Options for {@link createSnuggProAdapter}.
 *
 * `fetchImpl` is the only option, after the `ribo-transcriber-managed` precedent:
 * the package has no capacity to authenticate. The base URL is deliberately NOT
 * an option — `snuggCtxSchema.apiBaseUrl` is the one source for it, validated and
 * persisted with the session, and a second copy here would be two sources for one
 * fact. The credential lives in the transport the host supplies: its `fetchImpl`
 * routes through the Helix gateway, which signs the request server-side and
 * injects the stored credential.
 */
export interface SnuggProAdapterOptions {
  /**
   * Override `fetch` — inject a double for tests, or the host's
   * credential-attaching transport for production. Defaults to the bare global
   * `fetch`, which is expressly allowed in this headless package (AGENTS §4).
   */
  readonly fetchImpl?: typeof fetch;
}

/**
 * The groups this release extracts and reviews but refuses to WRITE, named with
 * the reason. The refusal is write-only: their fields still flow through
 * extraction and review, because the human decision about them is worth having
 * even while the wire cannot carry them yet.
 */
const REFUSED_GROUP_REASONS: Readonly<Record<string, string>> = {
  stage:
    `writing it transitions a real customer's workflow stage — visible to the customer and ` +
    `the program — and its wire value is an integer whose vocabulary exists only in the ` +
    `vendor spec's prose. Nobody has decided a dictated sentence should move a job; that is ` +
    `a product decision, not a field mapping`,
  incentive:
    `its create requires a template uuid, but fromTemplateUuid is captured as the spoken ` +
    `rebate name, never a resolved id. Until that resolution exists a create cannot ` +
    `succeed, so shipping it would only produce dead sessions`,
};

/**
 * The shared adapter surface, minus `write` — both {@link snuggProAdapter} and the
 * factory's product spread this and attach the write their transport earns.
 */
const adapterWithoutWrite: Omit<ToolAdapter<SnuggValues, SnuggWriteContext>, "write"> = {
  name: SNUGGPRO_ADAPTER_NAME,
  schema: snuggValuesSchema,
  extractionSchema: snuggExtractionSchema,
  ctxSchema: snuggCtxSchema,

  /**
   * What Snugg Pro refuses a CREATE without — declared per group so the same
   * leaves apply to every emitted instance of a collection, and to the singleton
   * groups directly.
   *
   * `POST /jobs/{jobId}/hvac` requires exactly two capture fields, and both are
   * extracted; every other component endpoint (attic, wall, window, DHW, health,
   * concern) has none, which is why a partial dictation of a component writes
   * cleanly (doc 17 §"The required-field surface", doc 20 §5.7).
   *
   * `POST /jobs/{jobId}/incentives` refuses a create without `fromTemplateUuid`
   * (`required: true` in the spec) — declared even though the incentive group is
   * excluded from writing in this release, because the declaration is about what
   * the API refuses, not about what ships.
   *
   * The `job` singleton declares nothing: Snugg Pro launches the app with an
   * existing `jobId`, job creation is out of scope, and `PUT /jobs/{jobId}` — the
   * only way to update an existing job — requires nothing.
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
    incentive: ["fromTemplateUuid"],
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
};

/**
 * The write for a transport-less adapter — the bare {@link snuggProAdapter}.
 * Everything but `write` works off it; the write names the fix instead of
 * resolving into a network call the host never configured.
 */
const writeWithoutTransport = async (): Promise<{ readonly receipt: string }> => {
  throw new Error(
    "snuggProAdapter.write: no transport is configured. Snugg Pro egress needs the host's " +
      "credential-attaching transport — build the adapter with " +
      "createSnuggProAdapter({ fetchImpl }) and pass THAT to the write step.",
  );
};

/**
 * Bridge one whole patch to the per-group HTTP writer, and collapse the
 * per-record receipts into the one uuid `ToolAdapter.write` returns.
 *
 * The patch and the writer live at different granularities: `write` receives the
 * whole patch, the writer one group's values. Every group present in the patch is
 * written, in the schema's own group order (deterministic, independent of the
 * patch object's key order), a collection group instance by instance. Refused
 * groups are checked before any request, so a patch that mixes a writable group
 * with a refused one cannot half-write.
 */
const writePatch = async (
  writer: SnuggHttpWriter,
  fields: SnuggValues,
  ctx: SnuggWriteContext,
  meta: WriteMetadata,
): Promise<{ readonly receipt: string }> => {
  const records: Array<{ group: string; values: Record<string, unknown> }> = [];
  for (const group of Object.keys(snuggValuesSchema.shape)) {
    const value = fields[group as keyof SnuggValues];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const instance of value) {
        records.push({ group, values: instance });
      }
    } else {
      records.push({ group, values: value });
    }
  }
  if (records.length === 0) {
    throw new Error(
      "snuggProAdapter.write: the patch carries no records to write — an empty patch is a " +
        "programming error, not a no-op. The write step must not be reached with nothing accepted.",
    );
  }
  for (const { group } of records) {
    const reason = REFUSED_GROUP_REASONS[group];
    if (reason !== undefined) {
      throw new TerminalError(
        `snuggProAdapter.write: the "${group}" group is not written by this release — ${reason}. ` +
          `Its values are still extracted and reviewed; only the write is refused.`,
      );
    }
  }

  const receipts: string[] = [];
  for (const { group, values } of records) {
    const { receipt } = await writer(group, values, ctx, meta);
    receipts.push(receipt);
  }
  if (receipts.length === 1) {
    return { receipt: receipts[0]! };
  }
  // More than one record, so this return cannot be the individual receipts: the
  // vendor assigned each its own uuid and this contract carries one string. The
  // synthetic marker is NOT recoverable into those receipts — which is exactly why
  // `toInstanceWriteStep` writes collection instances one at a time (one call per
  // instance, one real receipt each, checkpointed as earned) and is the supported
  // composition for this adapter. A host that batches loses per-record receipts
  // and will create duplicates on a retry.
  return { receipt: `assessment:${ctx.assessmentId}` };
};

/**
 * Build a Snugg Pro adapter with a real write, over the transport the host
 * supplies. The write composes {@link createSnuggHttpWriter} — the I/O, URL
 * building, body transform and failure classification are all the writer's; this
 * factory only bridges the patch to it (see {@link writePatch}).
 *
 * Without `fetchImpl` the product is the transport-less adapter: identical
 * surface, but `write` rejects naming this factory as the fix. That instance is
 * published as {@link snuggProAdapter}.
 */
export const createSnuggProAdapter = (
  options: SnuggProAdapterOptions = {},
): ToolAdapter<SnuggValues, SnuggWriteContext> => {
  if (options.fetchImpl === undefined) {
    return { ...adapterWithoutWrite, write: writeWithoutTransport };
  }
  const writer = createSnuggHttpWriter({ fetchImpl: options.fetchImpl });
  return {
    ...adapterWithoutWrite,
    write: (fields, ctx, meta) => writePatch(writer, fields, ctx, meta),
  };
};

/** The transport-less adapter: everything but a working write. See {@link createSnuggProAdapter}. */
export const snuggProAdapter: ToolAdapter<SnuggValues, SnuggWriteContext> = createSnuggProAdapter();

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
 * The vendor's shape for one existing record: an identifier plus that record's
 * field values. `z.looseObject` keeps the field values — they are what
 * `rankCandidates`' sameness judgement reads — while pinning the one key the
 * `ExistingRecord` contract needs.
 */
const snuggExistingRecordSchema = z.looseObject({ uuid: z.string().min(1) });

/** Options for {@link readExistingRecords} — the same injectable transport as the writer's. */
export interface ReadExistingRecordsOptions {
  readonly fetchImpl?: typeof fetch;
}

/**
 * Read a collection group's existing records, so review can offer them as link
 * candidates: an auditor sees "there is already a boiler on this job" at review
 * and links instead of creating a duplicate. A host passes the result to core's
 * `buildReviewRequest`; this module is a function rather than a `ToolAdapter`
 * member because core never calls it — the host does, and a published contract
 * does not grow a member for one host's convenience.
 *
 * `GET`s the group's plural path (the endpoint table's create path — `incentive`'s
 * is `/jobs/{jobId}/incentives`) through the injected transport. The gateway signs;
 * the package holds no credential and gains no capacity to authenticate. The vendor
 * JSON is parsed with zod before it becomes `ExistingRecord`s — a trust boundary
 * (AGENTS §4), so a malformed response rejects rather than reaching review.
 */
export async function readExistingRecords(
  ctx: SnuggWriteContext,
  group: string,
  options: ReadExistingRecordsOptions = {},
): Promise<ExistingRecord[]> {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoints = SNUGG_ENDPOINTS[group];
  if (!endpoints) {
    throw new Error(`readExistingRecords: no Snugg Pro endpoint table entry for group "${group}".`);
  }
  if (endpoints.kind !== "collection" || endpoints.list === undefined) {
    throw new Error(
      `readExistingRecords: the "${group}" group has no collection list path — only ` +
        `collection groups have existing records to read.`,
    );
  }
  // `list`, never `create`. The vendor reads plural (`/jobs/{jobId}/hvacs`) and creates
  // singular (`/jobs/{jobId}/hvac`), so reading the create path is a 404 — which is
  // exactly what a live run against staging returned before the table carried `list`.
  const url = new URL(
    `${ctx.apiBaseUrl.replace(/\/+$/, "")}${endpoints.list.path.replaceAll("{jobId}", ctx.assessmentId)}`,
  ).href;
  const response = await doFetch(url, { method: "GET", headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(
      `readExistingRecords: the Snugg Pro read of "${group}" failed with HTTP ${response.status}.`,
    );
  }
  const parsed = z.array(snuggExistingRecordSchema).parse(await response.json());
  return parsed.map(({ uuid, ...fields }) => ({ uuid, fields }));
}
