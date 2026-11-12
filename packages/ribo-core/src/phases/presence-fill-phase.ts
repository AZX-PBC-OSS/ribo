/**
 * @file The presence-narrowed fill phase — one value-extraction call per group
 * the presence map marked with at least one present leaf, as a `Phase` the
 * phased engine runs after a presence phase.
 *
 * This is the managed-path narrowing ADR 0027 licenses, on the shape of core's
 * `spanPhase` (the on-device strategy's narrowing pass) and built from
 * `perGroupPlan`'s per-piece construction:
 *
 * - **`plan` reads the presence note and returns one item per PIECE of every
 *   group that has at least one present leaf.** A group whose leaves are all
 *   absent yields no item and therefore no call. That is only sound because
 *   the presence phase SEEDED every group key into the draft with a full null
 *   envelope: the closing parse requires every top-level key, and a skipped
 *   group survives it on the seed's work, not this phase's (ADR 0027,
 *   narrowing ADR 0009's rejection of unseeded scoping). Hence the
 *   `requires: ["presence"]` declaration — a narrowing phase that does not
 *   name its seeder is the bug the ADR warns surfaces far away, at the parse.
 * - **`plan` splits each group's NARROWED schema under the same caps
 *   `perGroupPlan` packs against** (`splitExtractionSchema`, one call): the
 *   active leaf subset is known once the presence note is read, and a narrowed
 *   group whose projected schema exceeds a cap is partitioned into pieces
 *   exactly as `perGroupPlan` would partition that group — one item per piece,
 *   so an over-cap call the per-group path would never send is never sent here
 *   either. Narrowing happens FIRST, so a group with few present leaves still
 *   costs one call.
 * - **`run` is `perGroupPlan`'s piece construction, built per item**: a
 *   {@link singleShotExtractor} over a {@link projectTarget}-projected target,
 *   narrowed to the piece's leaf subset, with the plan's `-<part>` name suffix
 *   on a partitioned piece. A collection group is asked for its ARRAY: presence
 *   decides which leaves, never how many instances, so a singleton call would
 *   silently drop every appliance after the first (spike 0012).
 * - **`merge` writes the returned leaf envelopes over the seed, per group**:
 *   a group's pieces are disjoint leaf subsets, so a flat group's envelopes
 *   assign into the entry the seed created, through `writableGroupEntry`, and
 *   a collection's piece arrays zip by instance index — each piece carries
 *   every instance's share of the leaves. Inactive leaves are null in every
 *   instance. An empty answer leaves the seed's null instance in place. A
 *   failed piece nulls only its own leaves — the seed's floor, restated so the
 *   merge stays total — and `onItemFailure: "skip"` makes that a per-piece
 *   outcome, never a failed run.
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
import type { Group } from "./presence-phase.js";
import { phaseBuilder } from "./phase.js";
import type { Phase, PhaseDef } from "./phase.js";
import type { ChatClient } from "./chat-client.js";
import type { DeepPartial } from "./phase-draft.js";
import type { Enveloped, NoProvenance } from "../provenance/enveloped.js";
import type { ExtractionTarget } from "../extraction/extractor.js";

import { assertWireSafeSchemaName } from "../extraction/extraction-common.js";
import { projectTarget } from "../extraction/project-target.js";
import { singleShotExtractor } from "../extraction/single-shot.js";
import {
  MAX_NULLABLE_UNIONS_PER_CALL,
  splitExtractionSchema,
} from "../extraction/schema/split-schema.js";
import type { ExtractionGroup } from "../extraction/schema/split-schema.js";
import { partitionedLeafKeys } from "../extraction/strategies/per-group.js";

/**
 * The leaf-envelope map one fill call returns — the single instance's leaves.
 * `ReturnType<typeof nullEnvelope>` rather than a named import: core exports
 * the constructor, and this is its type.
 */
type LeafEnvelopes = Record<string, ReturnType<typeof nullEnvelope>>;

/**
 * Options for {@link presenceFillPhase}.
 *
 * @category Extraction
 */
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
   * Max nullable unions per fill call before a group's narrowed schema is
   * partitioned across multiple calls, exactly as `perGroupPlan` partitions
   * under {@link splitExtractionSchema}'s `maxNullableUnionsPerGroup`. Defaults
   * to {@link MAX_NULLABLE_UNIONS_PER_CALL}, the same default the per-group
   * plan applies — see `PerGroupOptions.maxNullableUnionsPerGroup` for the
   * unit (unions, not leaves) and why the caller tunes the number.
   */
  readonly maxNullableUnionsPerGroup?: number;
  /**
   * Max serialized JSON Schema characters per fill call, passed through to
   * {@link splitExtractionSchema}'s byte cap — see `SplitOptions` for why the
   * caller, not the library, supplies the number. Omitted, the split packs
   * against the union cap alone. Narrowing runs FIRST, so a group whose active
   * leaves fit one call is never partitioned. A leaf that cannot fit any piece
   * under the caps is refused at construction — the all-present split is
   * rehearsed there, so the refusal never lands mid-run after the presence
   * calls are paid for.
   */
  readonly maxSerializedCharsPerGroup?: number;
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
   * ADR 0008 and ADR 0027.
   */
  readonly requires?: readonly string[];
}

interface PresenceFillItem {
  readonly group: Group;
  /**
   * One piece of the group's narrowed schema, from {@link splitExtractionSchema}
   * under the caps — an unpartitioned group's single piece carries no
   * `part`/`parts` and reads back as the whole active-leaf set.
   */
  readonly piece: ExtractionGroup;
}

/**
 * The presence-narrowed fill phase: one value-extraction call per group with
 * present leaves, over the group's projected target narrowed to those leaves.
 * See the file header for the seeding that makes the narrowing sound.
 * @category Extraction
 */
export function presenceFillPhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: PresenceFillPhaseOptions<V, P>,
): Phase<V, P> {
  const { target, groups, chat, model, maxTokens, groupInstructions } = options;
  const id = options.id ?? "fill";
  // `perGroupPlan`'s defaulting, mirrored: the union cap is always on, the
  // byte cap only when the caller supplies it.
  const maxNullableUnionsPerGroup =
    options.maxNullableUnionsPerGroup ?? MAX_NULLABLE_UNIONS_PER_CALL;
  const { maxSerializedCharsPerGroup } = options;

  /**
   * The split one group's active-leaf projection packs into, under the caps —
   * the same splitter, on exactly the one-key shape `run` pins each call to,
   * so an all-present group's pieces ARE the pieces `perGroupPlan` would
   * partition that group into.
   */
  const splitGroup = (group: Group, leafKeys: readonly string[]): readonly ExtractionGroup[] => {
    const key = group.key as keyof V & string;
    const narrowed = projectTarget<V, P, typeof key>(target, key, {
      leafKeys,
      singleton: false,
    });
    return splitExtractionSchema(narrowed.extractionSchema, {
      maxNullableUnionsPerGroup,
      ...(maxSerializedCharsPerGroup === undefined ? {} : { maxSerializedCharsPerGroup }),
    });
  };

  // The structured-output name every group's call would carry, guarded where
  // `perGroupPlan` guards it — at construction, where the schema author is
  // present, not at the route as a 400 that reads identically to an over-cap
  // schema. Guarding all of them covers a group before presence marks any
  // leaf present, which is the cheaper failure than discovering it mid-run.
  // The split is rehearsed here too, over every leaf of every group: the
  // splitter's refusal (a single leaf that cannot fit any piece under the
  // caps) is per-leaf, and a subset of the leaves can only pack into fewer or
  // finer pieces, never an unsplittable one — so a construction that passes
  // this all-present worst case cannot throw in `plan`, where the real split
  // runs after the presence calls have been paid for. `perGroupPlan` refuses
  // at construction for the same reason; this is the fill's equivalent.
  for (const group of groups) {
    assertWireSafeSchemaName(`${target.name}-${group.key}`, "presenceFillPhase");
    splitGroup(
      group,
      group.leaves.map((leaf) => leaf.key),
    );
  }

  const def: PhaseDef<V, P, PresenceFillItem, LeafEnvelopes | readonly LeafEnvelopes[]> = {
    id,
    onItemFailure: "skip",
    // REPLACING, not additive: the option is the complete list, and the default
    // names the shipped provider of the note this plan reads — see the option.
    requires: options.requires ?? ["presence"],
    describeItem: (item) => ({
      key: item.group.key,
      ...(item.piece.part === undefined ? {} : { part: item.piece.part, parts: item.piece.parts }),
    }),
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
        // The split runs on the NARROWED schema — the active-leaf projection
        // of exactly the one-key shape `run` pins each call to — through the
        // same splitter `perGroupPlan` partitions with, so an all-present
        // group's pieces ARE the pieces per-group would send. The split is a
        // pure function of the presence note, so it belongs in `plan`: one
        // item per piece keeps failure isolation per call, and the merge
        // regroups the pieces by key.
        for (const piece of splitGroup(
          group,
          activeLeaves.map((leaf) => leaf.key),
        )) {
          items.push({ group, piece });
        }
      }
      return items;
    },
    run: async (item, _draft, ctx) => {
      // The group key arrived as a runtime string off the walk; the extraction
      // schema's shape keys are exactly `keyof V & string`, so the cast names
      // what the walk guarantees — the same move `perGroupPlan` makes per key.
      const key = item.group.key as keyof V & string;
      // The piece's leaf keys, read back out of its own schema so they cannot
      // drift from it — `perGroupPlan`'s read, on the same split.
      const leafKeys = partitionedLeafKeys(item.piece);
      const withGroupPrompt = groupInstructions !== undefined;
      const projected = projectTarget<V, P, typeof key>(target, key, {
        instructions: withGroupPrompt ? groupInstructions(item.group.key) : undefined,
        leafKeys,
        // A collection is asked for its array, so every instance the
        // transcript describes has somewhere to land.
        singleton: false,
      });
      // The piece's name — the plan's `-<part>` suffix on a partitioned piece,
      // and, without group instructions, the target's unprojected examples:
      // both spellings are `perGroupPlan`'s.
      const partSuffix = item.piece.part !== undefined ? `-${item.piece.part}` : "";
      const name = `${target.name}-${item.group.key}${partSuffix}`;
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

      // THE CAST, and why it is sound: a collection group's parsed value is the
      // array of leaf-envelope maps, a flat group's is the map directly — the
      // projection parsed exactly that shape. Every envelope the merge writes is
      // validated against the full extraction schema at the closing parse, so a
      // wrong shape cannot survive the run.
      const value = (result.fields as Record<string, unknown>)[item.group.key] as
        LeafEnvelopes | readonly LeafEnvelopes[];
      return { value, usage: result.usage };
    },
    merge: (draft, outcomes) => {
      // THE CAST, and why it is sound: the merge writes leaf envelopes by
      // dynamic key into group entries the presence seed created, which the
      // deep partial's mapped type cannot index by a runtime string. Every
      // write is a value the closing parse validates against the full
      // extraction schema, so a wrong shape cannot survive the run.
      const fields = { ...(draft.fields as Record<string, unknown>) };

      /** A piece's leaf keys, read back off its own schema so they cannot drift. */
      const pieceLeaves = (item: PresenceFillItem): readonly string[] =>
        partitionedLeafKeys(item.piece);

      // One group at a time: a group's pieces are disjoint leaf subsets of one
      // narrowed schema, and the merge recombines them into the entry the seed
      // created. Pieces arrive in plan order; grouping by key does not rely on
      // that, only on one group's pieces all being present.
      const byKey = new Map<string, typeof outcomes>();
      for (const outcome of outcomes) {
        const existing = byKey.get(outcome.item.group.key);
        byKey.set(outcome.item.group.key, existing ? [...existing, outcome] : [outcome]);
      }

      for (const [groupKey, pieceOutcomes] of byKey) {
        const group = pieceOutcomes[0]!.item.group;

        if (!group.isArray) {
          // A flat group: every successful piece assigns its own leaf envelopes
          // into the seeded entry; a failed piece nulls only its own leaves —
          // which the seed already holds, restated so the merge stays total.
          const entry = writableGroupEntry(group, fields);
          for (const outcome of pieceOutcomes) {
            if (outcome.outcome === "result") {
              Object.assign(entry, outcome.output.value as LeafEnvelopes);
            } else {
              for (const leafKey of pieceLeaves(outcome.item)) entry[leafKey] = nullEnvelope();
            }
          }
          continue;
        }

        // A collection group: each successful piece answered for the ARRAY,
        // every instance's share of its own leaf subset, so the pieces zip by
        // instance index — presence decided which leaves, never how many
        // instances (spike 0012). The longest answer decides the instance
        // count; a shorter piece's missing instances stay at the null floor.
        const successful = pieceOutcomes.filter((o) => o.outcome === "result");
        if (successful.length === 0) {
          // Every piece failed: the group's leaves back to the seed's floor —
          // restated rather than relied on, as a failed merge always was.
          const entry = writableGroupEntry(group, fields);
          for (const leaf of group.leaves) entry[leaf.key] = nullEnvelope();
          continue;
        }
        const answers = successful.map((o) => o.output.value as readonly LeafEnvelopes[]);
        const instanceCount = Math.max(...answers.map((answer) => answer.length));
        // Presence said this group was discussed, so an empty answer is a
        // model miss, not a stated-none: the seed's one null instance stays.
        if (instanceCount === 0) continue;

        fields[groupKey] = Array.from({ length: instanceCount }, (_element, index) => {
          const out: LeafEnvelopes = {};
          for (const leaf of group.leaves) out[leaf.key] = nullEnvelope();
          for (const outcome of successful) {
            const answer = (outcome.output.value as readonly LeafEnvelopes[])[index];
            if (answer === undefined) continue;
            // The projected schema is strict and requires exactly the piece's
            // active leaves, so the fallback is a total-write guard, not an
            // expected arm.
            for (const leafKey of pieceLeaves(outcome.item)) {
              out[leafKey] = answer[leafKey] ?? nullEnvelope();
            }
          }
          return out;
        });
      }

      return {
        ...draft,
        fields: fields as DeepPartial<Enveloped<V, P>>,
      };
    },
  };
  return phaseBuilder<V, P>()(def);
}
