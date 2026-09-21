import { SchemaParseError } from "@azx/ribo-core";
import { expect, test } from "vitest";

import type { ShapeMapping } from "./shape-mapping.js";
import { reverseShapedFields } from "./shape-reverse.js";

/**
 * @file The structural failures reversal owes a recognisable class for. Both
 * throws here are failures of the extraction DATA against the schema the
 * mapping was built against — the same class `parseWithSchema` signals at the
 * trust boundary, so an extractor ladder can fall through on them instead of
 * treating them as opaque. `reverseShapedFields` is a public export that takes
 * any mapping, so these are reachable without a construction check.
 */

test("a bare value where a leaf envelope is expected is a SchemaParseError naming the path", () => {
  const mapping: ShapeMapping = {
    leaves: { "g.f1": { source: "g.f1" } },
    provenance: {},
  };
  const data = { g: { f1: "plain, not an envelope" } };
  expect(() => reverseShapedFields(data, mapping)).toThrowError(SchemaParseError);
  expect(() => reverseShapedFields(data, mapping)).toThrow(/at "g\.f1"/);
});

test("a doubled patch write is a SchemaParseError naming the patch position", () => {
  // Two entries naming one source is not bijective; `reverseShapedFields` runs
  // without a construction check, so the collision surfaces at the write.
  const mapping: ShapeMapping = {
    leaves: { "g.a": { source: "g.x" }, "g.b": { source: "g.x" } },
    provenance: { g: "none" },
  };
  const data = { g: { a: "va", b: "vb" } };
  expect(() => reverseShapedFields(data, mapping)).toThrowError(SchemaParseError);
  expect(() => reverseShapedFields(data, mapping)).toThrow(/patch position "g\.x"/);
});

test("the envelope-mismatch path is instance style under a collection group", () => {
  const mapping: ShapeMapping = {
    leaves: { "g.arr.f1": { source: "g.arr.f1" } },
    provenance: {},
  };
  // A hand-written fixture whose second element's leaf is not an envelope.
  const data = {
    g: {
      arr: [{ f1: { value: "a", confidence: 1, sourceSpan: "a" } }, { f1: "not an envelope" }],
    },
  };
  expect(() => reverseShapedFields(data, mapping)).toThrowError(SchemaParseError);
  expect(() => reverseShapedFields(data, mapping)).toThrow(/at "g\.arr\[1\]\.f1"/);
});
