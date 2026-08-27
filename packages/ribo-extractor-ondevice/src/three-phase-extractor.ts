/**
 * @file Three-phase presence-first extractor for the on-device model.
 *
 * Ported from `spikes/ondevice-acceptance/three-phase.ts`. The measurement that
 * picked this strategy is in
 * `docs/implementation/19-ondevice-extraction-strategies.md`: splitting extraction
 * into presence, span, and classify calls eliminated the degenerate whitespace
 * loop that retries could not fix, and adding unconditional span grounding took
 * source-span fidelity to 100%.
 *
 * The strategy is intentionally adapter-agnostic: it reads the grouped schema from
 * {@link ExtractionTarget.extractionSchema} and never imports a host-tool adapter.
 */

import { z } from "zod";

import { ChatError } from "@azx/ribo-extractor-openai";
import type { ChatMessage, ChatRequest } from "@azx/ribo-extractor-openai";
import { isSpanGrounded } from "@azx/ribo-core";
import type { Enveloped, Extractor, ExtractionResult, ExtractionTarget } from "@azx/ribo-core";

// Typed against the seam, not against `OnDeviceChat` itself. This extractor only ever
// calls `complete()` and reads `engine`, so demanding the concrete class would couple it
// to an implementation it does not use and make it untestable with a plain fake chat.
import type { CapableChatClient } from "@azx/ribo-extractor-openai";

/** Default retry budget for a single call, matching the spike. */
export const DEFAULT_MAX_RETRIES = 3;

/** Loose JSON Schema node — enough to walk the zod-generated schema and build sub-schemas. */
type JsonSchema = Record<string, unknown>;

interface Leaf {
  readonly key: string;
  readonly path: string;
  readonly valueSchema: JsonSchema;
}

interface Group {
  readonly key: string;
  readonly leaves: readonly Leaf[];
}

export interface ThreePhaseExtractorOptions<V extends Record<string, unknown>> {
  /** The field knowledge: the extraction schema drives all three phases. */
  readonly target: ExtractionTarget<V>;
  /** The on-device chat transport. */
  readonly chat: CapableChatClient;
  /** Max retries per model call. Defaults to {@link DEFAULT_MAX_RETRIES}. */
  readonly maxRetries?: number;
}

/**
 * Build a three-phase on-device {@link Extractor}.
 *
 * Phase 0 asks, per group, which leaves are discussed at all. Phase 1 asks for
 * verbatim quotes only for the phase-0-true leaves. Phase 2 classifies each
 * grounded quote into the leaf's value. Leaves whose phase-1 span is not a
 * verbatim substring of the transcript are dropped unconditionally.
 */
export function threePhaseExtractor<V extends Record<string, unknown>>(
  options: ThreePhaseExtractorOptions<V>,
): Extractor<Enveloped<V>> {
  const { target, chat, maxRetries = DEFAULT_MAX_RETRIES } = options;
  const schema = z.toJSONSchema(target.extractionSchema, { target: "draft-2020-12" }) as JsonSchema;
  const groups = extractGroups(schema);
  if (groups.length === 0) {
    throw new Error("threePhaseExtractor: no groups found in extraction schema");
  }
  // The on-device chat transport ignores the model id, but ChatRequest requires one.
  const model = chat.engine;

  return {
    async extract(transcript: string): Promise<ExtractionResult<Enveloped<V>>> {
      const result: Record<
        string,
        Record<string, { value: unknown; confidence: number; sourceSpan: string | null }>
      > = {};
      let totalCalls = 0;
      const recordCall = (): void => {
        totalCalls++;
      };

      for (const group of groups) {
        const groupResult: Record<
          string,
          { value: unknown; confidence: number; sourceSpan: string | null }
        > = {};
        result[group.key] = groupResult;

        let presence: Record<string, boolean>;
        try {
          presence = await extractPresence(group, transcript, chat, model, maxRetries, recordCall);
        } catch {
          for (const leaf of group.leaves) {
            groupResult[leaf.key] = { value: null, confidence: 0, sourceSpan: null };
          }
          continue;
        }

        const activeLeaves = group.leaves.filter((leaf) => presence[leaf.key] === true);
        if (activeLeaves.length === 0) {
          for (const leaf of group.leaves) {
            groupResult[leaf.key] = { value: null, confidence: 0, sourceSpan: null };
          }
          continue;
        }

        let spans: Record<string, string | null>;
        try {
          spans = await extractSpans(
            group,
            activeLeaves,
            transcript,
            chat,
            model,
            maxRetries,
            recordCall,
          );
        } catch {
          for (const leaf of group.leaves) {
            groupResult[leaf.key] = { value: null, confidence: 0, sourceSpan: null };
          }
          continue;
        }

        for (const leaf of group.leaves) {
          const span = spans[leaf.key] ?? null;
          if (span === null) {
            groupResult[leaf.key] = { value: null, confidence: 0, sourceSpan: null };
            continue;
          }
          if (!isSpanGrounded(span, transcript)) {
            groupResult[leaf.key] = { value: null, confidence: 0, sourceSpan: null };
            continue;
          }
          const value = await classifyLeaf(leaf, span, chat, model, maxRetries, recordCall);
          groupResult[leaf.key] = {
            value: value ?? null,
            sourceSpan: span,
            // Confidence is a placeholder: this strategy has no calibrated confidence.
            // The repo already records that confidence does not discriminate hallucinations.
            // 1 = leaf got a value; 0 = no value (no span or phase 2 failed).
            confidence: value !== null ? 1 : 0,
          };
        }
      }

      const parsed = target.extractionSchema.parse(result);
      return {
        fields: parsed as Enveloped<V>,
        usage: { calls: totalCalls, engine: chat.engine },
      };
    },
  };
}

function isSchemaNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractGroups(schema: JsonSchema): Group[] {
  const groups: Group[] = [];
  const topProperties = schema["properties"];
  if (!isSchemaNode(topProperties)) return groups;

  for (const [groupKey, groupSchemaValue] of Object.entries(topProperties)) {
    if (!isSchemaNode(groupSchemaValue)) continue;
    const leafProperties = groupSchemaValue["properties"];
    if (!isSchemaNode(leafProperties)) continue;

    const leaves: Leaf[] = [];
    for (const [leafKey, leafEnvelopeValue] of Object.entries(leafProperties)) {
      if (!isSchemaNode(leafEnvelopeValue)) continue;
      const valueProperties = leafEnvelopeValue["properties"];
      if (!isSchemaNode(valueProperties)) continue;
      const valueSchemaValue = valueProperties["value"];
      if (!isSchemaNode(valueSchemaValue)) continue;
      leaves.push({
        key: leafKey,
        path: `${groupKey}.${leafKey}`,
        valueSchema: valueSchemaValue,
      });
    }
    groups.push({ key: groupKey, leaves });
  }
  return groups;
}

function chatRequest(
  model: string,
  messages: readonly ChatMessage[],
  schema: JsonSchema,
  name: string,
): ChatRequest {
  return {
    model,
    messages: messages as ChatMessage[],
    response_format: {
      type: "json_schema",
      json_schema: { name, schema, strict: true },
    },
  };
}

async function extractPresence(
  group: Group,
  transcript: string,
  chat: CapableChatClient,
  model: string,
  maxRetries: number,
  onCall: () => void,
): Promise<Record<string, boolean>> {
  const schema = buildPhase0Schema(group);
  const request = chatRequest(
    model,
    buildPhase0Messages(group, transcript),
    schema,
    `${group.key}-presence`,
  );
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    onCall();
    try {
      const completion = await chat.complete(request);
      return parsePhase0Response(completion.content, group);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function buildPhase0Schema(group: Group): JsonSchema {
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

function buildPhase0Messages(group: Group, transcript: string): ChatMessage[] {
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

function parsePhase0Response(content: string, group: Group): Record<string, boolean> {
  const raw = JSON.parse(content);
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

async function extractSpans(
  group: Group,
  activeLeaves: readonly Leaf[],
  transcript: string,
  chat: CapableChatClient,
  model: string,
  maxRetries: number,
  onCall: () => void,
): Promise<Record<string, string | null>> {
  const schema = buildPhase1Schema(activeLeaves);
  const request = chatRequest(
    model,
    buildPhase1Messages(group, activeLeaves, transcript),
    schema,
    `${group.key}-spans`,
  );
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    onCall();
    try {
      const completion = await chat.complete(request);
      return parsePhase1Response(completion.content, activeLeaves);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function buildPhase1Schema(leaves: readonly Leaf[]): JsonSchema {
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

function buildPhase1Messages(
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

function parsePhase1Response(
  content: string,
  leaves: readonly Leaf[],
): Record<string, string | null> {
  const raw = JSON.parse(content);
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

async function classifyLeaf(
  leaf: Leaf,
  span: string,
  chat: CapableChatClient,
  model: string,
  maxRetries: number,
  onCall: () => void,
): Promise<unknown> {
  const bareRequest = chatRequest(
    model,
    buildPhase2Messages(leaf, span),
    leaf.valueSchema,
    `classify-${leaf.path.replace(/\./g, "-")}`,
  );
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    onCall();
    try {
      const completion = await chat.complete(bareRequest);
      return validateLeafValue(leaf, parsePhase2Bare(completion.content));
    } catch (error) {
      if (isUnsupportedError(error)) {
        return classifyWrapped(leaf, span, chat, model, maxRetries, onCall);
      }
    }
  }
  return null;
}

async function classifyWrapped(
  leaf: Leaf,
  span: string,
  chat: CapableChatClient,
  model: string,
  maxRetries: number,
  onCall: () => void,
): Promise<unknown> {
  const wrappedSchema = wrapValueSchema(leaf.valueSchema);
  const request = chatRequest(
    model,
    buildPhase2Messages(leaf, span),
    wrappedSchema,
    `classify-${leaf.path.replace(/\./g, "-")}-wrapped`,
  );
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    onCall();
    try {
      const completion = await chat.complete(request);
      return validateLeafValue(leaf, parsePhase2Wrapped(completion.content));
    } catch {
      // Retry wrapped classification failures; the model is given the same small question.
    }
  }
  return null;
}

function wrapValueSchema(valueSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    properties: { value: valueSchema },
    required: ["value"],
    additionalProperties: false,
  };
}

function buildPhase2Messages(leaf: Leaf, span: string): ChatMessage[] {
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

function parsePhase2Bare(content: string): unknown {
  return JSON.parse(content);
}

function parsePhase2Wrapped(content: string): unknown {
  const raw = JSON.parse(content);
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

function isUnsupportedError(error: unknown): boolean {
  return error instanceof ChatError && error.kind === "unsupported";
}
