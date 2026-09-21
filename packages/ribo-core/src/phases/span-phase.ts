/**
 * @file The span phase of the three-phase on-device strategy — one call per
 * group WITH present leaves, asking for a verbatim quote per active leaf, as a
 * `Phase` the phased engine runs after presence.
 *
 * This is the second quarter of the `threePhaseExtractor` port (design
 * `phased-extraction-design.md` §4.7): the prompt builder and response parser
 * moved here from the monolith unchanged, and the narrowing is the first real
 * one of the strategy.
 *
 * - **`plan` reads the presence map and returns one item per group that has at
 *   least one present leaf.** A group whose leaves are all absent yields no item
 *   and therefore no call — today's `activeLeaves.length === 0` early-out
 *   expressed as planning rather than as a branch. A group whose presence item
 *   FAILED has no map in the note, plans nothing, and stays at the null floor
 *   presence's seed wrote.
 * - **`merge` applies `isSpanGrounded` against the transcript** — today's
 *   unconditional grounding drop, which the measurement behind this strategy
 *   credits with taking source-span fidelity to 100% — and stores the
 *   **surviving** spans in `notes` for classify to plan from. A failed item
 *   nulls that group's leaves, spans included.
 *
 * The transcript rides on the item because `merge` — which grounds the spans —
 * has no phase context to read it from (the same shape `gap-fill-phase.ts`
 * uses). It is the same string `ctx.transcript.text` hands the run.
 *
 * Since SP4a wave 5 this file lives in core beside `presence-phase.ts` (same
 * move, same reason): nothing here is on-device.
 */

import type { CapableChatClient, ChatMessage } from "./chat-client.js";
import type { Enveloped, NoProvenance } from "../provenance/enveloped.js";
import { isSpanGrounded } from "../provenance/provenance.js";
import { demandNote, noteKey } from "./phase-notes.js";
import type { NoteKey } from "./phase-notes.js";
import type { DeepPartial } from "./phase-draft.js";
import type { Phase, PhaseDef } from "./phase.js";
import { phaseBuilder } from "./phase.js";

import {
  chatRequest,
  nullEnvelope,
  presenceNoteKey,
  isSchemaNode,
  writableGroupEntry,
} from "./presence-phase.js";
import type { Group, JsonSchema, Leaf } from "./presence-phase.js";

/**
 * Which leaves survived grounding, per group: group key → leaf key → span. Only
 * grounded spans are stored, so classify's plan is exactly the grounded-leaf
 * list; a group with no entry (failed or all-ungrounded) plans nothing.
 */
export type SpanMaps = Record<string, Record<string, string>>;

/** The note key {@link spanPhase}'s merge writes and the classify phase's plan reads. */
export const spansNoteKey: NoteKey<SpanMaps> = noteKey("three-phase-spans");

/** Options for {@link spanPhase}. */
export interface SpanPhaseOptions {
  /** The walked groups — the preset walks the schema once, at its construction. */
  readonly groups: readonly Group[];
  /** The on-device chat transport. */
  readonly chat: CapableChatClient;
  /** The model id passed through to each request. The transport ignores it. */
  readonly model: string;
  /**
   * Overrides the phase's id — `"span"` by default. See `PhaseMeta.id` in
   * `@azx/ribo-core` for what an id reaches and why a caller-chosen one is safe.
   */
  readonly id?: string;
  /**
   * Ids of the phases this one must follow, REPLACING the default
   * `["presence"]` — the complete list, not an addition. The default names the
   * shipped provider of the presence note this phase's `plan` reads; overriding
   * it means naming that provider yourself (a renamed presence phase:
   * `spanPhase({ requires: ["presence-strict"] })`), or validation fails on a
   * dangling id. See `PhaseMeta.requires` in `@azx/ribo-core` and ADR 0008.
   */
  readonly requires?: readonly string[];
}

interface SpanItem {
  readonly group: Group;
  /** Only the leaves the presence map marked present — the narrowing is the point. */
  readonly activeLeaves: readonly Leaf[];
  /** The transcript text, carried for `merge`'s grounding check. */
  readonly transcript: string;
}

/**
 * The span phase: one verbatim-quote call per group with present leaves, then a
 * grounding filter over the answers. See the file header for the narrowing and
 * the drop.
 */
export function spanPhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: SpanPhaseOptions,
): Phase<V, P> {
  const id = options.id ?? "span";
  const def: PhaseDef<V, P, SpanItem, Record<string, string | null>> = {
    id,
    onItemFailure: "skip",
    // REPLACING, not additive: the option is the complete list, and the default
    // names the shipped provider of the note this plan reads — see the option.
    requires: options.requires ?? ["presence"],
    describeItem: (item) => ({ key: item.group.key }),
    plan: (draft, ctx) => {
      // A phase that reads a note demands it: defaulting here would make a
      // mis-wired list a silent wrong answer — nothing planned, the run returns
      // the all-null floor, and the closing parse is green.
      const maps = demandNote(draft.notes, presenceNoteKey, id, "presence");
      const items: SpanItem[] = [];
      for (const group of options.groups) {
        const map = maps[group.key];
        const activeLeaves = group.leaves.filter((leaf) => map?.[leaf.key] === true);
        if (activeLeaves.length === 0) continue;
        items.push({ group, activeLeaves, transcript: ctx.transcript.text });
      }
      return items;
    },
    run: async (item, _draft, ctx) => {
      const request = chatRequest(
        options.model,
        buildSpanMessages(item.group, item.activeLeaves, item.transcript),
        buildSpanSchema(item.activeLeaves),
        `${item.group.key}-spans`,
      );
      const completion = await options.chat.complete(request, {
        // Forwarded, not rebuilt: the phase context's signal is the caller's
        // cancellation combined with the phase pool's sibling abort, and a
        // dropped forward would strand cancellation silently.
        signal: ctx.signal,
      });
      return {
        value: parseSpanResponse(completion.content, item.activeLeaves),
        usage: { calls: 1 },
      };
    },
    merge: (draft, outcomes) => {
      const surviving: SpanMaps = {};
      // THE CAST, and why it is sound: the merge writes leaf envelopes by
      // dynamic key into group entries presence's seed created, which the deep
      // partial's mapped type cannot index by a runtime string. Every write is
      // a value the closing parse validates against the full extraction schema,
      // so a wrong shape cannot survive the run.
      const fields = { ...(draft.fields as Record<string, unknown>) };

      for (const outcome of outcomes) {
        const { group, activeLeaves, transcript } = outcome.item;
        const groupSpans: Record<string, string> = {};
        surviving[group.key] = groupSpans;
        const entry = writableGroupEntry(group, fields);

        if (outcome.outcome !== "result") {
          // A failed item nulls that group's leaves — spans included, so a
          // failed span call cannot leave a citation the value no longer backs.
          for (const leaf of group.leaves) {
            entry[leaf.key] = nullEnvelope();
          }
          continue;
        }

        for (const leaf of activeLeaves) {
          const span = outcome.output.value[leaf.key] ?? null;
          if (span !== null && isSpanGrounded(span, transcript)) {
            groupSpans[leaf.key] = span;
            entry[leaf.key] = { value: null, confidence: 0, sourceSpan: span };
          } else {
            // Absent or ungrounded: null the leaf unconditionally.
            entry[leaf.key] = nullEnvelope();
          }
        }
      }

      return {
        ...draft,
        fields: fields as DeepPartial<Enveloped<V, P>>,
        notes: draft.notes.set(spansNoteKey, surviving),
      };
    },
  };
  return phaseBuilder<V, P>()(def);
}

function buildSpanSchema(leaves: readonly Leaf[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const leaf of leaves) {
    properties[leaf.key] = { anyOf: [{ type: "string" }, { type: "null" }] };
  }
  return {
    type: "object",
    properties,
    required: leaves.map((leaf) => leaf.key),
    additionalProperties: false,
  };
}

function buildSpanMessages(
  group: Group,
  leaves: readonly Leaf[],
  transcript: string,
): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `Extract verbatim quotes from the auditor's spoken field notes for the ${group.key} group.\n\n` +
        `For each field listed below, return the exact contiguous quote from the transcript that discusses ` +
        `that field, or null if the transcript does not mention it. Inventing a quote is worse than returning null.\n\n` +
        `Return a single JSON object with exactly these keys: ${leaves.map((leaf) => leaf.key).join(", ")}. ` +
        `Each value is either a string (the quote) or null. No extra keys, no commentary, no markdown fences.`,
    },
    { role: "user", content: transcript },
  ];
}

function parseSpanResponse(
  content: string,
  leaves: readonly Leaf[],
): Record<string, string | null> {
  const raw: unknown = JSON.parse(content);
  if (!isSchemaNode(raw)) {
    throw new Error("Phase 1 response is not a JSON object");
  }
  const result: Record<string, string | null> = {};
  for (const leaf of leaves) {
    const value = raw[leaf.key];
    if (value === null || value === undefined) {
      result[leaf.key] = null;
    } else if (typeof value === "string") {
      result[leaf.key] = value;
    } else {
      throw new Error(`Phase 1 response for ${leaf.path} is not a string or null`);
    }
  }
  return result;
}
