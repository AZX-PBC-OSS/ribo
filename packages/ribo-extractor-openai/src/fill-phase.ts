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
 *   reordering. The one exception is `narrowToAbstained`, which reads
 *   `draft.fields` to skip jobs whose leaves are already committed — see the
 *   option for why that read is sound and what it costs.
 * - **`merge` recombines and writes `raw`.** Pieces sharing a `(group, instance)`
 *   slot merge with `mergeGroupPieces`; collection groups assemble into arrays
 *   indexed by the job's `instanceIndex`, never by arrival order, on a base
 *   taken from the draft's own entry for the key so a narrowed fill cannot blank
 *   the slots its skipped jobs did not re-ask. `raw` is the
 *   assembled pre-normalize record — today `raw` is ALWAYS present on the result,
 *   and the engine emits it only when a merge wrote it, so a merge that did not
 *   write it would drop the member entirely (the exact miss the previous port in
 *   this series made, invisible to a suite whose only `raw` assertion compared two
 *   results to each other and passed when both were absent).
 *
 * Both message paths are preserved: the `""` fallback group uses
 * `buildMessages` (the target's own instructions, unprojected examples), every
 * other group uses `buildFillMessages` with the adapter's scope block.
 */

import { z } from "zod";

import {
  draftSeededNoteKey,
  isExtractedLeaf,
  mergeGroupPieces,
  phaseBuilder,
} from "@azx/ribo-core";
import type {
  ChatClient,
  ChatMessage,
  ChatRequest,
  DeepPartial,
  Enveloped,
  ExtractionTarget,
  FillScope,
  NoProvenance,
  Phase,
  PhaseDef,
  Roster,
  RosterCandidate,
} from "@azx/ribo-core";

import type { UsageTotals } from "./extraction-common.js";
import {
  addUsage,
  assertStopFinishReason,
  buildMessages,
  completeOrClassify,
  parseJsonContent,
  parseWithSchema,
} from "./extraction-common.js";
import type { PreparedGroup } from "./instance-fill.js";
import { buildFillMessages, buildFillScope, singletonFillScope } from "./instance-fill.js";
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
   * When true, `plan` skips a job whose leaves are already committed in the
   * draft, so running the fill phase twice does useful work the second time —
   * the second fill re-asks only about what the first did not get. Defaults to
   * `false`, which plans every job the roster yields: the presets were measured
   * with that semantics, and `true` changes behaviour for every existing caller.
   *
   * **Why narrowing is sound where group scoping was not** — design
   * `sp4a-composable-phases-design.md` §4.3 shipped this and §4.2 abandoned
   * scoping, and the distinction is the reason. `merge` starts from
   * `{ ...draft.fields }`, so anything an earlier phase wrote survives a
   * narrowed re-run: narrowing skips work that is ALREADY DONE — the skipped
   * keys are in the draft. Scoping would skip work that was NEVER DONE — its
   * keys would be absent from `fields`, and the closing parse rejects a missing
   * top-level group key.
   *
   * **The granularity is the job, not the leaf.** A job whose leaves are all
   * committed is skipped; a job with any uncommitted leaf is planned in full and
   * re-asks about everything in it. Leaf-level narrowing — re-asking exactly the
   * abstained leaves — is what `gapFillPhase` does and is a different phase; §7
   * of the design records this job-level limit as known.
   *
   * "Committed" means what it means everywhere else: a leaf envelope whose
   * `value` is non-null.
   */
  readonly narrowToAbstained?: boolean;
  /**
   * Overrides the phase's id — `"fill"` by default. See `PhaseMeta.id` in
   * `@azx/ribo-core` for what an id reaches and why a caller-chosen one is safe.
   */
  readonly id?: string;
  /**
   * Extra note keys this phase must wait for, unioned with the phase's own —
   * additive, never replacing. A phase's own `requires` is a fact about what
   * its `plan` reads, not a configuration choice: letting a caller replace it
   * would let them declare away a real dependency, reintroducing the
   * `[gapfill]`-alone class of bug the note-key check exists to reject. Adding
   * can only make validation stricter. Duplicates are removed cosmetically —
   * the engine tolerates a repeat; dedup keeps error messages and any future
   * introspection clean.
   *
   * **Deliberately no additive `produces`.** The engine verifies a declared
   * `produces` key against what the phase's merge actually wrote, and this
   * merge will never write a caller's key — declaring one would throw mid-run.
   * A caller's contribution belongs on a caller-built phase.
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
 * own subset (`leafKeys`); any other piece's schema is the one-key object
 * `{ [key]: leaves }`, so the element's property names are the leaf set — the
 * same shape walk `leafSchemaAtPath` does. An empty set asks about nothing and
 * is never treated as satisfied, so a group whose piece schema cannot be walked
 * is always planned — narrowing may plan a job that did not need re-asking,
 * never skip one that did.
 */
const pieceLeafKeys = (group: PreparedGroup): readonly string[] => {
  if (group.leafKeys !== undefined) return group.leafKeys;
  if (!(group.schema instanceof z.ZodObject)) return [];
  const shape = group.schema.shape as Record<string, z.ZodType>;
  const element = shape[group.key];
  return element instanceof z.ZodObject ? Object.keys(element.shape) : [];
};

/**
 * Whether every leaf a job would fill is already committed in the draft —
 * "committed" meaning what it means everywhere else: a leaf envelope whose
 * `value` is non-null, the definition `findAbstainedLeaves` works from. Read
 * through `isExtractedLeaf` so a slot written by anything other than a fill
 * merge reads as uncommitted rather than as data.
 */
const jobFullyCommitted = <V extends Record<string, unknown>, P = NoProvenance>(
  fields: DeepPartial<Enveloped<V, P>>,
  group: PreparedGroup,
  instanceIndex: number,
): boolean => {
  const leaves = pieceLeafKeys(group);
  if (leaves.length === 0) return false;
  // THE CAST, and why it is sound: the slot is read by dynamic key, which the
  // deep partial's mapped type cannot index by a runtime string. Every leaf
  // read from it is checked through `isExtractedLeaf` before its value is
  // believed, so a wrong shape cannot survive as a committed read.
  const entry = (fields as Record<string, unknown>)[group.key];
  // A collection's slot is the instance's element of the group's array; a
  // singleton's is the group entry itself — the same places the merge reads
  // the draft's fields from when it spreads them forward.
  const slot = group.isCollection
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
 * The fill phase: derive one job per `(group, piece, instance)` from the
 * inventory's settled roster, make each job's one chat call, and recombine the
 * outcomes into the draft. See the file header for the shape of each member.
 */
export function fillPhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: FillPhaseOptions<V, P>,
): Phase<V, P> {
  const def: PhaseDef<V, P, FillJob, Record<string, unknown>> = {
    id: options.id ?? "fill",
    // Unioned, never replaced — a caller can only add ordering, never subtract
    // it. See `FillPhaseOptions.requires` for why the roster key is not a
    // configuration choice.
    requires: [...new Set([rosterNoteKey, ...(options.requires ?? [])])],
    // The merge assembles the roster-derived envelopes into `fields` — so a phase
    // whose follow-ups read the draft stands on this one, declared through the
    // marker key the engine verifies against what the merge really wrote.
    produces: [draftSeededNoteKey],
    describeItem: (item) => ({
      key: item.group.key,
      instance: item.instanceIndex + 1,
      instances: item.instances,
      part: (item.group.part ?? 0) + 1,
      parts: item.group.parts ?? 1,
    }),
    plan: (draft, ctx) => {
      const roster: Roster = draft.notes.get(rosterNoteKey) ?? {};
      const transcript = ctx.transcript.text;
      const jobs: FillJob[] = [];

      for (const group of options.prepared) {
        if (!group.isCollection || group.key === "") {
          // Narrowing first, before any prompt is built: a job whose leaves
          // are all committed in the draft is work already done (see
          // `narrowToAbstained`). The slot for this branch is the group entry
          // itself, at the job's instance 0.
          if (options.narrowToAbstained && jobFullyCommitted(draft.fields, group, 0)) continue;
          // Singleton or non-grouped fallback: one fill call per piece, no
          // scope semantics. The roster is not consulted — the singleton
          // branch ran before any roster interpretation today, and a stated
          // -none shape under a singleton key is ignored.
          const scope = singletonFillScope(group.key || "fields");
          const messages =
            group.key === ""
              ? buildMessages(options.target, transcript)
              : buildFillMessages(
                  options.target,
                  group.key,
                  0,
                  scope,
                  transcript,
                  options.buildFillInstructions,
                  group.leafKeys,
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
          // Narrowing first, before any prompt is built — see the singleton
          // branch above. The granularity is the job: one uncommitted leaf
          // plans the whole job, because leaf-level narrowing is gap-fill's.
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
      // THE CAST, and why it is sound: the merge writes whole group entries by
      // dynamic key — assembled envelopes and merged pieces — which the deep
      // partial's mapped type cannot index by a runtime string. Every write is
      // a value the closing parse validates against the full extraction
      // schema, so a wrong shape cannot survive the run.
      const groupResult: Record<string, unknown> = {
        ...(draft.fields as Record<string, unknown>),
      };
      const collectionArrays: Record<string, unknown[]> = {};

      for (const outcome of outcomes) {
        // An error outcome carries no contribution. The phase runs under abort
        // semantics — its failures reject out of `run` before `merge` — so this
        // arm is unreachable through the engine, and skipped rather than
        // invented around here.
        if (outcome.outcome !== "result") continue;
        const job = outcome.item;
        const value = outcome.output.value[job.group.key];

        if (job.group.isCollection) {
          // The array is built here, in the merge that fills it — the
          // inventory merge deliberately does not allocate it (a group with
          // current candidates is not seeded). One slot per current
          // candidate, indexed by the job's instanceIndex, never by arrival
          // order. The base is the DRAFT's entry for the key when it holds
          // one — the merge starts from `{ ...draft.fields }` for every other
          // shape, and a narrowed fill's skipped jobs are exactly the slots a
          // fresh array would blank.
          const draftArray = groupResult[job.group.key];
          const arr =
            collectionArrays[job.group.key] ??
            (collectionArrays[job.group.key] = Array.isArray(draftArray)
              ? (draftArray as unknown[]).slice()
              : new Array<unknown>(job.instances));
          // A slot already holding a value means an earlier piece of the SAME
          // partitioned group already contributed its leaf subset for this
          // instance — recombine via mergeGroupPieces (the per-group extractor's
          // own recombination) rather than letting the last piece overwrite the
          // rest. Jobs for one key are issued in piece order and `mapWithPool`
          // preserves it, so the merge sees the pieces in the order issued.
          const existing = arr[job.instanceIndex];
          arr[job.instanceIndex] =
            existing === undefined ? value : mergeGroupPieces(existing, value);
        } else {
          const key = job.group.key;
          groupResult[key] = key in groupResult ? mergeGroupPieces(groupResult[key], value) : value;
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
        // The marker the phase declares in `produces`, written so the engine's
        // boundary check sees the declaration honoured. Unconditional: a merge
        // that planned no jobs never runs (the engine skips an empty plan), so
        // reaching this line means fields were assembled.
        notes: draft.notes.set(draftSeededNoteKey, true),
      };
    },
  };
  return phaseBuilder<V, P>()(def);
}
