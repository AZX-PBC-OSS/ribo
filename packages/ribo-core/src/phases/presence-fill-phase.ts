/**
 * @file The presence-narrowed fill phase — one value-extraction call per group
 * the presence map marked with at least one present leaf, as a `Phase` the
 * phased engine runs after a presence phase.
 *
 * This is the managed-path narrowing ADR 0028 licenses, on the shape of core's
 * `spanPhase` (the on-device strategy's narrowing pass) and built from
 * `perGroupPlan`'s per-piece construction:
 *
 * - **`plan` reads the presence note and returns one item per group that has
 *   at least one present leaf.** A group whose leaves are all absent yields no
 *   item and therefore no call. That is only sound because the presence phase
 *   SEEDED every group key into the draft with a full null envelope: the
 *   closing parse requires every top-level key, and a skipped group survives
 *   it on the seed's work, not this phase's (ADR 0028, narrowing ADR 0009's
 *   rejection of unseeded scoping). Hence the `requires: ["presence"]`
 *   declaration — a narrowing phase that does not name its seeder is the bug
 *   the ADR warns surfaces far away, at the parse.
 * - **`run` is `perGroupPlan`'s piece construction, built per item**: a
 *   {@link singleShotExtractor} over a {@link projectTarget}-projected target,
 *   narrowed to the active leaf subset. Built in `run` rather than at
 *   construction because the active subset is known only once the presence
 *   note has been read. The projection is singleton: the seed wrapped a
 *   collection group's one instance in a one-element array and the merge
 *   writes into exactly that instance, so the call asks for the element, not
 *   the array — a second instance has nowhere to land, and
 *   `perGroupExtractor` remains the multi-instance strategy.
 * - **`merge` writes the returned leaf envelopes into the group entry the seed
 *   created** — through `writableGroupEntry`, as every merge that writes a
 *   group entry does. Inactive leaves keep the null seed. A failed item nulls
 *   the group's leaves — the seed's floor, restated so the merge stays total —
 *   and `onItemFailure: "skip"` makes that a per-group outcome, never a failed
 *   run.
 *
 * **Transport-agnostic, hence core** (ADR 0010): every import here is the chat
 * seam (`ChatClient`, never `openAiChat`), so this belongs beside
 * `presencePhase`, `spanPhase` and `classifyPhase` rather than in a
 * vendor-named package. The preset that composes it with a presence phase is
 * NOT here — ADR 0010 left `threePhaseExtractor` out of core for the same
 * reason, and a preset is a wiring choice.
 */

import { demandNote } from "./phase-notes.js";
import { nullEnvelope, presenceNoteKey, writableGroupEntry } from "./presence-phase.js";
import type { Group, Leaf } from "./presence-phase.js";
import { phaseBuilder } from "./phase.js";
import type { Phase, PhaseDef } from "./phase.js";
import type { ChatClient } from "./chat-client.js";
import type { DeepPartial } from "./phase-draft.js";
import type { Enveloped, NoProvenance } from "../provenance/enveloped.js";
import type { ExtractionTarget } from "../extraction/extractor.js";

import { assertWireSafeSchemaName } from "../extraction/extraction-common.js";
import { projectTarget } from "../extraction/project-target.js";
import { singleShotExtractor } from "../extraction/single-shot.js";

/**
 * The leaf-envelope map one fill call returns — the single instance's leaves.
 * `ReturnType<typeof nullEnvelope>` rather than a named import: core exports
 * the constructor, and this is its type.
 */
type LeafEnvelopes = Record<string, ReturnType<typeof nullEnvelope>>;

/** Options for {@link presenceFillPhase}. */
export interface PresenceFillPhaseOptions<V extends Record<string, unknown>, P = NoProvenance> {
  /** The field knowledge: each item's projected target is derived from it. */
  readonly target: ExtractionTarget<V, P>;
  /**
   * The walked groups — the same `extractGroups` walk the presence phase was
   * handed, so the fill asks about exactly the groups presence mapped.
   */
  readonly groups: readonly Group[];
  /** The injected chat transport. A fake in tests; `openAiChat` in production. */
  readonly chat: ChatClient;
  /** The model id passed through to the endpoint (e.g. the Helix-routed model). */
  readonly model: string;
  /**
   * Cap on generated tokens, passed through to each call. See
   * `SingleShotOptions.maxTokens` for the rationale for transport
   * configuration living on the extractor.
   */
  readonly maxTokens?: number;
  /**
   * Per-group instructions assembly, mirrored from `perGroupPlan`: when
   * provided, each group's call gets the instructions returned by
   * `groupInstructions(groupKey)` instead of the target's full `instructions`,
   * and each few-shot example is projected to the group's key (narrowed to the
   * active leaves). When omitted, every call uses `target.instructions` and
   * the unprojected examples — the per-group plan's behaviour in that mode.
   */
  readonly groupInstructions?: (groupKey: string) => string;
  /**
   * Overrides the phase's id — `"fill"` by default. See `PhaseMeta.id` in
   * `@azx/ribo-core` for what an id reaches and why a caller-chosen one is safe.
   */
  readonly id?: string;
  /**
   * Ids of the phases this one must follow, REPLACING the default
   * `["presence"]` — the complete list, not an addition. The default names the
   * shipped provider of the presence note this phase's `plan` reads; overriding
   * it means naming that provider yourself (a renamed presence phase:
   * `presenceFillPhase({ requires: ["presence-strict"] })`), or validation
   * fails on a dangling id. See `PhaseMeta.requires` in `@azx/ribo-core`,
   * ADR 0008 and ADR 0028.
   */
  readonly requires?: readonly string[];
}

interface PresenceFillItem {
  readonly group: Group;
  /** Only the leaves the presence map marked present — the narrowing is the point. */
  readonly activeLeaves: readonly Leaf[];
}

/**
 * The presence-narrowed fill phase: one value-extraction call per group with
 * present leaves, over the group's projected target narrowed to those leaves.
 * See the file header for the seeding that makes the narrowing sound.
 */
export function presenceFillPhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: PresenceFillPhaseOptions<V, P>,
): Phase<V, P> {
  const { target, groups, chat, model, maxTokens, groupInstructions } = options;
  const id = options.id ?? "fill";

  // The structured-output name every group's call would carry, guarded where
  // `perGroupPlan` guards it — at construction, where the schema author is
  // present, not at the route as a 400 that reads identically to an over-cap
  // schema. Guarding all of them covers a group before presence marks any
  // leaf present, which is the cheaper failure than discovering it mid-run.
  for (const group of groups) {
    assertWireSafeSchemaName(`${target.name}-${group.key}`, "presenceFillPhase");
  }

  const def: PhaseDef<V, P, PresenceFillItem, LeafEnvelopes> = {
    id,
    onItemFailure: "skip",
    // REPLACING, not additive: the option is the complete list, and the default
    // names the shipped provider of the note this plan reads — see the option.
    requires: options.requires ?? ["presence"],
    describeItem: (item) => ({ key: item.group.key }),
    plan: (draft) => {
      // A phase that reads a note demands it: defaulting here would make a
      // mis-wired list a silent wrong answer — nothing planned, the run returns
      // the all-null floor the seed wrote, and the closing parse is green.
      const maps = demandNote(draft.notes, presenceNoteKey, id, "presence");
      const items: PresenceFillItem[] = [];
      for (const group of groups) {
        const map = maps[group.key];
        // A group whose presence item FAILED has no map in the note: it plans
        // nothing here and stays at the null floor the seed wrote.
        const activeLeaves = group.leaves.filter((leaf) => map?.[leaf.key] === true);
        if (activeLeaves.length === 0) continue;
        items.push({ group, activeLeaves });
      }
      return items;
    },
    run: async (item, _draft, ctx) => {
      // The group key arrived as a runtime string off the walk; the extraction
      // schema's shape keys are exactly `keyof V & string`, so the cast names
      // what the walk guarantees — the same move `perGroupPlan` makes per key.
      const key = item.group.key as keyof V & string;
      const withGroupPrompt = groupInstructions !== undefined;
      const projected = projectTarget<V, P, typeof key>(target, key, {
        instructions: withGroupPrompt ? groupInstructions(item.group.key) : undefined,
        leafKeys: item.activeLeaves.map((leaf) => leaf.key),
        singleton: true,
      });
      // The plan's unpartitioned piece name — and, without group instructions,
      // its unprojected examples: both spellings are `perGroupPlan`'s.
      const name = `${target.name}-${item.group.key}`;
      const pieceTarget = withGroupPrompt
        ? { ...projected, name }
        : { ...projected, name, examples: target.examples };

      const entry = singleShotExtractor({ target: pieceTarget, chat, model, maxTokens });
      const result = await entry.extract(ctx.transcript, {
        // Forwarded, not rebuilt: the phase context's signal is the caller's
        // cancellation combined with the phase pool's sibling abort, and a
        // dropped forward would strand cancellation silently.
        signal: ctx.signal,
      });

      // THE CAST, and why it is sound: under the singleton projection a
      // collection group's parsed value is the ELEMENT — the leaf-envelope map —
      // while the projected target's type still names the array; a flat group's
      // is the map directly. Every envelope the merge writes is validated
      // against the full extraction schema at the closing parse, so a wrong
      // shape cannot survive the run.
      const value = (result.fields as Record<string, unknown>)[item.group.key] as LeafEnvelopes;
      return { value, usage: result.usage };
    },
    merge: (draft, outcomes) => {
      // THE CAST, and why it is sound: the merge writes leaf envelopes by
      // dynamic key into group entries the presence seed created, which the
      // deep partial's mapped type cannot index by a runtime string. Every
      // write is a value the closing parse validates against the full
      // extraction schema, so a wrong shape cannot survive the run.
      const fields = { ...(draft.fields as Record<string, unknown>) };

      for (const outcome of outcomes) {
        const { group, activeLeaves } = outcome.item;
        const entry = writableGroupEntry(group, fields);

        if (outcome.outcome !== "result") {
          // A failed item nulls that group's leaves — the seed's floor,
          // restated rather than relied on: `writableGroupEntry` creates a
          // fresh entry when absent, and a merge that only skipped would leave
          // that fresh entry empty rather than nulled.
          for (const leaf of group.leaves) {
            entry[leaf.key] = nullEnvelope();
          }
          continue;
        }

        for (const leaf of activeLeaves) {
          // The projected schema is strict and requires exactly the active
          // leaves, so the fallback is a total-write guard, not an expected arm.
          entry[leaf.key] = outcome.output.value[leaf.key] ?? nullEnvelope();
        }
      }

      return {
        ...draft,
        fields: fields as DeepPartial<Enveloped<V, P>>,
      };
    },
  };
  return phaseBuilder<V, P>()(def);
}
