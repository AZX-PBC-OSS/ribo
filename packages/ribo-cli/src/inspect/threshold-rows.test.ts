import { expect, test } from "vitest";

import type { PlannedPackedCallRow } from "./planned.js";
import { ThresholdRowSchema } from "./report-schema.js";
import { buildThresholdRows } from "./threshold-rows.js";

const plannedCall = (overrides: Partial<PlannedPackedCallRow> = {}): PlannedPackedCallRow => ({
  semantic: "Home details",
  key: "home",
  requestName: "ribo-inspect-0-home",
  paths: ["home.address"],
  callIndex: 1,
  callCount: 1,
  nullableUnions: 2,
  serializedChars: 120,
  depth: 4,
  ...overrides,
});

test("v4 threshold rows require layout on both measures", () => {
  const base = { limit: 100, measured: 50, breached: false };
  expect(ThresholdRowSchema.safeParse({ ...base, measure: "pieceChars" }).success).toBe(false);
  expect(ThresholdRowSchema.safeParse({ ...base, measure: "depth" }).success).toBe(false);
  expect(
    ThresholdRowSchema.safeParse({ ...base, measure: "pieceChars", layout: "rule-based" }).success,
  ).toBe(true);
  expect(
    ThresholdRowSchema.safeParse({ ...base, measure: "depth", layout: "shared" }).success,
  ).toBe(true);
});

test("depth is always shared and omits piece; pieceChars names a concrete layout", () => {
  const base = { limit: 100, measured: 50, breached: false };
  for (const layout of ["rule-based", "planned"] as const) {
    expect(ThresholdRowSchema.safeParse({ ...base, measure: "depth", layout }).success).toBe(false);
  }
  expect(
    ThresholdRowSchema.safeParse({
      ...base,
      measure: "depth",
      layout: "shared",
      piece: "home",
    }).success,
  ).toBe(false);
  expect(
    ThresholdRowSchema.safeParse({ ...base, measure: "pieceChars", layout: "shared" }).success,
  ).toBe(false);
});

test("rule-based labels retain key and key-part names and carry the rule-based layout", () => {
  const unsplit = buildThresholdRows({
    maxPieceChars: 100,
    depth: null,
    ruleBased: { key: "home", serializedChars: 120 },
  });
  const split = buildThresholdRows({
    maxPieceChars: 100,
    depth: null,
    ruleBased: { key: "home", part: 0, serializedChars: 120 },
  });

  expect(unsplit).toEqual([
    {
      measure: "pieceChars",
      layout: "rule-based",
      limit: 100,
      measured: 120,
      breached: true,
      piece: "home",
    },
  ]);
  expect(split[0]?.piece).toBe("home-0");
});

test("planned labels use the semantic name unsplit and a one-based call split label", () => {
  const unsplit = buildThresholdRows({
    maxPieceChars: 100,
    depth: null,
    ruleBased: { key: "rule-based-must-not-win", serializedChars: 500 },
    planned: plannedCall(),
  });
  const split = buildThresholdRows({
    maxPieceChars: 100,
    depth: null,
    planned: plannedCall({
      requestName: "ribo-inspect-0-home-1",
      callIndex: 2,
      callCount: 3,
      serializedChars: 140,
    }),
  });

  expect(unsplit[0]).toMatchObject({
    layout: "planned",
    measured: 120,
    breached: true,
    piece: "Home details",
  });
  expect(split[0]).toMatchObject({
    layout: "planned",
    measured: 140,
    piece: "Home details — call 2 of 3",
  });
});

test("depth is emitted once as shared beside a planned piece threshold", () => {
  const rows = buildThresholdRows({
    maxDepth: 3,
    maxPieceChars: 100,
    depth: 5,
    ruleBased: { key: "home", serializedChars: 500 },
    planned: plannedCall(),
  });
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({
    measure: "depth",
    layout: "shared",
    limit: 3,
    measured: 5,
    breached: true,
  });
  expect(rows[0]).not.toHaveProperty("piece");
  expect(rows[1]).toMatchObject({ layout: "planned", measured: 120, breached: true });
});
