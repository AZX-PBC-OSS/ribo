import { enveloped } from "@azx/ribo-core";
import { snuggExtractionSchema } from "@azx/ribo-adapter-snuggpro";
import { z } from "zod";
import { expect, test } from "vitest";

import { inspectSchema } from "./index.js";

/**
 * @file The leaf count counts SCHEMA FIELDS, not provenance-envelope members.
 * An enveloped extraction schema carries every field as a
 * `{ value, confidence, sourceSpan }` envelope — the envelope is one field,
 * the very identification core's own group walk uses (`splitExtractionSchema`
 * and the adapter's `split-schema.test.ts` both count envelopes, and the
 * adapter pins the Snugg field count at 441). Walking the envelope's members
 * as leaves inflates the count exactly 3x and drags `guidanceCoverage` and
 * `reformatFindings` — everything built from the same inventory — down with
 * it: on the real Snugg schema the report read 1323 leaves, 441 of 1323
 * (33%) described, and finding paths suffixed `.value`, while every field was
 * described.
 *
 * Both tests run the document path the command actually takes: a zod schema
 * rendered to an OpenAPI-3.0 JSON Schema document, re-read by `inspectSchema`'s
 * own conversion. The expected counts come from core's own notion of a leaf on
 * an enveloped schema — the envelope key set `{ value, confidence, sourceSpan }`
 * — never from a second count implementation asserted against itself.
 */

const ENVELOPE_KEYS = new Set(["value", "confidence", "sourceSpan"]);

/** `shape[key]` for a key from the shape's own keys — a bare shape indexes to
 * `any`, so the test narrows once here (the move core's `fieldAt` makes). */
const fieldAt = (shape: z.ZodObject["shape"], key: string): z.ZodType => shape[key] as z.ZodType;

/** The dotted paths to every envelope — every `{ value, confidence, sourceSpan }`
 * leaf — over a zod schema. The same identification the adapter's
 * `split-schema.test.ts` pins its field count with. */
function enumerateEnvelopes(schema: z.ZodType, prefix = ""): string[] {
  if (schema instanceof z.ZodArray) {
    return enumerateEnvelopes(schema.element as unknown as z.ZodType, prefix);
  }
  if (!(schema instanceof z.ZodObject)) return [];
  const shape = schema.shape;
  const keys = Object.keys(shape);
  if (keys.length === 3 && keys.every((k) => ENVELOPE_KEYS.has(k))) {
    return prefix ? [prefix] : [];
  }
  const leaves: string[] = [];
  for (const key of keys) {
    const child = fieldAt(shape, key);
    leaves.push(...enumerateEnvelopes(child, prefix ? `${prefix}.${key}` : key));
  }
  return leaves;
}

/** Render a zod schema to the OpenAPI-3.0 document form the command takes. */
const toDocument = (schema: z.ZodType): Parameters<typeof z.fromJSONSchema>[0] =>
  z.toJSONSchema(schema, { target: "openapi-3.0" });

/** Derive the enveloped extraction schema from a patch document, the way the
 * pipeline does, and render it to the OpenAPI-3.0 document form the command
 * takes. */
const envelopedDocument = (patch: object): unknown =>
  toDocument(
    enveloped(
      z.fromJSONSchema(patch as Parameters<typeof z.fromJSONSchema>[0], {
        defaultTarget: "openapi-3.0",
      }) as z.ZodObject,
    ),
  );

// A three-field patch schema, every field described, one asking for
// reformatting — small enough that the right answer is visible by eye.
const threeFields = {
  type: "object",
  description: "Home overview",
  properties: {
    home: {
      type: "object",
      description: "Home",
      properties: {
        address: { type: "string", description: "Street address" },
        yearBuilt: { type: "number", description: "Year built" },
      },
      required: ["address", "yearBuilt"],
    },
    notes: { type: "string", description: "Freeform notes; normalize to lowercase" },
  },
  required: ["home", "notes"],
};

test("a three-field enveloped schema reports three leaves and full coverage", () => {
  const document = envelopedDocument(threeFields);
  const report = inspectSchema(document);

  expect(report.leafCount).toBe(3);
  expect(report.guidanceCoverage).toEqual({ described: 3, total: 3, ratio: 1 });
});

test("a reformat finding's path names the field, not the envelope's value member", () => {
  const document = envelopedDocument(threeFields);
  const report = inspectSchema(document);

  expect(report.reformatFindings.map((finding) => finding.path)).toEqual(["notes"]);
});

test("on the real Snugg schema the leaf count is the field count the adapter pins", () => {
  const document = toDocument(snuggExtractionSchema);
  const fieldCount = enumerateEnvelopes(
    z.fromJSONSchema(document, { defaultTarget: "openapi-3.0" }),
  ).length;

  // The adapter's split-schema test pins this same count at 441; the pin here
  // is the agreement, so a schema change re-pins both files together.
  expect(fieldCount).toBe(441);

  const report = inspectSchema(document);
  expect(report.leafCount).toBe(fieldCount);
  // Every Snugg field's value carries a description, so coverage is full.
  expect(report.guidanceCoverage).toEqual({
    described: fieldCount,
    total: fieldCount,
    ratio: 1,
  });
  for (const finding of report.reformatFindings) {
    expect(finding.path.endsWith(".value")).toBe(false);
  }
});
