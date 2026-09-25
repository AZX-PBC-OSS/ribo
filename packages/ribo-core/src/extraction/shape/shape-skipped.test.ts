import type { SkippedItem } from "../extractor.js";
import { expect, test } from "vitest";

import type { ShapeMapping } from "./shape-mapping.js";
import { reverseSkippedItems } from "./shape-skipped.js";

// A regroup inside `basedata`, a collection passed through, and a nest group
// `construction` holding two top-level patch leaves.
const mapping: ShapeMapping = {
  leaves: {
    "basedata.occupancy.numberOfOccupants": { source: "basedata.numberOfOccupants" },
    "basedata.conditionedArea": { source: "basedata.conditionedArea" },
    "hvac.fuel": { source: "hvac.fuel" },
    "construction.yearBuilt": { source: "yearBuilt" },
    "construction.foundation": { source: "foundationType" },
    heatingType: { source: "heatingType" },
  },
  provenance: {},
};

test("a group both spaces share keeps its key and coordinates", () => {
  const item: SkippedItem = {
    phaseId: "fill",
    key: "hvac",
    instance: 2,
    instances: 3,
    part: 1,
    parts: 1,
  };
  expect(reverseSkippedItems([item], mapping)).toEqual([item]);
});

test("a leaf a regroup moved is re-pathed to where the patch keeps it", () => {
  const item: SkippedItem = {
    phaseId: "classify",
    key: "basedata",
    leaf: "occupancy.numberOfOccupants",
  };
  expect(reverseSkippedItems([item], mapping)).toEqual([
    { phaseId: "classify", key: "basedata", leaf: "numberOfOccupants" },
  ]);
});

test("a leaf that names no mapped leaf widens to its group rather than naming a path the patch lacks", () => {
  const item: SkippedItem = { phaseId: "classify", key: "basedata", leaf: "occupancy" };
  expect(reverseSkippedItems([item], mapping)).toEqual([{ phaseId: "classify", key: "basedata" }]);
});

test("a nest group fans out to every patch key it feeds, without the nest group's coordinates", () => {
  const item: SkippedItem = {
    phaseId: "fill",
    key: "construction",
    instance: 1,
    instances: 1,
    part: 2,
    parts: 2,
  };
  expect(reverseSkippedItems([item], mapping)).toEqual([
    { phaseId: "fill", key: "yearBuilt" },
    { phaseId: "fill", key: "foundationType" },
  ]);
});

test("a nest-group leaf narrows to the one patch key it came from", () => {
  const item: SkippedItem = { phaseId: "classify", key: "construction", leaf: "foundation" };
  expect(reverseSkippedItems([item], mapping)).toEqual([
    { phaseId: "classify", key: "foundationType" },
  ]);
});

test("two pieces of one nest group do not name its patch keys twice", () => {
  const pieces: SkippedItem[] = [
    { phaseId: "fill", key: "construction", part: 1, parts: 2 },
    { phaseId: "fill", key: "construction", part: 2, parts: 2 },
  ];
  expect(reverseSkippedItems(pieces, mapping)).toEqual([
    { phaseId: "fill", key: "yearBuilt" },
    { phaseId: "fill", key: "foundationType" },
  ]);
});

test("the whole-document key passes through — it means the same in both spaces", () => {
  const item: SkippedItem = { phaseId: "gap-fill", key: "" };
  expect(reverseSkippedItems([item], mapping)).toEqual([item]);
});
