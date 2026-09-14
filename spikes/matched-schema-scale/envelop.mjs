/**
 * Programmatic transform of the Manual J JSON Schema into the provenance-enveloped
 * shape Ribo uses for extraction.
 *
 * Two outputs:
 *
 *  1. `buildPatchZodSchema()` — a zod patch schema (every leaf `.string().nullable().optional()`,
 *     nested objects `z.strictObject`, arrays `z.array`) suitable for `enveloped()` from
 *     `@azx/ribo-core`.  This is what arm B/C feed to `perGroupExtractor`.
 *
 *  2. `buildEnvelopedJsonSchema()` — the same shape expressed as a JSON Schema where every
 *     leaf is `{ type: "object", properties: { value: { type: ["string","null"] },
 *     confidence: { type: "number" }, sourceSpan: { type: ["string","null"] } },
 *     required: [...], additionalProperties: false }`.  This is what arm A sends to
 *     Mistral's `document_annotation_format.json_schema.schema`.
 *
 * What the transform did:
 *   - Walked every node in the source JSON Schema.
 *   - `type: "object"` → recurse into `properties`, keep `required` and
 *     `additionalProperties: false` (closed objects, matching `z.strictObject`).
 *   - `type: "array"` → recurse into `items`.
 *   - `type: "string"` (leaf) → wrap in the provenance envelope.
 *   - No other types appear in the source schema (all leaves are strings).
 *   - Stripped nothing from the source — no `minimum`/`maximum`/`pattern` to remove
 *     (the source has none), but the transform would leave them in place if present
 *     since the enveloped leaf is always `{ value, confidence, sourceSpan }` regardless.
 *   - The four parts are combined under a top-level object with keys `mj_context`,
 *     `mj_loads`, `mj_rooms`, `mj_building` so `perGroupExtractor` can split them
 *     into four natural groups.
 */

import { z } from "zod";
import { enveloped } from "../../packages/ribo-core/dist/index.js";

// ---------------------------------------------------------------------------
// Source schema — imported from the abode spike's generated schemas.js
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";

const SCHEMAS_PATH = "/Users/ekongiy/projects/clients/abode/spike/app/schemas.js";

// schemas.js uses `export const` (ESM), so read+eval it.
function loadSchemas() {
  const src = readFileSync(SCHEMAS_PATH, "utf-8");
  // Minimal transform: strip `export ` so it becomes a plain const in a module eval.
  const transformed = src.replace(/export\s+const/g, "const");
  const mod = { exports: {} };
  const fn = new Function("module", transformed + "\n;module.exports = { PARTS, MANUAL_J_PARTS };");
  fn(mod);
  return mod.exports;
}

const { PARTS, MANUAL_J_PARTS } = loadSchemas();

// ---------------------------------------------------------------------------
// JSON Schema → enveloped JSON Schema (for Mistral native, arm A)
// ---------------------------------------------------------------------------

const LEAF_ENVELOPE = {
  type: "object",
  properties: {
    value: { type: ["string", "null"] },
    confidence: { type: "number" },
    sourceSpan: { type: ["string", "null"] },
  },
  required: ["value", "confidence", "sourceSpan"],
  additionalProperties: false,
};

function envelopJsonNode(node) {
  if (node.type === "string") return structuredClone(LEAF_ENVELOPE);
  if (node.type === "object") {
    const props = {};
    for (const [k, v] of Object.entries(node.properties || {})) {
      props[k] = envelopJsonNode(v);
    }
    return {
      type: "object",
      properties: props,
      required: node.required || Object.keys(props),
      additionalProperties: false,
    };
  }
  if (node.type === "array") {
    return { type: "array", items: envelopJsonNode(node.items) };
  }
  throw new Error(`envelopJsonNode: unsupported type "${node.type}"`);
}

export function buildEnvelopedJsonSchema() {
  const properties = {};
  for (const part of MANUAL_J_PARTS) {
    properties[part] = envelopJsonNode(PARTS[part].schema);
  }
  return {
    type: "object",
    properties,
    required: [...MANUAL_J_PARTS],
    additionalProperties: false,
  };
}

// ---------------------------------------------------------------------------
// JSON Schema → zod patch schema → enveloped (for Ribo extractor, arms B/C/D)
// ---------------------------------------------------------------------------

function jsonSchemaToZod(node) {
  if (node.type === "string") return z.string().nullable().optional();
  if (node.type === "object") {
    const shape = {};
    for (const [k, v] of Object.entries(node.properties || {})) {
      shape[k] = jsonSchemaToZod(v);
    }
    return z.strictObject(shape);
  }
  if (node.type === "array") return z.array(jsonSchemaToZod(node.items));
  throw new Error(`jsonSchemaToZod: unsupported type "${node.type}"`);
}

export function buildPatchZodSchema() {
  const shape = {};
  for (const part of MANUAL_J_PARTS) {
    shape[part] = jsonSchemaToZod(PARTS[part].schema);
  }
  return z.strictObject(shape);
}

export function buildExtractionTarget() {
  const patchSchema = buildPatchZodSchema();
  const extractionSchema = enveloped(patchSchema);

  // Combine the four parts' system prompts into one instruction set.
  const instructions = MANUAL_J_PARTS.map((p) => PARTS[p].system).join("\n\n---\n\n");

  return {
    name: "manual-j-matched",
    extractionSchema,
    instructions,
    examples: [],
  };
}

/**
 * Build four separate ExtractionTargets — one per Manual J part.
 *
 * `splitExtractionSchema` (used internally by `perGroupExtractor`) falls back to
 * a single non-grouped call for this schema, because `isGroupObject` requires
 * every property of a group to be a `ZodObject`.  The `extraction_notes` objects
 * carry `unreadable_or_ambiguous: z.array(extractedSchema(z.string()))` — an
 * array of envelopes, not a nested object — which makes `isGroupObject` return
 * false and collapses the split to one entry.
 *
 * So instead of `perGroupExtractor` on the combined schema, we use
 * `singleShotExtractor` on each of the four parts in parallel.  This mirrors
 * what the existing baseline did (4 routed calls, parallel) and uses Ribo's
 * actual extractor code — the trust boundary, the prompt assembly, the
 * finish-reason check and the zod parse all run.
 */
export function buildPartTargets() {
  const targets = {};
  for (const part of MANUAL_J_PARTS) {
    const patchSchema = jsonSchemaToZod(PARTS[part].schema);
    const extractionSchema = enveloped(patchSchema);
    targets[part] = {
      name: `manual-j-${part}`,
      extractionSchema,
      instructions: PARTS[part].system,
      examples: [],
    };
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Leaf counting and enumeration
// ---------------------------------------------------------------------------

export function countLeaves(node) {
  if (node.type === "string") return 1;
  if (node.type === "object") {
    return Object.values(node.properties || {}).reduce((s, v) => s + countLeaves(v), 0);
  }
  if (node.type === "array") return countLeaves(node.items);
  return 0;
}

export function totalLeaves() {
  return MANUAL_J_PARTS.reduce((s, p) => s + countLeaves(PARTS[p].schema), 0);
}

export function leavesPerPart() {
  const counts = {};
  for (const p of MANUAL_J_PARTS) counts[p] = countLeaves(PARTS[p].schema);
  return counts;
}

// ---------------------------------------------------------------------------
// Flatten the enveloped output into dotted leaf paths for scoring
// ---------------------------------------------------------------------------

export function flattenLeaves(obj, prefix = "", out = []) {
  if (obj === null || typeof obj !== "object") return out;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      flattenLeaves(obj[i], `${prefix}[${i}]`, out);
    }
    return out;
  }
  // Is this a provenance envelope? Check for the three keys.
  const keys = Object.keys(obj);
  if (
    keys.length === 3 &&
    keys.includes("value") &&
    keys.includes("confidence") &&
    keys.includes("sourceSpan")
  ) {
    out.push({
      path: prefix,
      value: obj.value,
      confidence: obj.confidence,
      sourceSpan: obj.sourceSpan,
    });
    return out;
  }
  for (const k of keys) {
    flattenLeaves(obj[k], prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Combined system prompt for the Mistral annotation prompt
// ---------------------------------------------------------------------------

export function mistralAnnotationPrompt() {
  return (
    MANUAL_J_PARTS.map((p) => PARTS[p].system).join("\n\n---\n\n") +
    "\n\n---\n\n" +
    "For every field, provide:\n" +
    "- value: the verbatim value from the document, or null if not stated\n" +
    "- confidence: your confidence score (0.0 to 1.0)\n" +
    "- sourceSpan: the EXACT verbatim quote from the document text that justifies this value, or null if the value is null\n" +
    "Never invent a sourceSpan. If you cannot find the exact text, set sourceSpan to null."
  );
}

export { MANUAL_J_PARTS, PARTS };
