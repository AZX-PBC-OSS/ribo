/**
 * @file The fill phase of the scoped-instance port — one scoped fill per
 * `(group, piece, instance)`, as a `Phase` the phased engine runs after the
 * inventory phase.
 *
 * This is the second half of the `scopedInstanceExtractor` port (design
 * `phased-extraction-design.md` §4.7):
 *
 * - **The item is a `(group, piece, instance)` triple, never a `(group, instance)`
 *   slot.** Partitioning multiplies fill calls _per instance_, each piece carrying
 *   its own narrowed schema and a suffixed request name; the pieces of one slot
 *   recombine with `mergeGroupPieces`. Slot-granularity items would serialise a
 *   slot's pieces inside one `run` instead of interleaving them through the pool.
 * - **`plan` derives the job list and does NOTHING else.** It reads the roster
 *   from `notes` — the state the inventory phase's `merge` settled — and every
 *   side effect today's derivation loop performed (recording stated-empty spans,
 *   seeding empty collection groups, enforcing the cap) lives in the inventory
 *   phase's merge instead. Job derivation reads only the roster, the prepared
 *   groups' metadata and the transcript, so the split is a rearrangement, not a
 *   reordering. The one exception is `narrowToAbstained`'s read of
 *   `draft.fields` — see the option.
 * - **`merge` recombines and writes `raw`.** Pieces sharing a `(group, instance)`
 *   slot merge with `mergeGroupPieces`; collection groups assemble into arrays
 *   indexed by the job's `instanceIndex`, never by arrival order. `raw` is the
 *   assembled pre-normalize record — today `raw` is ALWAYS present on the result,
 *   and the engine emits it only when a merge wrote it.
 *
 * Both message paths are preserved: the `""` fallback group uses
 * `buildMessages` (the target's own instructions, unprojected examples), every
 * other group uses `buildFillMessages` with the adapter's scope block.
 */

import { z } from "zod";

import { demandNote } from "./phase-notes.js";
import { isExtractedLeaf } from "../provenance/extracted-leaves.js";
import { abstainedValue } from "../provenance/abstained-value.js";
import { mergeGroupPieces } from "../extraction/merge-group-pieces.js";
import { phaseBuilder } from "./phase.js";
import type { ChatClient, ChatMessage, ChatRequest } from "./chat-client.js";
import type { DeepPartial } from "./phase-draft.js";
import type { Enveloped, NoProvenance } from "../provenance/enveloped.js";
import type { ExtractionTarget } from "../extraction/extractor.js";
import type { FillScope, RosterCandidate } from "../extraction/inventory-types.js";
import type { Phase, PhaseDef } from "./phase.js";

import type { UsageTotals } from "../extraction/extraction-common.js";
import { addUsage, buildMessages } from "../extraction/extraction-common.js";
import { assertStopFinishReason, completeOrClassify, parseJsonContent } from "./chat-parse.js";
import { parseWithSchema } from "../extraction/parse-with-schema.js";
import type { PreparedGroup } from "../extraction/scoped-instance/instance-fill.js";
import {
  buildFillMessages,
  buildFillScope,
  singletonFillScope,
} from "../extraction/scoped-instance/instance-fill.js";
import { rosterNoteKey } from "./inventory-phase.js";

/** Options for {@link fillPhase} — the scoped-instance port's second half. */
export interface FillPhaseOptions<V extends Record<string, unknown>, P = NoProvenance> {
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
   * Build the scoped per-instance fill instructions for a group. The adapter owns
   * the natural-language rendering; the extractor owns the calling pattern.
   */
  readonly buildFillInstructions: (groupKey: string, scope: FillScope) => string;
  /**
   * When true, `plan` skips a job whose leaves are all committed in the draft,
   * so a second fill re-asks only about what the first did not get. Defaults to
   * `false` — the presets were measured with that semantics.
   *
   * Narrowing is sound where ADR 0009's group scoping was not: `merge` starts
   * from `{ ...draft.fields }`, so a skipped key is work ALREADY DONE, while
   * scoping would skip work that was NEVER DONE — absent from `fields`, and the
   * closing parse rejects a missing top-level group key. The granularity is the
   * job, not the leaf (leaf-level re-asking is `gapFillPhase`'s). "Committed"
   * means what it means everywhere else: a non-null leaf value.
   */
  readonly narrowToAbstained?: boolean;
  /**
   * What happens when one fill call fails: `"abort"` (the default) fails the
   * run and stops the siblings; `"skip"` hands the failed outcome to `merge`,
   * which writes the piece's abstained value — derived from the piece's own
   * schema, every leaf at the abstention floor — into the slot's ABSENT keys
   * only, and the run resolves. See `abstainedValue` in `@azx/ribo-core`.
   */
  readonly onItemFailure?: "abort" | "skip";
  /**
   * Overrides the phase's id — `"fill"` by default. See `PhaseMeta.id` in
   * `@azx/ribo-core` for what an id reaches and why a caller-chosen one is safe.
   */
  readonly id?: string;
  /**
   * Ids of the phases this one must follow, REPLACING the default
   * `["inventory"]` — the complete list, not an addition. The default names the
   * shipped provider of the roster note this phase's `plan` reads; overriding
   * it means naming that provider yourself. A caller adding an extra ordering
   * constraint must still name whoever writes the roster:
   * `requires: ["inventory", "mine"]`, not `["mine"]` — the plan throws naming
   * the roster note when no earlier phase wrote it. See `PhaseMeta.requires`
   * in `@azx/ribo-core` and ADR 0008.
   */
  readonly requires?: readonly string[];
}

/**
 * One per-instance fill call: messages, schema, and naming — the same job shape
 * the pre-port derivation loop built.
 *
 * For singleton groups the job still has one instance, but the scope is a
 * placeholder because there is exactly one record to fill.
 */
interface FillJob {
  readonly group: PreparedGroup;
  readonly instanceIndex: number;
  /** The number of current candidates in this job's group — 1 for singletons. */
  readonly instances: number;
  readonly messages: ChatMessage[];
  readonly requestName: string;
  readonly context: string;
}

/**
 * The leaves one fill job asks the model about: a partitioned piece names its
 * own subset (`leafKeys`); any other GROUPED piece's schema is the one-key
 * object `{ [key]: leaves }`, so the element's property names are the leaf
 * set; and a `""` piece's schema is the unwrapped strict object of its leaves,
 * so the leaf set is the schema's own top-level keys — the same read
 * `partitionedLeafKeys` makes (`per-group.ts`). An empty set is never treated
 * as satisfied — narrowing may plan a job that did not need re-asking, never
 * skip one that did.
 */
const pieceLeafKeys = (group: PreparedGroup): readonly string[] => {
  if (group.leafKeys !== undefined) return group.leafKeys;
  if (!(group.schema instanceof z.ZodObject)) return [];
  // A "" piece's schema IS the piece — there is no wrapping key to read under,
  // and shape[""] is undefined, which read as an empty leaf set and disabled
  // narrowing for every "" piece.
  if (group.key === "") return Object.keys(group.schema.shape);
  const shape = group.schema.shape as Record<string, z.ZodType>;
  const element = shape[group.key];
  return element instanceof z.ZodObject ? Object.keys(element.shape) : [];
};

/**
 * Whether every leaf a job would fill is already committed in the draft —
 * "committed" as defined on `narrowToAbstained`. Read through `isExtractedLeaf`
 * so a slot written by anything other than a fill merge reads as uncommitted.
 */
const jobFullyCommitted = <V extends Record<string, unknown>, P = NoProvenance>(
  fields: DeepPartial<Enveloped<V, P>>,
  group: PreparedGroup,
  instanceIndex: number,
): boolean => {
  const leaves = pieceLeafKeys(group);
  if (leaves.length === 0) return false;
  // THE CAST: the slot is read by dynamic key, which the deep partial's mapped
  // type cannot index; every leaf read is checked through `isExtractedLeaf` first.
  const fieldsRecord = fields as Record<string, unknown>;
  // The slot one job's leaves live in: a collection's is the instance's
  // element of the group's array; a singleton's is the group entry itself; a
  // "" piece's leaves are the draft's OWN top-level entries — the merge
  // assigns them flat (fields.note, never fields[""] — a slot no merge
  // writes), so the draft itself is the slot.
  const entry = fieldsRecord[group.key];
  const slot =
    group.key === ""
      ? fieldsRecord
      : group.isCollection
        ? Array.isArray(entry)
          ? (entry as unknown[])[instanceIndex]
          : undefined
        : entry;
  if (slot === null || typeof slot !== "object" || Array.isArray(slot)) return false;
  const map = slot as Record<string, unknown>;
  return leaves.every((leaf) => {
    const envelope = map[leaf];
    return isExtractedLeaf(envelope) && envelope.value !== null;
  });
};

/**
 * The abstained value for a FAILED job's piece — what its response WOULD have
 * parsed to, every leaf at the abstention floor. Derived from the piece's own
 * schema, so it parses the same way the success arm reads: the whole record for
 * a `""` piece, the group's sub-object otherwise.
 */
const abstainedPieceFor = (job: FillJob): unknown => {
  const whole = abstainedValue(job.group.schema) as Record<string, unknown>;
  return job.group.key === "" ? whole : whole[job.group.key];
};

/**
 * The error arm's write — `mergeGroupPieces` restricted to keys the slot does
 * NOT have. A failed piece's abstained value must never blank what the slot
 * already holds: an envelope with a null value can carry a non-null
 * `sourceSpan` a later pass relies on, and a committed value must survive a
 * failed re-ask (`narrowToAbstained`'s whole point). Later-wins is safe for the
 * success arm only because partitioned pieces hold disjoint leaf sets; an
 * abstained piece covers the piece's FULL leaf set, so it needs under-fill.
 */
const fillAbsentKeys = (slot: unknown, abstained: unknown): unknown => {
  // An absent slot takes the abstained value whole — the common case, and what
  // lets a group whose every job failed still assemble a full array.
  if (slot === undefined || slot === null) return abstained;
  // A slot that is not a leaf map is not under-fillable; leave it for the
  // closing parse to judge rather than destroying whatever it holds.
  if (typeof slot !== "object" || Array.isArray(slot)) return slot;
  const abstainedRecord = abstained as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...(slot as Record<string, unknown>) };
  for (const [key, leafValue] of Object.entries(abstainedRecord)) {
    if (!Object.hasOwn(merged, key)) merged[key] = leafValue;
  }
  return merged;
};

/**
 * The fill phase: derive one job per `(group, piece, instance)` from the
 * inventory's settled roster, make each job's one chat call, and recombine the
 * outcomes into the draft. See the file header for the shape of each member.
 */
export function fillPhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: FillPhaseOptions<V, P>,
): Phase<V, P> {
  const id = options.id ?? "fill";
  const def: PhaseDef<V, P, FillJob, Record<string, unknown>> = {
    id,
    // REPLACING, not additive: the option is the complete list, and the default
    // names the shipped provider of the note this plan reads — see the option.
    requires: options.requires ?? ["inventory"],
    // Spread in only when given — an absent option leaves the def's
    // `onItemFailure` undefined exactly as before the option existed.
    ...(options.onItemFailure === undefined ? {} : { onItemFailure: options.onItemFailure }),
    describeItem: (item) => ({
      key: item.group.key,
      instance: item.instanceIndex + 1,
      instances: item.instances,
      part: (item.group.part ?? 0) + 1,
      parts: item.group.parts ?? 1,
    }),
    plan: (draft, ctx) => {
      // A phase that reads a note demands it — defaulting would make a
      // mis-wired list a silent all-null run that parses green.
      const roster = demandNote(draft.notes, rosterNoteKey, id, "inventory");
      const transcript = ctx.transcript.text;
      const jobs: FillJob[] = [];

      for (const group of options.prepared) {
        if (!group.isCollection || group.key === "") {
          // Narrowing first, before any prompt is built — see
          // `narrowToAbstained`. This slot is the group entry itself.
          if (options.narrowToAbstained && jobFullyCommitted(draft.fields, group, 0)) continue;
          // Singleton or non-grouped fallback: one fill call per piece, no
          // scope semantics. The roster is not consulted — the singleton
          // branch ran before any roster interpretation today, and a stated
          // -none shape under a singleton key is ignored.
          const scope = singletonFillScope(group.key || "fields");
          const messages =
            group.key === ""
              ? // The fallback piece's schema — walked for the field-guidance
                // block, so a mixed schema's loose piece carries only its own
                // descriptions; for the all-flat fallback the piece schema IS
                // the whole schema and the guidance is the full block. THE
                // CAST: the piece schema is a narrowed subset of the target's,
                // read here for guidance only — the piece is parsed against
                // its own schema in `run`, never against this one.
                buildMessages(
                  { ...options.target, extractionSchema: group.schema } as ExtractionTarget<V, P>,
                  transcript,
                  { fieldDescriptions: group.fieldDescriptions },
                )
              : buildFillMessages(
                  options.target,
                  group.key,
                  0,
                  scope,
                  transcript,
                  options.buildFillInstructions,
                  group.leafKeys,
                  group.schema,
                  { fieldDescriptions: group.fieldDescriptions },
                );
          jobs.push({
            group,
            instanceIndex: 0,
            instances: 1,
            messages,
            requestName: group.name,
            context: group.context,
          });
          continue;
        }

        // Collection groups derive from the roster alone — the stated-empty
        // and no-current interpretations already happened in the inventory
        // phase's merge, and re-deriving them here writes nothing.
        const rosterGroup = roster[group.key] ?? [];
        if (!Array.isArray(rosterGroup)) continue;

        // The cast is today's — `Array.isArray` cannot narrow a `readonly T[]`
        // member out of the union, so the array side is claimed here.
        const candidates = rosterGroup as readonly RosterCandidate[];
        const current = candidates.filter((c) => c.eligibility === "current");
        if (current.length === 0) continue;

        for (let i = 0; i < current.length; i++) {
          // Narrowing first — see the singleton branch above; the granularity
          // is the job.
          if (options.narrowToAbstained && jobFullyCommitted(draft.fields, group, i)) continue;
          const candidate = current[i]!;
          const scope = buildFillScope(group.key, rosterGroup, candidate, i);
          const messages = buildFillMessages(
            options.target,
            group.key,
            i,
            scope,
            transcript,
            options.buildFillInstructions,
            group.leafKeys,
            group.schema,
            { fieldDescriptions: group.fieldDescriptions },
          );
          jobs.push({
            group,
            instanceIndex: i,
            instances: current.length,
            messages,
            requestName: `${group.name}-${i}`,
            context: `${group.context} instance ${i}`,
          });
        }
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
            schema: item.group.jsonSchema,
            strict: true,
          },
        },
        maxTokens: options.maxTokens,
      };

      // Forwarded, not rebuilt: the phase context's signal is the caller's
      // cancellation combined with the phase pool's sibling abort, and a
      // dropped forward would strand cancellation silently.
      const completion = await completeOrClassify(options.chat, request, item.context, {
        signal: ctx.signal,
      });
      assertStopFinishReason(completion, item.context);
      const raw = parseJsonContent(completion.content, item.context);
      // THE CAST: the piece schema is a one-key strict object, so the parsed
      // value IS a record keyed by the group key — the merge reads the group's
      // entry out of it.
      const parsed = parseWithSchema(item.group.schema, raw, item.context) as Record<
        string,
        unknown
      >;

      const totals: UsageTotals = {};
      addUsage(totals, completion.usage);
      return { value: parsed, usage: { calls: 1, ...totals } };
    },
    merge: (draft, outcomes) => {
      // THE CAST: the merge writes whole group entries by dynamic key, which the
      // deep partial's mapped type cannot index; the closing parse validates
      // every write.
      const groupResult: Record<string, unknown> = {
        ...(draft.fields as Record<string, unknown>),
      };
      const collectionArrays: Record<string, unknown[]> = {};

      for (const outcome of outcomes) {
        const job = outcome.item;
        // A result outcome contributes its parsed piece — the WHOLE narrowed
        // subset for a FLAT piece (no wrapping key to read under), the group's
        // sub-object for a keyed one. An error outcome — reachable only under
        // `onItemFailure: "skip"`, which hands the failed item here instead of
        // failing the run — contributes the ABSTAINED piece derived from the
        // same schema, read exactly the same way.
        const abstainedPiece = outcome.outcome === "result" ? undefined : abstainedPieceFor(job);
        const value =
          outcome.outcome === "result"
            ? job.group.key === ""
              ? outcome.output.value
              : outcome.output.value[job.group.key]
            : abstainedPiece;

        if (job.group.isCollection) {
          // The array is built here, in the merge that fills it — the
          // inventory merge deliberately does not allocate it (a group with
          // current candidates is not seeded). One slot per current
          // candidate, indexed by the job's instanceIndex, never by arrival
          // order. The base is the DRAFT's entry for the key when it holds
          // one — a narrowed fill's skipped jobs are exactly the slots a fresh
          // array would blank. A skipped failure participates in the same
          // allocation, so a group whose every job failed still assembles a
          // full array of abstained elements — no holes.
          const draftArray = groupResult[job.group.key];
          const arr =
            collectionArrays[job.group.key] ??
            (collectionArrays[job.group.key] = Array.isArray(draftArray)
              ? (draftArray as unknown[]).slice()
              : new Array<unknown>(job.instances));
          // A slot already holding a value means an earlier piece of the SAME
          // partitioned group already contributed its leaf subset for this
          // instance — recombine via mergeGroupPieces rather than letting the
          // last piece overwrite the rest. Jobs for one key are issued in piece
          // order and `mapWithPool` preserves it. A skipped failure writes by
          // under-fill instead — see `fillAbsentKeys`.
          const existing = arr[job.instanceIndex];
          arr[job.instanceIndex] =
            outcome.outcome === "result"
              ? existing === undefined
                ? value
                : mergeGroupPieces(existing, value)
              : fillAbsentKeys(existing, value);
        } else if (job.group.key === "") {
          // FLAT piece: every leaf it carried is a top-level key of the
          // schema. Each piece's parsed subset is disjoint from its siblings',
          // so an `Object.assign` in piece order is the merge — later pieces
          // never overwrite earlier ones because their leaves differ. The
          // closing parse then validates the whole against the schema. A
          // skipped failure covers the piece's FULL leaf set, so it assigns
          // only the keys nothing has written yet.
          if (outcome.outcome === "result") {
            Object.assign(groupResult, value);
          } else {
            for (const [leaf, abstainedLeaf] of Object.entries(value as Record<string, unknown>)) {
              if (!Object.hasOwn(groupResult, leaf)) groupResult[leaf] = abstainedLeaf;
            }
          }
        } else {
          const key = job.group.key;
          groupResult[key] =
            outcome.outcome === "result"
              ? key in groupResult
                ? mergeGroupPieces(groupResult[key], value)
                : value
              : key in groupResult
                ? fillAbsentKeys(groupResult[key], value)
                : value;
        }
      }
      for (const [key, arr] of Object.entries(collectionArrays)) {
        groupResult[key] = arr;
      }

      return {
        ...draft,
        fields: groupResult as DeepPartial<Enveloped<V, P>>,
        // `raw` is the assembled record BEFORE normalize runs — and it is
        // written unconditionally: today the member is always present on the
        // result, and the engine emits it only when a merge wrote it.
        raw: groupResult,
      };
    },
  };
  return phaseBuilder<V, P>()(def);
}
