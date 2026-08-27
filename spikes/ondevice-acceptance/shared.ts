/**
 * @file Shared helpers for the two-phase and three-phase on-device extraction spikes.
 *
 * These are deliberately extracted from the spike files rather than from packages/,
 * because they are experimental plumbing: the extraction schema introspection, the
 * leaf value classification loop, and the on-device chat error classification.
 */

import type { OnDeviceChat } from "@azx/ribo-extractor-ondevice";
import type { ChatMessage, ChatRequest } from "@azx/ribo-extractor-openai";

export const MODEL = "gemini-nano";
export const DEFAULT_MAX_RETRIES = 3;

/** Loose JSON Schema node type — enough to walk the zod-generated schema and build new ones. */
export type JsonSchema = Record<string, unknown>;

export interface Leaf {
  readonly key: string;
  readonly path: string;
  readonly valueSchema: JsonSchema;
}

export interface Group {
  readonly key: string;
  readonly leaves: readonly Leaf[];
}

export interface Phase2Stats {
  phase2Attempts: number;
  phase2Degenerations: number;
  phase2BareRejected: number;
  phase2WrappedAttempts: number;
  phase2WrappedDegenerations: number;
}

export function isSchemaNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function extractGroups(schema: JsonSchema): Group[] {
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
      leaves.push({ key: leafKey, path: `${groupKey}.${leafKey}`, valueSchema: valueSchemaValue });
    }
    groups.push({ key: groupKey, leaves });
  }
  return groups;
}

export async function classifyLeaf(
  leaf: Leaf,
  span: string,
  chat: OnDeviceChat,
  log: (line: string) => void,
  maxRetries: number,
  stats: Phase2Stats,
): Promise<unknown> {
  const bareRequest = chatRequest(MODEL, buildPhase2Messages(leaf, span), leaf.valueSchema);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    stats.phase2Attempts += 1;
    try {
      const completion = await chat.complete(bareRequest);
      return validateLeafValue(leaf, parsePhase2Bare(completion.content));
    } catch (error) {
      if (isUnsupportedError(error)) {
        stats.phase2BareRejected += 1;
        log(`  ${leaf.path}: bare root constraint rejected, falling back to single-key object`);
        return classifyWrapped(leaf, span, chat, maxRetries, stats);
      }
      if (isDegeneration(error)) {
        stats.phase2Degenerations += 1;
      }
    }
  }
  return null;
}

async function classifyWrapped(
  leaf: Leaf,
  span: string,
  chat: OnDeviceChat,
  maxRetries: number,
  stats: Phase2Stats,
): Promise<unknown> {
  const wrappedSchema = wrapValueSchema(leaf.valueSchema);
  const request = chatRequest(MODEL, buildPhase2Messages(leaf, span), wrappedSchema);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    stats.phase2WrappedAttempts += 1;
    try {
      const completion = await chat.complete(request);
      return validateLeafValue(leaf, parsePhase2Wrapped(completion.content));
    } catch (error) {
      if (isDegeneration(error)) {
        stats.phase2WrappedDegenerations += 1;
      }
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
  throw new Error(`Unsupported leaf type for ${leaf.path}: ${JSON.stringify(inner)}`);
}

export function chatRequest(
  model: string,
  messages: readonly ChatMessage[],
  schema: JsonSchema,
  name: string = "two-phase",
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

interface ChatErrorLike extends Error {
  readonly kind: string;
}

function isChatError(error: unknown): error is ChatErrorLike {
  return error instanceof Error && error.name === "ChatError";
}

export function isDegeneration(error: unknown): boolean {
  return (
    isChatError(error) &&
    error.kind === "transport" &&
    (error.message.includes("degenerated into a trailing whitespace loop") ||
      error.message.includes("exceeded the model's output limits"))
  );
}

function isUnsupportedError(error: unknown): boolean {
  return isChatError(error) && error.kind === "unsupported";
}
