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

test("crossing a collection the patch path has passed is a SchemaParseError naming the collection", () => {
  // Reachable only when `reverseShapedFields` runs without an `assertShapeMapping`
  // pass — `assertShapeMapping` refuses the entry (item 1's check refuses an
  // entry whose two sides run under different array-depth patterns). The error
  // type is what an extractor ladder can recognise and fall through on, and
  // the path names where the data stopped matching the schema.
  //
  // Source is just the top-level key (no rest). Extraction rest crosses `arr`
  // first. `patchKey` is undefined at the array; the throw fires.
  const mapping: ShapeMapping = {
    leaves: { "g.arr.X": { source: "g" } },
    provenance: { g: "leaf" },
  };
  const data = {
    g: {
      arr: [{ X: { value: "a", confidence: 1, sourceSpan: "a" } }],
    },
  };
  expect(() => reverseShapedFields(data, mapping)).toThrowError(SchemaParseError);
  expect(() => reverseShapedFields(data, mapping)).toThrow(/at "g\.arr"/);
});

test("the collection-crossing throw keeps the offending path under a row-provenance group", () => {
  // The same shape of failure under row provenance: instance-style path,
  // row span written for the row first. The throw fires before the row span
  // write is committed — but a malformed mapping can still reach this.
  const mapping: ShapeMapping = {
    leaves: { "g.arr.X": { source: "g" } },
    provenance: { g: "row" },
  };
  const data = {
    g: {
      arr: [{ X: "a" }],
    },
  };
  expect(() => reverseShapedFields(data, mapping)).toThrowError(SchemaParseError);
  expect(() => reverseShapedFields(data, mapping)).toThrow(/g\.arr/);
});

test("a nested leaf's envelope lands at its original top-level patch path, verbatim", () => {
  // The nest case: the extraction leaf lives under a synthetic group, the
  // patch leaf at the top level. Reversal roots the patch-side write at the
  // SOURCE's top-level key, not the extraction path's — and carries the whole
  // envelope, not just the value.
  const mapping: ShapeMapping = {
    leaves: { "construction.yearBuilt": { source: "yearBuilt" } },
    provenance: {},
  };
  const data = {
    construction: {
      yearBuilt: { value: "1972", confidence: 0.9, sourceSpan: "built in seventy-two" },
    },
  };
  const reversed = reverseShapedFields(data, mapping);
  expect(reversed.yearBuilt).toEqual({
    value: "1972",
    confidence: 0.9,
    sourceSpan: "built in seventy-two",
  });
  // Nothing is written under the synthetic group — it exists only in the
  // extraction space.
  expect(reversed).not.toHaveProperty("construction");
});
