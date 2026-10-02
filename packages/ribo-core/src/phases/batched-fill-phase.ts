/**
 * @file The batched fill phase — the scoped-instance port's alternative fill:
 * one scoped fill per `(group, piece)` covering EVERY current instance of a
 * collection in a single call (design
 * `group-partition-and-batched-fill-design.md` §6).
 *
 * The per-instance {@link fillPhase} sibling. It reads the same roster note
 * and the same prepared pieces, but plans one item per `(group, piece)` — the
 * part is the unit, as it is everywhere else (spec §4) — and asks the model
 * for one array element per instance, each element carrying its roster id in
 * `instanceId`. The response schema's `instanceId` is an enum of THIS run's
 * ids, so the model cannot name an instance the inventory did not list; a
 * reply that misses or repeats an id fails the item retryably and the engine
 * re-sends the same messages (the reason reaches the unit stream's error
 * event, not the request — a feedback channel would mean changing the
 * engine's retry ownership, which the spec rules out).
 *
 * The merge keys on `instanceId`, never on arrival order: reply order is
 * irrelevant, and a reversed reply lands on the same instances as an ordered
 * one. A skipped item (under `onItemFailure: "skip"`) abstains the piece's
 * leaves on EVERY instance, so the array has no holes.
 *
 * What this phase deliberately does not do: singleton groups and the `""`
 * fallback stay with the per-instance fill (there is nothing to batch), and
 * narrowing (`narrowToAbstained`) is not re-asked here — the presets were
 * measured with per-instance re-asks, and a batched re-ask's blast radius is
 * every instance at once.
 */

import { z } from "zod";

import { demandNote } from "./phase-notes.js";
import { phaseBuilder } from "./phase.js";
import { rosterNoteKey } from "./inventory-phase.js";
import { abstainedElement, fillAbsentKeys } from "./fill-abstain.js";
import { mergeGroupPieces } from "../extraction/merge-group-pieces.js";
import { partitionLabelLine } from "../extraction/schema/split-schema.js";
import { toJsonSchemaForWire } from "../extraction/schema/wire-schema.js";
import { withFieldGuidance } from "../extraction/field-guidance.js";
import { addUsage } from "../extraction/extraction-common.js";
import { assertStopFinishReason, completeOrClassify, parseJsonContent } from "./chat-parse.js";
import { parseWithSchema } from "../extraction/parse-with-schema.js";
import type { ChatClient, ChatMessage, ChatRequest } from "./chat-client.js";
import type { DeepPartial } from "./phase-draft.js";
import type { Enveloped, NoProvenance } from "../provenance/enveloped.js";
import type { ExtractionTarget } from "../extraction/extractor.js";
import type { RosterCandidate } from "../extraction/inventory-types.js";
import type { Phase, PhaseDef } from "./phase.js";
import type { UsageTotals } from "../extraction/extraction-common.js";
import type { PreparedGroup } from "../extraction/scoped-instance/instance-fill.js";

/**
 * One instance a batched fill covers: the roster id its element carries
 * (`"<groupKey>-<n>"`, 1-based over the current candidates in roster order)
 * and the candidate the inventory described.
 */
export interface BatchedIdentity {
  readonly id: string;
  readonly candidate: RosterCandidate;
}

/** Options for {@link batchedFillPhase} — the scoped-instance port's batched fill. */
export interface BatchedFillPhaseOptions<V extends Record<string, unknown>, P = NoProvenance> {
  /** The field knowledge: name, extraction schema, instructions, and examples. */
  readonly target: ExtractionTarget<V, P>;
  /** The injected chat transport. A fake in tests; a real client in production. */
  readonly chat: ChatClient;
  /** The model id passed through to the endpoint. */
  readonly model: string;
  /** Cap on generated tokens, passed through to each chat request. */
  readonly maxTokens?: number;
  /** The prepared groups (from `splitExtractionSchema`), one entry per piece. */
  readonly prepared: readonly PreparedGroup[];
  /**
   * Which collection groups this phase fills, decided from the group's
   * current-instance count at plan time. The scoped-instance preset wires this
   * to the complement of the per-instance fill's filter, so a group is filled
   * by exactly one of the two phases.
   */
  readonly includeGroup: (groupKey: string, currentInstances: number) => boolean;
  /**
   * Build the batched fill instructions for a group: the identities in scope
   * and the excluded candidates. Omitted, a core default lists the identities
   * (id, mention span, discriminator, distinguishing detail), states the
   * excluded as out of scope, and asks for one element per id.
   */
  readonly buildBatchedFillInstructions?: (
    groupKey: string,
    identities: readonly BatchedIdentity[],
    excluded: readonly RosterCandidate[],
  ) => string;
  /**
   * What happens when one batched call fails: `"abort"` (the default) fails
   * the run; `"skip"` hands the failed outcome to `merge`, which writes the
   * piece's abstained element — every leaf at the abstention floor — into
   * EVERY instance's ABSENT keys, so the collection array has no holes.
   */
  readonly onItemFailure?: "abort" | "skip";
  /**
   * Overrides the phase's id — `"batched-fill"` by default. See `PhaseMeta.id`
   * in `@azx/ribo-core` for what an id reaches and why a caller-chosen one is
   * safe.
   */
  readonly id?: string;
  /**
   * Ids of the phases this one must follow, REPLACING the default
   * `["inventory"]` — the complete list, not an addition. See
   * `FillPhaseOptions.requires` for the discipline.
   */
  readonly requires?: readonly string[];
}

/**
 * One batched fill call: one prepared piece, covering every current instance
 * of its collection. The response schema is per-item because the `instanceId`
 * enum is this roster's ids — built at plan time, like the messages.
 */
interface BatchedFillJob {
  readonly group: PreparedGroup;
  readonly identities: readonly BatchedIdentity[];
  /** Roster id → the instance's index in the collection array. */
  readonly indexById: ReadonlyMap<string, number>;
  readonly messages: ChatMessage[];
  readonly requestName: string;
  readonly context: string;
  readonly responseSchema: z.ZodType;
  readonly jsonSchema: Record<string, unknown>;
}

/**
 * The core default instructions: the target's own, then the identities in
 * scope, then the excluded candidates stated as out of scope, then the one
 * element-per-id instruction. The label line is appended by the caller, after
 * whatever instructions were built — the same placement `buildFillMessages`
 * gives it.
 */
const defaultBatchedFillInstructions = (
  targetInstructions: string,
  groupKey: string,
  identities: readonly BatchedIdentity[],
  excluded: readonly RosterCandidate[],
): string => {
  const lines: string[] = [
    targetInstructions,
    "",
    `The instances of "${groupKey}" in scope, each with the id its array element must carry:`,
  ];
  for (const { id, candidate } of identities) {
    lines.push(
      `- ${id}: ${candidate.discriminator} — introduced by "${candidate.mentionSpan}"` +
        (candidate.distinguishedBy === null
          ? ""
          : `; distinguished by "${candidate.distinguishedBy}"`),
    );
  }
  lines.push("", "Out of scope — recorded nowhere:");
  if (excluded.length === 0) {
    lines.push("- None.");
  } else {
    for (const candidate of excluded) {
      lines.push(
        `- ${candidate.discriminator} — introduced by "${candidate.mentionSpan}"; excluded as "${candidate.eligibility}"`,
      );
    }
  }
  lines.push(
    "",
    `Return exactly one array element per listed id (${identities
      .map(({ id }) => id)
      .join(", ")}), each element carrying its id in "instanceId".`,
  );
  return lines.join("\n");
};

/**
 * The response schema for one batched item: the piece's element shape with an
 * `instanceId` enum prepended, wrapped in an array under the group's key.
 * Strict throughout, so a reply naming a field the piece does not cover — or
 * an id the roster does not list — fails the parse.
 */
const batchedResponseSchema = (group: PreparedGroup, ids: readonly string[]): z.ZodType => {
  // THE CAST: a collection piece's prepared schema is the one-key strict
  // object `{ [key]: element }` that `prepareGroups` built (the array is
  // unwrapped there — a fill never adds an instance), and the element is the
  // piece's own object of leaves.
  const shape = (group.schema as z.ZodObject).shape as Record<string, z.ZodType>;
  const element = shape[group.key];
  if (!(element instanceof z.ZodObject)) {
    throw new TypeError(
      `batchedFillPhase: group "${group.key}"'s piece element is not an object — ` +
        `batched fill covers collection groups only.`,
    );
  }
  // The spread below would let the element's own leaf replace the id enum.
  if (Object.hasOwn(element.shape, "instanceId")) {
    throw new TypeError(
      `batchedFillPhase: group "${group.key}" has its own "instanceId" field, which the ` +
        "batched reply reserves for the roster id — fill this group per instance.",
    );
  }
  // THE CAST: `z.enum` wants a tuple; `ids` is non-empty by construction (plan
  // skips a group with no current candidates) but typed `string[]`.
  const elementWithId = z.strictObject({
    instanceId: z.enum(ids as [string, ...string[]]),
    ...element.shape,
  });
  return z.strictObject({ [group.key]: z.array(elementWithId) });
};

/**
 * The exactly-once check, after the parse: every roster id appears exactly
 * once in the reply's array. The schema cannot say this (it constrains each
 * element, not the set), so a missing or duplicated id is caught here — a
 * plain `Error`, transient to the engine's retry, which re-sends the same
 * messages; the reason reaches the unit stream's error event, not the request.
 */
const assertExactlyOnce = (job: BatchedFillJob, parsed: Record<string, unknown>): void => {
  // THE CAST: parsed against the job's own response schema, so the key holds
  // an array of elements whose instanceId the enum already constrained.
  const elements = parsed[job.group.key] as readonly { instanceId: string }[];
  const counts = new Map<string, number>();
  for (const element of elements) {
    counts.set(element.instanceId, (counts.get(element.instanceId) ?? 0) + 1);
  }
  const missing: string[] = [];
  const duplicated: string[] = [];
  for (const { id } of job.identities) {
    const count = counts.get(id) ?? 0;
    if (count === 0) missing.push(id);
    else if (count > 1) duplicated.push(id);
  }
  if (missing.length === 0 && duplicated.length === 0) return;
  throw new Error(
    `${job.context}: the response must carry every instance id exactly once — ` +
      `missing: ${missing.length === 0 ? "none" : missing.join(", ")}; ` +
      `duplicated: ${duplicated.length === 0 ? "none" : duplicated.join(", ")}`,
  );
};

/**
 * The batched fill phase: one call per `(group, piece)` covering every current
 * instance, merged by roster id. See the file header for the contract.
 */
export function batchedFillPhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: BatchedFillPhaseOptions<V, P>,
): Phase<V, P> {
  const id = options.id ?? "batched-fill";
  const def: PhaseDef<V, P, BatchedFillJob, Record<string, unknown>> = {
    id,
    // REPLACING, not additive: the option is the complete list, and the default
    // names the shipped provider of the note this plan reads — same discipline
    // as `fillPhase`.
    requires: options.requires ?? ["inventory"],
    // Spread in only when given — an absent option leaves the def's
    // `onItemFailure` undefined exactly as before the option existed.
    ...(options.onItemFailure === undefined ? {} : { onItemFailure: options.onItemFailure }),
    // A batched item covers every instance, so it reports the piece
    // coordinates only — there is no one `instance` to name.
    describeItem: (item) => ({
      key: item.group.key,
      part: (item.group.part ?? 0) + 1,
      parts: item.group.parts ?? 1,
    }),
    plan: (draft, ctx) => {
      // A phase that reads a note demands it — same discipline as fillPhase.
      const roster = demandNote(draft.notes, rosterNoteKey, id, "inventory");
      const transcript = ctx.transcript.text;
      const jobs: BatchedFillJob[] = [];

      for (const group of options.prepared) {
        // Singletons and the "" fallback stay with the per-instance fill.
        if (!group.isCollection || group.key === "") continue;

        // The roster note's interpretation (stated-empty, seeding) already
        // happened in the inventory phase's merge; a non-array entry plans
        // nothing here.
        const rosterGroup = roster[group.key] ?? [];
        if (!Array.isArray(rosterGroup)) continue;
        // The cast is fillPhase's — `Array.isArray` cannot narrow a
        // `readonly T[]` member out of the union.
        const candidates = rosterGroup as readonly RosterCandidate[];
        const current = candidates.filter((c) => c.eligibility === "current");
        if (current.length === 0) continue;
        if (!options.includeGroup(group.key, current.length)) continue;

        const excluded = candidates.filter((c) => c.eligibility !== "current");
        const identities: readonly BatchedIdentity[] = current.map((candidate, index) => ({
          id: `${group.key}-${index + 1}`,
          candidate,
        }));
        const ids = identities.map((identity) => identity.id);
        const responseSchema = batchedResponseSchema(group, ids);
        const base =
          options.buildBatchedFillInstructions === undefined
            ? defaultBatchedFillInstructions(
                options.target.instructions,
                group.key,
                identities,
                excluded,
              )
            : options.buildBatchedFillInstructions(group.key, identities, excluded);
        // The label line sits after the instructions and before the guidance
        // block — the placement `buildFillMessages` gives it.
        const withLabel =
          group.label === undefined
            ? base
            : `${base}\n\n${partitionLabelLine(group.key, group.label)}`;
        const instructions =
          group.fieldDescriptions === "prompt"
            ? withFieldGuidance(withLabel, group.schema)
            : withLabel;
        const messages: ChatMessage[] = [
          { role: "system", content: instructions },
          { role: "user", content: transcript },
        ];
        jobs.push({
          group,
          identities,
          indexById: new Map(identities.map((identity, index) => [identity.id, index])),
          messages,
          requestName: `${group.name}-batched`,
          context:
            group.part !== undefined
              ? `batchedFillPhase: fill for group "${group.key}" (part ${group.part + 1}/${group.parts})`
              : `batchedFillPhase: fill for group "${group.key}"`,
          responseSchema,
          // Rendered exactly as the per-instance fill's piece schema is: the
          // same wire helper, honouring the mode `prepareGroups` recorded.
          jsonSchema: toJsonSchemaForWire(responseSchema, {
            keepDescriptions: group.fieldDescriptions === "schema",
          }),
        });
      }

      return jobs;
    },
    run: async (item, _draft, ctx) => {
      const request: ChatRequest = {
        model: options.model,
        messages: item.messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: item.requestName,
            schema: item.jsonSchema,
            strict: true,
          },
        },
        maxTokens: options.maxTokens,
      };

      // Forwarded, not rebuilt — the same discipline as fillPhase's run.
      const completion = await completeOrClassify(options.chat, request, item.context, {
        signal: ctx.signal,
      });
      assertStopFinishReason(completion, item.context);
      const raw = parseJsonContent(completion.content, item.context);
      // THE CAST: the response schema is the one-key strict object `plan`
      // built, so the parsed value IS a record keyed by the group key.
      const parsed = parseWithSchema(item.responseSchema, raw, item.context) as Record<
        string,
        unknown
      >;
      assertExactlyOnce(item, parsed);

      const totals: UsageTotals = {};
      addUsage(totals, completion.usage);
      return { value: parsed, usage: { calls: 1, ...totals } };
    },
    merge: (draft, outcomes) => {
      // THE CAST: the merge writes whole group arrays by dynamic key, which the
      // deep partial's mapped type cannot index; the closing parse validates
      // every write — the same cast fillPhase's merge makes.
      const groupResult: Record<string, unknown> = {
        ...(draft.fields as Record<string, unknown>),
      };
      const collectionArrays: Record<string, unknown[]> = {};

      for (const outcome of outcomes) {
        const job = outcome.item;
        // The array is built here, exactly as fillPhase's merge builds it:
        // the DRAFT's entry when it holds one, else one slot per current
        // candidate. A skipped failure participates in the same allocation, so
        // a group whose batched call failed still assembles a full array of
        // abstained elements — no holes.
        const draftArray = groupResult[job.group.key];
        const arr =
          collectionArrays[job.group.key] ??
          (collectionArrays[job.group.key] = Array.isArray(draftArray)
            ? (draftArray as unknown[]).slice()
            : new Array<unknown>(job.identities.length));
        if (outcome.outcome === "result") {
          // THE CAST: parsed and exactly-once checked in `run`, so every
          // element carries a roster id the job knows.
          const elements = outcome.output.value[job.group.key] as readonly {
            instanceId: string;
          }[];
          for (const element of elements) {
            const { instanceId, ...fields } = element;
            const index = job.indexById.get(instanceId)!;
            // A slot already holding a value means an earlier piece of the
            // SAME partitioned group already contributed its leaf subset for
            // this instance — recombine, keyed by id, never by arrival order.
            const existing = arr[index];
            arr[index] = existing === undefined ? fields : mergeGroupPieces(existing, fields);
          }
        } else {
          // A skipped item abstains the piece's leaves on every instance, by
          // under-fill — a committed sibling piece's leaves survive.
          const abstained = abstainedElement(job.group.schema, job.group.key);
          for (let index = 0; index < job.identities.length; index++) {
            arr[index] = fillAbsentKeys(arr[index], abstained);
          }
        }
      }
      for (const [key, arr] of Object.entries(collectionArrays)) {
        groupResult[key] = arr;
      }

      return {
        ...draft,
        fields: groupResult as DeepPartial<Enveloped<V, P>>,
        // `raw` is the assembled record BEFORE normalize runs, written
        // unconditionally — as fillPhase's merge writes it, so a run whose
        // fills were all batched still carries one.
        raw: groupResult,
      };
    },
  };
  return phaseBuilder<V, P>()(def);
}
