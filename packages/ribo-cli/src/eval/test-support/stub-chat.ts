/**
 * @file The test support the eval suite drives: a stub chat that answers
 * every request with a value conforming to the request's own schema.
 *
 * The stub is written over core's public seam (`scriptedChat`), so it records
 * every request it receives — including the failed ones — and no test needs a
 * model, a network or a credential. The reply is generated from the request's
 * JSON Schema, which is what makes one stub serve all three strategies: the
 * presence phase's boolean map, a group-shaped extraction and a whole-schema
 * extraction are all "a value conforming to this schema".
 */
import { scriptedChat } from "@azx/ribo-core";
import type { ChatRequest, ScriptedChatClient } from "@azx/ribo-core";

/**
 * How the stub answers.
 */
export interface StubChatOptions {
  /**
   * The leaf keys the presence phase reports as ABSENT. Every other leaf is
   * reported present — the all-present fixture the presence bound is measured
   * against.
   */
  readonly absentLeaves?: readonly string[];
  /**
   * A leaf's value, by dotted path (`"frame.material"`). A path the stub does
   * not know keeps its default value.
   */
  readonly values?: Readonly<Record<string, unknown>>;
  /** The source span every envelope carries. Defaults to `"sample"`. */
  readonly sourceSpan?: string;
}

/** A JSON Schema node, as the request carries it. */
type SchemaNode = Record<string, unknown>;

/** Is this a JSON object node? */
const isNode = (value: unknown): value is SchemaNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The properties of a node, when it has any. */
const propertiesOf = (node: SchemaNode): Record<string, SchemaNode> => {
  const properties = node["properties"];
  if (!isNode(properties)) return {};
  const out: Record<string, SchemaNode> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (isNode(value)) out[key] = value;
  }
  return out;
};

/** Is this node a leaf envelope — the wire schema's `{ value, confidence, sourceSpan }`? */
const isEnvelope = (node: SchemaNode): boolean => {
  const properties = propertiesOf(node);
  return "value" in properties && "confidence" in properties && "sourceSpan" in properties;
};

/**
 * A sample value for a leaf's schema: the first non-null branch of a union,
 * or the schema's own type.
 */
const sampleValue = (node: SchemaNode): unknown => {
  const branches = node["anyOf"] ?? node["oneOf"];
  if (Array.isArray(branches)) {
    for (const branch of branches) {
      if (!isNode(branch)) continue;
      if (branch["type"] === "null") continue;
      return sampleValue(branch);
    }
    return null;
  }
  switch (node["type"]) {
    case "string":
      return "sample";
    case "number":
      return 1;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return null;
  }
};

/**
 * Build a value conforming to a node, at a dotted path.
 *
 * The path is the one the overrides are keyed by: the request's own root, so
 * `"frame.material"` names the leaf under the `frame` group whichever group
 * the request asked about.
 */
const conform = (node: SchemaNode, path: string, options: StubChatOptions): unknown => {
  if (isEnvelope(node)) {
    const value = options.values?.[path] ?? sampleValue(propertiesOf(node)["value"] ?? {});
    return { value, confidence: 0.9, sourceSpan: options.sourceSpan ?? "sample" };
  }
  const properties = propertiesOf(node);
  if (Object.keys(properties).length > 0) {
    const out: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(properties)) {
      out[key] = conform(property, path === "" ? key : `${path}.${key}`, options);
    }
    return out;
  }
  if (node["type"] === "array") {
    const items = node["items"];
    return isNode(items) ? [conform(items, path, options)] : [];
  }
  return sampleValue(node);
};

/**
 * The presence phase's reply: a boolean per leaf of the group it asked about.
 */
const presenceReply = (schema: SchemaNode, options: StubChatOptions): unknown => {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(propertiesOf(schema))) {
    out[key] = !(options.absentLeaves ?? []).includes(key);
  }
  return out;
};

/**
 * Build the stub chat: every request answered with a value conforming to the
 * request's own schema.
 * @param options - How the stub answers.
 * @returns The stub client, recording every request it received.
 * @category Eval
 */
export function stubChat(options: StubChatOptions = {}): ScriptedChatClient {
  return scriptedChat((request: ChatRequest) => ({ content: replyFor(request, options) }));
}

/**
 * The answer to one request, as the JSON text a chat completion carries.
 *
 * Exported so a test that drives the real transport — the openai-compatible
 * backend, over a stubbed `fetch` — can answer the same way the stub chat
 * does: the wire body carries the schema and the name, and nothing else.
 * @param request - The request the model was asked.
 * @param options - How the answer is built.
 * @returns The answer, as JSON text.
 * @category Eval
 */
export function replyFor(request: ChatRequest, options: StubChatOptions = {}): string {
  return replyForSchema(
    request.responseFormat.json_schema.schema,
    request.responseFormat.json_schema.name,
    options,
  );
}

/**
 * The answer to one request, read off the request's own JSON Schema and wire
 * name.
 * @param schema - The request's JSON Schema.
 * @param name - The request's wire name.
 * @param options - How the answer is built.
 * @returns The answer, as JSON text.
 * @category Eval
 */
export function replyForSchema(
  schema: Record<string, unknown>,
  name: string,
  options: StubChatOptions = {},
): string {
  if (name.endsWith("-presence")) {
    return JSON.stringify(presenceReply(schema, options));
  }
  return JSON.stringify(conform(schema, "", options));
}
