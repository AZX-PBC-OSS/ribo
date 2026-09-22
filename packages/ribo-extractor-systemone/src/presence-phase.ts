/**
 * @file The System One presence phase — every leaf of every group asked in ONE
 * batched request, as a `Phase` the phased engine runs first. A sibling of
 * core's `presencePhase` (one call per group over a chat transport): the same
 * three shapes, asked differently, because a System One model answers many
 * independent questions in a single request.
 *
 * This is a copy of core's mechanics, not a reimplementation of them: the
 * schema walk ({@link extractGroups}), the seed envelopes
 * ({@link nullEnvelope}), the array wrap ({@link wrapGroupEntry}) and the note
 * key ({@link presenceNoteKey}) all come from core, which exports them because
 * a presence phase implemented outside core must behave exactly like the
 * built-in one. The three behaviours core's file header calls contractual are
 * reproduced here:
 *
 * - **`plan` is never empty.** Presence decides what everything else looks at,
 *   so it has nothing to narrow against — the plan covers every leaf of every
 *   group, batched, regardless of the draft.
 * - **`merge` seeds every group with a full null envelope — for FAILED items
 *   as well as successful ones — in addition to storing the boolean map under
 *   `presenceNoteKey`.** The engine skips `merge` entirely on an empty plan, so
 *   without the seed a group whose map is all-false is MISSING from the fields,
 *   and the closing trust-boundary parse rejects the whole result
 *   (`enveloped()` strips top-level `.optional()` and rebuilds with
 *   `z.strictObject`, so every group key is required).
 * - **A collection group's entry is wrapped as an array, an object group's is
 *   not** — through {@link wrapGroupEntry}, never built inline.
 */

import { z } from "zod";

import {
  extractGroups,
  nullEnvelope,
  phaseBuilder,
  presenceNoteKey,
  wrapGroupEntry,
} from "@azx/ribo-core";
import type {
  DeepPartial,
  Enveloped,
  Group,
  Leaf,
  NoProvenance,
  Phase,
  PhaseDef,
  PresenceMaps,
} from "@azx/ribo-core";
import { noul } from "@azx/ribo-systemone-managed";
import type { NoulQuestion, SystemOneClient } from "@azx/ribo-systemone-managed";

/**
 * The default present threshold — deliberately LOW, not the natural 0.5
 * midpoint. The two answer populations (leaves the transcript discusses and
 * leaves it does not) overlap, so no threshold separates them, and the error
 * costs are asymmetric: a false negative is unrecoverable, because every later
 * phase only looks at leaves presence marked true, so a dropped leaf is silent
 * data loss — while a false positive costs one wasted question downstream.
 * Where a measured boundary has been established, it has sat exactly ON the
 * lowest correctly-present leaf — no margin at all — so the default keeps a
 * margin BELOW that boundary rather than on it, erring toward recall with the
 * cheapest currency there is.
 */
export const DEFAULT_PRESENCE_THRESHOLD = 0.2;

/** Options for {@link systemOnePresencePhase}. */
export interface SystemOnePresencePhaseOptions {
  /** The System One client to ask — the host's proxied, credential-attaching one. */
  readonly client: SystemOneClient;
  /** The extraction schema, walked once at construction into groups and leaves. */
  readonly schema: z.ZodType;
  /**
   * Overrides the phase's id — `"presence"` by default, matching core's
   * presence phase so a System One phase can stand in for one without renaming
   * the `requires` that point at it. See `PhaseMeta.id` in `@azx/ribo-core`
   * for what an id reaches and why a caller-chosen one is safe.
   */
  readonly id?: string;
  /**
   * The minimum probability of "yes" a leaf's answer must reach to count as
   * present. Defaults to {@link DEFAULT_PRESENCE_THRESHOLD}.
   */
  readonly threshold?: number;
  /**
   * The most leaves one request carries. Unset means every leaf of every
   * group in one call — the client batches internally anyway.
   */
  readonly batchSize?: number;
  /**
   * Ids of the phases this phase must follow. The phase declares none of its
   * own — it runs first — so the list is exactly what you pass (ADR 0008).
   */
  readonly requires?: readonly string[];
}

/** One leaf in a batch, carrying the group its answer files under. */
interface PresenceEntry {
  readonly group: Group;
  readonly leaf: Leaf;
}

/** One batch of leaves — the work item `plan` emits and `run` asks in one call. */
interface PresenceBatch {
  readonly entries: readonly PresenceEntry[];
}

/**
 * The presence question for one leaf. The path stands alone — a batch spans
 * groups, so there is no per-group prompt to give the leaf a context.
 */
const presenceInstructions = (leaf: Leaf): string =>
  `Is the field "${leaf.path}" discussed in the transcript? ` +
  "Answer yes if the transcript explicitly discusses the field, no if it is not " +
  "mentioned, only implied, or unrelated. A field merely implied is no.";

/**
 * The System One presence phase: every leaf of every group asked in one
 * batched request, thresholded per leaf into core's presence map. See the file
 * header for the three behaviours reproduced from core's phase — the plan, the
 * seed and the wrap.
 */
export function systemOnePresencePhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: SystemOnePresencePhaseOptions,
): Phase<V, P> {
  const jsonSchema = z.toJSONSchema(options.schema, { target: "draft-2020-12" });
  const groups = extractGroups(jsonSchema);
  // The same refusal the on-device preset makes: a zero-group walk would make
  // `plan` empty — and this is the one phase whose plan is never empty — while
  // the closing parse rejects the missing keys. A wiring error, surfaced at
  // construction before any call is made.
  if (groups.length === 0) {
    throw new Error("systemOnePresencePhase: no groups found in extraction schema");
  }
  const threshold = options.threshold ?? DEFAULT_PRESENCE_THRESHOLD;
  // The batching is fixed at construction — the walk is too — so `plan` stays
  // synchronous and pure: it only hands back the batches already built.
  const entries: PresenceEntry[] = [];
  for (const group of groups) {
    for (const leaf of group.leaves) entries.push({ group, leaf });
  }
  const size = options.batchSize === undefined ? entries.length : Math.max(1, options.batchSize);
  const batches: PresenceBatch[] = [];
  for (let start = 0; start < entries.length; start += size) {
    batches.push({ entries: entries.slice(start, start + size) });
  }

  const def: PhaseDef<V, P, PresenceBatch, Record<string, boolean>> = {
    id: options.id ?? "presence",
    onItemFailure: "skip",
    // The caller's ids are the whole `requires` — the phase declares none of
    // its own (see the option); an absent option leaves the def's `requires`
    // unset.
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    plan: () => batches,
    run: async (item, _draft, ctx) => {
      const questions: Record<string, NoulQuestion> = {};
      for (const { leaf } of item.entries) {
        questions[leaf.path] = noul(presenceInstructions(leaf));
      }
      const answers = await options.client.ask(ctx.transcript.text, questions, {
        // Forwarded, not rebuilt: the context's signal is the caller's
        // cancellation and the deadline the caller's time budget — a dropped
        // forward strands both silently.
        signal: ctx.signal,
        deadline: ctx.deadline,
      });
      const value: Record<string, boolean> = {};
      for (const { leaf } of item.entries) {
        const answer = answers[leaf.path];
        if (answer === undefined) {
          // A sent question came back unanswered — an attempt failure, retried
          // by the engine like any other transient error.
          throw new Error(`systemOnePresencePhase: no answer for leaf ${leaf.path}`);
        }
        value[leaf.path] = answer.noul >= threshold;
      }
      return { value, usage: { calls: 1 } };
    },
    merge: (draft, outcomes) => {
      const maps: PresenceMaps = {};
      for (const outcome of outcomes) {
        // A failed batch contributes no map entries; its leaves are nulled by
        // the seed below, which covers every group — successful, failed, and
        // absent alike.
        if (outcome.outcome !== "result") continue;
        for (const { group, leaf } of outcome.item.entries) {
          const present = outcome.output.value[leaf.path];
          // A run result missing one of its own item's leaves is a phase bug —
          // `run` answers every question or throws. Fail loudly rather than
          // seed a silent false into the map, which is the harm this phase
          // exists to prevent.
          if (present === undefined) {
            throw new Error(
              `systemOnePresencePhase: a result outcome carries no leaf ${leaf.path}`,
            );
          }
          const map = maps[group.key] ?? (maps[group.key] = {});
          map[leaf.key] = present;
        }
      }

      // THE SEED, and why it is unconditional: this is the only phase whose plan
      // is never empty, so this merge is the only one that can promise the
      // closing parse a complete key set. See the file header.
      // THE CAST, and why it is sound: the merge writes whole group entries by
      // dynamic key — null-filled leaf-envelope maps, wrapped or bare — which
      // the deep partial's mapped type cannot index by a runtime string. Every
      // write is a value the closing parse validates against the full extraction
      // schema, so a wrong shape cannot survive the run.
      const fields = { ...(draft.fields as Record<string, unknown>) };
      for (const group of groups) {
        const entry: Record<string, ReturnType<typeof nullEnvelope>> = {};
        for (const leaf of group.leaves) {
          entry[leaf.key] = nullEnvelope();
        }
        fields[group.key] = wrapGroupEntry(group, entry);
      }

      return {
        ...draft,
        fields: fields as DeepPartial<Enveloped<V, P>>,
        // Written unconditionally — a later phase's plan reads this key and
        // demands it, so even a fully-failed presence pass must write it.
        notes: draft.notes.set(presenceNoteKey, maps),
      };
    },
  };
  return phaseBuilder<V, P>()(def);
}
