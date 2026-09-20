/**
 * @file The classify phases of the three-phase on-device strategy — one call per
 * grounded leaf, first against the leaf's bare value schema, then a wrapped-
 * schema pass over the leaves the transport could not answer bare — as `Phase`s
 * the phased engine runs last.
 *
 * This is the back half of the `threePhaseExtractor` port (design
 * `phased-extraction-design.md` §4.7), and the task the whole design turns on.
 * Today, a classify call that fails with `ChatError` kind `"unsupported"`
 * triggers a request rewrite INSIDE the retry loop: a wrapped schema, a
 * different structured-output name, continuing attempt numbers under the same
 * unit id. Split across two phases it needs no error-driven rescheduling at all
 * — the wrapped pass's `plan` reads the leaves the classify phase recorded as
 * unsupported, which is the narrowing pattern the combinator exists for.
 *
 * Three shapes worth naming:
 *
 * - **Classify's `run` must not throw on `unsupported`.** It returns a
 *   discriminated contribution — a classified value, or a marker saying the
 *   model could not answer this schema — and does not reject. This is not a
 *   trick to dodge the retry loop; it is the honest model. The call succeeded.
 *   The transport reported that it cannot constrain output to this schema,
 *   which is a fact about the schema, not a transient failure. Throwing would
 *   send it through the retry loop, where `isTransientFailure` returns true for
 *   a `ChatError` carrying no numeric status, so every unsupported leaf would
 *   burn its whole retry budget re-sending a request that cannot succeed — four
 *   calls per leaf instead of one, before the wrapped pass ever ran.
 * - **The catch is narrow.** `run` rethrows everything that is not
 *   `unsupported` — a refusal and a malformed response are retried today and
 *   must stay retried, and a branded cancellation must propagate or the
 *   engine's cancellation rule is defeated at the one place it matters most. A
 *   broad catch here silently re-creates the bug this port is supposed to fix.
 * - **A failed item keeps the span; only the value is nulled.** Unlike presence
 *   and span, a real classify failure keeps the citation: gap-fill's candidates
 *   are leaves with a null value and a non-null span, so nulling the span here
 *   would starve the follow-up pass and strip the citation a reviewer reads.
 *   The two phases share one merge, so the wrapped pass interprets outcomes the
 *   same way.
 *
 * The marker reports `{ calls: 1 }`: the call was made and today's code counts
 * it; a marker carrying no usage would undercount every unsupported leaf.
 */

import { noteKey, phaseBuilder } from "@azx/ribo-core";
import type {
  DeepPartial,
  Enveloped,
  NoProvenance,
  NoteKey,
  Phase,
  PhaseDef,
  PhaseDraft,
  PhaseItemOutcome,
} from "@azx/ribo-core";
import { ChatError } from "@azx/ribo-extractor-openai";
import type { CapableChatClient, ChatCompletion, ChatMessage } from "@azx/ribo-extractor-openai";

import { chatRequest, isSchemaNode, writableGroupEntry } from "./presence-phase.js";
import type { Group, JsonSchema, Leaf } from "./presence-phase.js";
import { spansNoteKey } from "./span-phase.js";

/**
 * What one classify call settled: a classified value, or a marker saying the
 * model could not answer this schema. The marker is a CONTRIBUTION, not an
 * error — see the file header for why it does not reject.
 */
export type ClassifyContribution =
  { readonly kind: "classified"; readonly value: unknown } | { readonly kind: "unsupported" };

/**
 * The leaves the classify phase could not answer bare: the wrapped pass plans
 * exactly these, one item each — no items, no call, no event when there are
 * none.
 */
export interface UnsupportedLeaf {
  readonly group: Group;
  readonly leaf: Leaf;
  /** The grounded span that was being classified. */
  readonly span: string;
}

export type UnsupportedLeaves = readonly UnsupportedLeaf[];

/** The note key the classify phase produces and the wrapped pass requires. */
export const unsupportedNoteKey: NoteKey<UnsupportedLeaves> = noteKey("three-phase-unsupported");

/** Options shared by {@link classifyPhase} and {@link classifyWrappedPhase}. */
export interface ClassifyPhaseOptions {
  /** The walked groups — the preset walks the schema once, at its construction. */
  readonly groups: readonly Group[];
  /** The on-device chat transport. */
  readonly chat: CapableChatClient;
  /** The model id passed through to each request. The transport ignores it. */
  readonly model: string;
  /**
   * Overrides the phase's id — `"classify"` or `"classify-wrapped"` depending
   * on the factory. See `PhaseMeta.id` in `@azx/ribo-core` for what an id
   * reaches and why a caller-chosen one is safe.
   */
  readonly id?: string;
}

interface ClassifyItem {
  readonly group: Group;
  readonly leaf: Leaf;
  readonly span: string;
}

/**
 * The merge both classify phases share: set the value for a classified leaf,
 * record an unsupported leaf in `notes` for the wrapped pass, and for a failed
 * item null the value while KEEPING the span. See the file header for why the
 * span survives.
 */
function classifyMerge<V extends Record<string, unknown>, P>(
  draft: PhaseDraft<V, P>,
  outcomes: readonly PhaseItemOutcome<ClassifyItem, ClassifyContribution>[],
): PhaseDraft<V, P> {
  const unsupported: UnsupportedLeaf[] = [];
  // THE CAST, and why it is sound: the merge writes leaf envelopes by dynamic
  // key into group entries presence's seed created, which the deep partial's
  // mapped type cannot index by a runtime string. Every write is a value the
  // closing parse validates against the full extraction schema, so a wrong
  // shape cannot survive the run.
  const fields = { ...(draft.fields as Record<string, unknown>) };

  for (const outcome of outcomes) {
    const { group, leaf, span } = outcome.item;
    const entry = writableGroupEntry(group, fields);

    if (outcome.outcome !== "result") {
      // A real failure, not an unsupported marker: null the value, KEEP the
      // span — see the file header.
      entry[leaf.key] = { value: null, confidence: 0, sourceSpan: span };
      continue;
    }

    if (outcome.output.value.kind === "unsupported") {
      unsupported.push({ group, leaf, span });
      continue;
    }

    const value = outcome.output.value.value;
    entry[leaf.key] = {
      value: value ?? null,
      // Confidence is a placeholder: this strategy has no calibrated confidence.
      // The repo already records that confidence does not discriminate hallucinations.
      // 1 = leaf got a value; 0 = no value (the model answered null).
      confidence: value !== null ? 1 : 0,
      sourceSpan: span,
    };
  }

  return {
    ...draft,
    fields: fields as DeepPartial<Enveloped<V, P>>,
    // Written even when empty: the phase declares it produces this key, and a
    // key written only conditionally is the silent-liar shape the engine's
    // produces check exists to catch.
    notes: draft.notes.set(unsupportedNoteKey, unsupported),
  };
}

/** The classify messages both passes build — today's `buildPhase2Messages`, moved. */
function buildClassifyMessages(leaf: Leaf, span: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        `Classify a single transcript quote into the value for one field.\n\n` +
        `Field: ${leaf.path}\n` +
        `Allowed value: ${describeLeafValue(leaf)}\n\n` +
        `Return the value for this field implied by the quote. Return null if the quote does not support ` +
        `a value. Do not infer beyond the quote. Return only the value, with no extra keys or commentary.`,
    },
    { role: "user", content: span },
  ];
}

/**
 * The classify phase: one call per grounded leaf against the leaf's BARE value
 * schema. An `unsupported` transport answer becomes a marker contribution for
 * the wrapped pass, never a thrown error — see the file header.
 */
export function classifyPhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: ClassifyPhaseOptions,
): Phase<V, P> {
  const def: PhaseDef<V, P, ClassifyItem, ClassifyContribution> = {
    id: options.id ?? "classify",
    onItemFailure: "skip",
    requires: [spansNoteKey],
    produces: [unsupportedNoteKey],
    describeItem: (item) => ({ key: item.group.key, leaf: item.leaf.key }),
    plan: (draft) => {
      const spans = draft.notes.get(spansNoteKey) ?? {};
      const items: ClassifyItem[] = [];
      for (const group of options.groups) {
        const groupSpans = spans[group.key];
        for (const leaf of group.leaves) {
          const span = groupSpans?.[leaf.key];
          if (span !== undefined) items.push({ group, leaf, span });
        }
      }
      return items;
    },
    run: async (item, _draft, ctx) => {
      const request = chatRequest(
        options.model,
        buildClassifyMessages(item.leaf, item.span),
        item.leaf.valueSchema,
        `classify-${item.leaf.path.replace(/\./g, "-")}`,
      );
      let completion: ChatCompletion;
      try {
        completion = await options.chat.complete(request, {
          // Forwarded, not rebuilt: the phase context's signal is the caller's
          // cancellation combined with the phase pool's sibling abort, and a
          // dropped forward would strand cancellation silently.
          signal: ctx.signal,
        });
      } catch (error) {
        // THE NARROW CATCH. Only `unsupported` becomes a marker; everything
        // else — refusals, malformed responses, a branded cancellation —
        // rethrows. Rethrowing the cancellation is what lets the engine's
        // cancellation rule reject the run instead of a merge nulling the leaf.
        if (error instanceof ChatError && error.kind === "unsupported") {
          return { value: { kind: "unsupported" }, usage: { calls: 1 } };
        }
        throw error;
      }
      return {
        value: {
          kind: "classified",
          value: validateLeafValue(item.leaf, parseBareClassify(completion.content)),
        },
        usage: { calls: 1 },
      };
    },
    merge: classifyMerge,
  };
  return phaseBuilder<V, P>()(def);
}

/**
 * The wrapped-schema phase: one call per leaf the classify phase recorded as
 * unsupported, against a one-key wrapper schema with a `-wrapped`-suffixed
 * request name. Its merge is classify's.
 */
export function classifyWrappedPhase<V extends Record<string, unknown>, P = NoProvenance>(
  options: ClassifyPhaseOptions,
): Phase<V, P> {
  const def: PhaseDef<V, P, ClassifyItem, ClassifyContribution> = {
    id: options.id ?? "classify-wrapped",
    onItemFailure: "skip",
    requires: [unsupportedNoteKey],
    describeItem: (item) => ({ key: item.group.key, leaf: item.leaf.key }),
    plan: (draft, _ctx) => {
      const recorded = draft.notes.get(unsupportedNoteKey) ?? [];
      return recorded.map(({ group, leaf, span }) => ({ group, leaf, span }));
    },
    run: async (item, _draft, ctx) => {
      const request = chatRequest(
        options.model,
        buildClassifyMessages(item.leaf, item.span),
        wrapValueSchema(item.leaf.valueSchema),
        `classify-${item.leaf.path.replace(/\./g, "-")}-wrapped`,
      );
      const completion = await options.chat.complete(request, {
        // Forwarded, not rebuilt — see the classify phase's run.
        signal: ctx.signal,
      });
      return {
        value: {
          kind: "classified",
          value: validateLeafValue(item.leaf, parseWrappedClassify(completion.content)),
        },
        usage: { calls: 1 },
      };
    },
    merge: classifyMerge,
  };
  return phaseBuilder<V, P>()(def);
}

function wrapValueSchema(valueSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: { value: valueSchema },
    required: ["value"],
    additionalProperties: false,
  };
}

function describeLeafValue(leaf: Leaf): string {
  const inner = getInnerSchema(leaf.valueSchema);
  if (inner.type === "string" && Array.isArray(inner.enum)) {
    return `one of ${inner.enum.map((value) => JSON.stringify(value)).join(", ")}`;
  }
  if (inner.type === "number") return "a number";
  if (inner.type === "string") return "a string";
  if (inner.type === "boolean") return "a boolean";
  return JSON.stringify(inner);
}

function getInnerSchema(valueSchema: JsonSchema): JsonSchema {
  const anyOf = valueSchema["anyOf"];
  if (Array.isArray(anyOf)) {
    const candidates = anyOf.filter(
      (candidate) => !(isSchemaNode(candidate) && candidate.type === "null"),
    );
    if (candidates.length === 1 && isSchemaNode(candidates[0])) {
      return candidates[0];
    }
  }
  return valueSchema;
}

function parseBareClassify(content: string): unknown {
  return JSON.parse(content);
}

function parseWrappedClassify(content: string): unknown {
  const raw: unknown = JSON.parse(content);
  if (!isSchemaNode(raw) || !("value" in raw)) {
    throw new Error("Wrapped phase 2 response is not an object with a single 'value' key");
  }
  return raw.value;
}

function validateLeafValue(leaf: Leaf, value: unknown): unknown {
  if (value === null) return null;
  const inner = getInnerSchema(leaf.valueSchema);
  if (inner.type === "string" && Array.isArray(inner.enum)) {
    if (typeof value === "string" && inner.enum.includes(value)) return value;
    throw new Error(
      `Phase 2 value for ${leaf.path} is not a valid enum member: ${JSON.stringify(value)}`,
    );
  }
  if (inner.type === "number") {
    if (typeof value === "number") return value;
    throw new Error(`Phase 2 value for ${leaf.path} is not a number: ${JSON.stringify(value)}`);
  }
  if (inner.type === "string") {
    if (typeof value === "string") return value;
    throw new Error(`Phase 2 value for ${leaf.path} is not a string: ${JSON.stringify(value)}`);
  }
  if (inner.type === "boolean") {
    if (typeof value === "boolean") return value;
    throw new Error(`Phase 2 value for ${leaf.path} is not a boolean: ${JSON.stringify(value)}`);
  }
  throw new Error(`Unsupported leaf type for ${leaf.path}: ${JSON.stringify(inner)}`);
}
