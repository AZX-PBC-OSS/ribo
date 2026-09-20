/**
 * @file The presence phase of the three-phase on-device strategy — one call per
 * group asking which leaves are discussed at all, as a `Phase` the phased engine
 * runs first.
 *
 * This is the first quarter of the `threePhaseExtractor` port (design
 * `phased-extraction-design.md` §4.7): the schema walk, the prompt builder and
 * the response parser moved here from the monolith unchanged, the retry loop and
 * the pre-attempt abort checks are the engine's, and the per-group boolean map
 * crosses to the span phase through the draft's typed notes bag.
 *
 * Three shapes worth naming:
 *
 * - **`plan` returns one item per group, always.** Presence is the pass that
 *   decides what everything else looks at, so it has nothing to narrow against —
 *   and it is the only phase whose `plan` is never empty (the preset refuses a
 *   zero-group walk at construction), which is why the seed below is its to
 *   own.
 * - **`merge` seeds every group with a full null envelope — the task's
 *   load-bearing detail.** It stores each group's boolean map in `notes` AND
 *   writes every group's complete leaf set as `value: null, confidence: 0,
 *   sourceSpan: null` — for successful items as well as failed ones. Later
 *   phases overwrite individual leaves; the seed is the floor. Without it, a
 *   group whose presence map is all false has no item in any later phase and no
 *   merge would ever write it: the engine skips `merge` entirely on an empty
 *   plan, so that group's key would be MISSING from the fields — and the closing
 *   trust-boundary parse REJECTS it, because `enveloped()` strips top-level
 *   `.optional()` and rebuilds with `z.strictObject`, so every group key is
 *   required (`enveloped.test.ts` pins that).
 * - **Every merge that writes a group entry applies the array wrap through one
 *   shared helper** — {@link wrapGroupEntry}. A collection group's value is the
 *   leaf-envelope map wrapped in a one-element array; a flat group's is the map
 *   itself. With four merges writing group entries, one helper is what stops
 *   three of them getting it right and the fourth producing a shape only the
 *   closing parse rejects, after every call has been paid for.
 *
 * **The construction-time refusal lives here.** A group derived at `"row"` or
 * `"none"` provenance granularity has no per-leaf envelope, and this strategy
 * asks for one verbatim span per leaf, so it cannot extract that group.
 * {@link extractGroups} throws at construction with a message naming the group
 * and the leaf and explaining the alternative — before any call is made.
 *
 * Since SP4a wave 5 this file lives in core: nothing here is on-device — it asks
 * any {@link ChatClient} — and core owns the phase vocabulary.
 */

import type { CapableChatClient, ChatMessage, ChatRequest } from "./chat-client.js";
import type { Enveloped, NoProvenance } from "./enveloped.js";
import { noteKey } from "./phase-notes.js";
import type { NoteKey } from "./phase-notes.js";
import type { DeepPartial } from "./phase-draft.js";
import type { Phase, PhaseDef } from "./phase.js";
import { phaseBuilder } from "./phase.js";

/** Loose JSON Schema node — enough to walk the zod-generated schema and build sub-schemas. */
export type JsonSchema = Record<string, unknown>;

export interface Leaf {
  readonly key: string;
  readonly path: string;
  readonly valueSchema: JsonSchema;
}

export interface Group {
  readonly key: string;
  readonly leaves: readonly Leaf[];
  /**
   * True when this group's JSON Schema node is `{"type":"array", "items": {...}}` —
   * a R1.6 instance-modeled collection group (`hvac`, `attic`, `wall`, `window`,
   * `dhw` in the real Snugg Pro schema) rather than a flat object of enveloped
   * leaves. `leaves` still describes the leaves of ONE instance (the array's
   * `items` schema); the merges wrap the single filled-in instance back into a
   * one-element array so the result validates against the required array-typed
   * group key. See {@link wrapGroupEntry} and `extractGroups` for the walk.
   */
  readonly isArray: boolean;
}

/** The leaf-envelope shape every merge of this strategy writes. */
export interface LeafEnvelope {
  value: unknown;
  confidence: number;
  sourceSpan: string | null;
}

/** The floor every leaf starts at — presence's seed, and every null's shape. */
export function nullEnvelope(): LeafEnvelope {
  return { value: null, confidence: 0, sourceSpan: null };
}

/**
 * THE shared array wrap: a collection group's entry is the leaf-envelope map
 * wrapped in a one-element array; a flat group's is the map itself. Every merge
 * that writes a group entry applies this — none builds the wrap inline.
 */
export function wrapGroupEntry(group: Group, entry: Record<string, LeafEnvelope>): unknown {
  return group.isArray ? [entry] : entry;
}

/**
 * The group's writable leaf map inside `fields`, honouring the array wrap: an
 * array group's leaves live on the single instance at index 0, which presence's
 * seed created. Creates the entry when it is somehow absent, so a merge stays
 * total — through a valid phase list the seed is always there, and this is the
 * guard that keeps a future composition honest rather than a `TypeError`.
 */
export function writableGroupEntry(
  group: Group,
  fields: Record<string, unknown>,
): Record<string, LeafEnvelope> {
  const current = fields[group.key];
  if (group.isArray) {
    const first: unknown = Array.isArray(current) ? (current as unknown[])[0] : undefined;
    if (isEnvelopeMap(first)) return first;
    const fresh: Record<string, LeafEnvelope> = {};
    fields[group.key] = [fresh];
    return fresh;
  }
  if (isEnvelopeMap(current)) return current;
  const fresh: Record<string, LeafEnvelope> = {};
  fields[group.key] = fresh;
  return fresh;
}

function isEnvelopeMap(value: unknown): value is Record<string, LeafEnvelope> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSchemaNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Walk the zod-generated JSON Schema into per-group leaf lists, refusing a group
 * that cannot support one verbatim span per leaf. Moved from the monolith
 * unchanged, refusal message included — the caller sees it at construction,
 * before the first call.
 */
export function extractGroups(schema: JsonSchema): Group[] {
  const groups: Group[] = [];
  const topProperties = schema["properties"];
  if (!isSchemaNode(topProperties)) return groups;

  for (const [groupKey, groupSchemaValue] of Object.entries(topProperties)) {
    if (!isSchemaNode(groupSchemaValue)) continue;

    // Since R1.6, a collection group (hvac/attic/wall/window/dhw in the real Snugg
    // Pro schema) is `enveloped()`'s `z.array(envelopedElement)` — it serializes to
    // `{"type":"array","items":{...}}`, with no `properties` of its own. Its leaves
    // live one level down, on the array's `items` schema, which is the same
    // enveloped-object shape a flat group's own schema node is. Walking into `items`
    // when present is what stops this from silently dropping every array-shaped
    // group's leaves.
    const isArray = groupSchemaValue["type"] === "array";
    const leafContainer = isArray ? groupSchemaValue["items"] : groupSchemaValue;
    if (!isSchemaNode(leafContainer)) continue;
    const leafProperties = leafContainer["properties"];
    if (!isSchemaNode(leafProperties)) continue;

    const leaves: Leaf[] = [];
    for (const [leafKey, leafEnvelopeValue] of Object.entries(leafProperties)) {
      if (!isSchemaNode(leafEnvelopeValue)) continue;
      const valueProperties = leafEnvelopeValue["properties"];
      // A property with NO `properties` of its own is a plain leaf — the shape `enveloped()`
      // produces for a group that declared `"row"` or `"none"` provenance, plus the row's own
      // `sourceSpan`. This strategy cannot work with one: the span phase asks for a verbatim
      // span PER LEAF and classify classifies that leaf's value out of that span, so a group
      // with no per-leaf envelopes yields no leaves, gets asked about nothing, and emits an
      // empty object that only the closing `extractionSchema.parse()` rejects — after every
      // OTHER group's model calls have already been spent. Refusing here makes it a wiring
      // error the caller sees before the first call.
      //
      // This is a refusal, not a gap to fill in passing: the span phase asking for one ROW
      // span and classify classifying every leaf out of it is a coherent design, and probably
      // a good one given the measurement that motivated row provenance, but it is a different
      // strategy rather than a patch to this one.
      if (!isSchemaNode(valueProperties)) {
        throw new Error(
          `threePhaseExtractor: group "${groupKey}" has a plain leaf "${leafKey}", so it was ` +
            'derived at "row" or "none" provenance granularity. This strategy needs a ' +
            "per-leaf provenance envelope on every leaf — it asks for one verbatim span per " +
            `leaf — so it cannot extract "${groupKey}". Derive that group at "leaf" ` +
            "granularity, or use a strategy that speaks row provenance.",
        );
      }
      const valueSchemaValue = valueProperties["value"];
      if (!isSchemaNode(valueSchemaValue)) continue;
      leaves.push({
        key: leafKey,
        path: `${groupKey}.${leafKey}`,
        valueSchema: valueSchemaValue,
      });
    }
    groups.push({ key: groupKey, leaves, isArray });
  }
  return groups;
}

/** The chat request every phase of this strategy builds — today's `chatRequest`, moved. */
export function chatRequest(
  model: string,
  messages: readonly ChatMessage[],
  schema: JsonSchema,
  name: string,
): ChatRequest {
  return {
    model,
    messages: messages,
    response_format: {
      type: "json_schema",
      json_schema: { name, schema, strict: true },
    },
  };
}

/**
 * Which leaves each group's presence call marked discussed: group key → leaf
 * key → present. The span phase reads it to narrow its calls; a group with no
 * entry (its presence item failed) plans nothing downstream.
 */
export type PresenceMaps = Record<string, Record<string, boolean>>;

/** The note key {@link presencePhase}'s merge writes and the span phase's plan reads. */
export const presenceNoteKey: NoteKey<PresenceMaps> = noteKey("three-phase-presence");

/** Options for {@link presencePhase}. */
export interface PresencePhaseOptions {
  /** The walked groups — the preset walks the schema once, at its construction. */
  readonly groups: readonly Group[];
  /** The on-device chat transport. */
  readonly chat: CapableChatClient;
  /** The model id passed through to each request. The transport ignores it. */
  readonly model: string;
  /**
   * Overrides the phase's id — `"presence"` by default. See `PhaseMeta.id` in
   * `@azx/ribo-core` for what an id reaches and why a caller-chosen one is safe.
   */
  readonly id?: string;
  /**
   * Ids of the phases this phase must follow. The phase declares none of its
   * own — it runs first — so the list is exactly what you pass (ADR 0008).
   */
  readonly requires?: readonly string[];
}

interface PresenceItem {
  readonly group: Group;
}

/**
 * The presence phase: one call per group asking which leaves are discussed at
 * all. See the file header for the seed and the refusal — the two details that
 * make this the strategy's floor.
 */
export function presencePhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: PresencePhaseOptions,
): Phase<V, P> {
  const def: PhaseDef<V, P, PresenceItem, Record<string, boolean>> = {
    id: options.id ?? "presence",
    onItemFailure: "skip",
    // The caller's ids are the whole `requires` — the phase declares none of
    // its own (see the option); an absent option leaves the def's `requires`
    // unset.
    ...(options.requires === undefined ? {} : { requires: options.requires }),
    describeItem: (item) => ({ key: item.group.key }),
    plan: () => options.groups.map((group) => ({ group })),
    run: async (item, _draft, ctx) => {
      const request = chatRequest(
        options.model,
        buildPresenceMessages(item.group, ctx.transcript.text),
        buildPresenceSchema(item.group),
        `${item.group.key}-presence`,
      );
      const completion = await options.chat.complete(request, {
        // Forwarded, not rebuilt: the phase context's signal is the caller's
        // cancellation combined with the phase pool's sibling abort, and a
        // dropped forward would strand cancellation silently.
        signal: ctx.signal,
      });
      return {
        value: parsePresenceResponse(completion.content, item.group),
        usage: { calls: 1, engine: options.chat.engine },
      };
    },
    merge: (draft, outcomes) => {
      const maps: PresenceMaps = {};
      for (const outcome of outcomes) {
        // A failed item contributes no map; its group plans nothing downstream
        // and its leaves are nulled by the seed below, which covers every group
        // — successful, failed, and absent alike.
        if (outcome.outcome !== "result") continue;
        maps[outcome.item.group.key] = outcome.output.value;
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
      for (const group of options.groups) {
        const entry: Record<string, LeafEnvelope> = {};
        for (const leaf of group.leaves) {
          entry[leaf.key] = nullEnvelope();
        }
        fields[group.key] = wrapGroupEntry(group, entry);
      }

      return {
        ...draft,
        fields: fields as DeepPartial<Enveloped<V, P>>,
        // Written unconditionally — the span phase's plan reads this key and
        // demands it, so even a fully-failed presence pass must write it.
        notes: draft.notes.set(presenceNoteKey, maps),
      };
    },
  };
  return phaseBuilder<V, P>()(def);
}

function buildPresenceSchema(group: Group): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const leaf of group.leaves) {
    properties[leaf.key] = { type: "boolean" };
  }
  return {
    type: "object",
    properties,
    required: group.leaves.map((leaf) => leaf.key),
    additionalProperties: false,
  };
}

function buildPresenceMessages(group: Group, transcript: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `For the ${group.key} group, determine which of the following fields are discussed in the auditor's spoken field notes.\n\n` +
        `Return a single JSON object with exactly these keys: ${group.leaves.map((leaf) => leaf.key).join(", ")}. ` +
        `Each value must be a boolean: true if the transcript explicitly discusses the field, ` +
        `false if it is not mentioned, only implied, or unrelated. ` +
        `A field merely implied is false. No extra keys, no commentary, no markdown fences.`,
    },
    { role: "user", content: transcript },
  ];
}

function parsePresenceResponse(content: string, group: Group): Record<string, boolean> {
  const raw: unknown = JSON.parse(content);
  if (!isSchemaNode(raw)) {
    throw new Error("Phase 0 response is not a JSON object");
  }
  const result: Record<string, boolean> = {};
  for (const leaf of group.leaves) {
    const value = raw[leaf.key];
    if (typeof value === "boolean") {
      result[leaf.key] = value;
    } else {
      throw new Error(`Phase 0 response for ${leaf.path} is not a boolean`);
    }
  }
  return result;
}
